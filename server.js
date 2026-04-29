/**
 * server.js — Pulpo OTP Server v3 (Baileys — sin Puppeteer)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dual-channel OTP: WhatsApp (Baileys, ~50MB RAM) + SMS (Africa's Talking)
 *
 * ENDPOINTS:
 *   POST /api/enviar-otp     — Genera código y envía por canal elegido
 *   POST /api/verificar-otp  — Verifica el código y devuelve Firebase Custom Token
 *   GET  /api/status         — Estado de ambos canales
 *
 * CANALES disponibles en /api/enviar-otp:
 *   "whatsapp"  — Solo WhatsApp
 *   "sms"       — Solo SMS vía Africa's Talking
 *   "ambos"     — Envía por los dos canales simultáneamente (default)
 *
 * SETUP:
 *   1. npm install (ver package.json actualizado)
 *   2. node server.js
 *   3. Escanea el QR en consola la primera vez (solo una vez — la sesión persiste)
 *
 * MIGRACIÓN DESDE whatsapp-web.js:
 *   - Eliminado: puppeteer, whatsapp-web.js, qrcode-terminal (~500MB RAM menos)
 *   - Añadido: @whiskeysockets/baileys, qrcode (display en terminal)
 *   - Todo lo demás (OTP store, Africa's Talking, Firebase) queda igual
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const P          = require('pino');

// ── Baileys (import dinámico porque es ESM) ──────────────────────────────────
let makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore;
let Boom;

async function loadBaileys() {
    const baileys  = await import('@whiskeysockets/baileys');
    const boomPkg  = await import('@hapi/boom');
    makeWASocket               = baileys.default;
    useMultiFileAuthState      = baileys.useMultiFileAuthState;
    DisconnectReason           = baileys.DisconnectReason;
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    Boom = boomPkg.Boom;
}

// ── Firebase Admin ────────────────────────────────────────────────────────────
let adminAuth = null;
try {
    const admin          = require('firebase-admin');
    const serviceAccount = require('./serviceAccount.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    adminAuth = admin.auth();
    console.log('🔥 Firebase Admin conectado');
} catch (e) {
    console.warn('⚠️  Firebase Admin no disponible:', e.message);
}

// ── Africa's Talking ──────────────────────────────────────────────────────────
const AfricasTalking = require('africastalking');
const AT_USERNAME    = process.env.AT_USERNAME || 'sandbox';
const AT_API_KEY     = process.env.AT_API_KEY  || '';

let atSms = null;
if (AT_API_KEY) {
    const at = AfricasTalking({ apiKey: AT_API_KEY, username: AT_USERNAME });
    atSms = at.SMS;
    console.log(`📱 Africa's Talking listo (username: ${AT_USERNAME})`);
} else {
    console.warn("⚠️  Africa's Talking: falta AT_API_KEY — canal SMS deshabilitado");
}

// ── OTP Store (en memoria, con expiración) ────────────────────────────────────
const otpStore      = new Map();
const OTP_TTL_MS    = 10 * 60 * 1000;
const OTP_MAX_TRIES = 5;

function generarCodigo() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function guardarOtp(telefono, codigo) {
    otpStore.set(telefono, { codigo, expira: Date.now() + OTP_TTL_MS, intentos: 0 });
}

function verificarOtpStore(telefono, codigoIngresado) {
    const entry = otpStore.get(telefono);
    if (!entry)                          return { ok: false, motivo: 'No existe código para este número. Solicita uno nuevo.' };
    if (Date.now() > entry.expira)       return { ok: false, motivo: 'Código expirado. Solicita uno nuevo.' };
    if (entry.intentos >= OTP_MAX_TRIES) return { ok: false, motivo: 'Demasiados intentos. Solicita un nuevo código.' };
    entry.intentos++;
    if (entry.codigo !== codigoIngresado) {
        return { ok: false, motivo: `Código incorrecto. Intentos restantes: ${OTP_MAX_TRIES - entry.intentos}` };
    }
    otpStore.delete(telefono);
    return { ok: true };
}

setInterval(() => {
    const ahora = Date.now();
    for (const [tel, entry] of otpStore.entries()) {
        if (ahora > entry.expira) otpStore.delete(tel);
    }
}, 5 * 60 * 1000);

// ── WhatsApp via Baileys ──────────────────────────────────────────────────────
let waSocket  = null;
let waListo   = false;

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('wa_session');

    const logger = P({ level: 'silent' }); // silencia logs internos de Baileys

    waSocket = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: true,   // imprime QR en la terminal automáticamente
        logger,
        browser: ['Pulpo OTP', 'Chrome', '120.0.0'],
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000,
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            waListo = true;
            console.log('✅ WhatsApp conectado y listo');
        }

        if (connection === 'close') {
            waListo = false;
            const code = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output?.statusCode
                : undefined;

            const shouldReconnect = code !== DisconnectReason.loggedOut;

            console.warn(`⚠️  WhatsApp desconectado (código ${code}). Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(conectarWhatsApp, 3000);
            } else {
                console.error('❌ Sesión cerrada. Borra la carpeta wa_session/ y reinicia para escanear de nuevo.');
            }
        }
    });
}

async function enviarWhatsApp(telefono, codigo) {
    if (!waListo || !waSocket) throw new Error('WhatsApp no está listo. Escanea el QR en los logs.');
    const jid     = telefono.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const mensaje  =
        `🐙 *PULPO*\n\n` +
        `Tu código de verificación es: *${codigo}*\n\n` +
        `⏱️ Válido por 10 minutos.\n` +
        `_No compartas este código con nadie._`;
    await waSocket.sendMessage(jid, { text: mensaje });
}

async function enviarSms(telefono, codigo) {
    if (!atSms) throw new Error("Africa's Talking no está configurado. Verifica AT_API_KEY en .env");
    await atSms.send({
        to: [telefono],
        message: `PULPO: Tu codigo es ${codigo}. Valido 10 min. No lo compartas.`,
        from: process.env.AT_SENDER_ID || 'PULPO',
    });
}

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// POST /api/enviar-otp
app.post('/api/enviar-otp', async (req, res) => {
    const { telefono, canal = 'ambos' } = req.body;
    if (!telefono) return res.status(400).json({ error: 'Falta el campo telefono' });

    const codigo = generarCodigo();
    guardarOtp(telefono, codigo);

    const canalesUsados = [];
    const errores       = {};
    const tareas        = [];

    if (canal === 'whatsapp' || canal === 'ambos') {
        tareas.push(
            enviarWhatsApp(telefono, codigo)
                .then(() => canalesUsados.push('whatsapp'))
                .catch((e) => { errores.whatsapp = e.message; })
        );
    }
    if (canal === 'sms' || canal === 'ambos') {
        tareas.push(
            enviarSms(telefono, codigo)
                .then(() => canalesUsados.push('sms'))
                .catch((e) => { errores.sms = e.message; })
        );
    }

    await Promise.allSettled(tareas);

    if (canalesUsados.length === 0) {
        otpStore.delete(telefono);
        console.error(`❌ OTP fallido para ${telefono}:`, errores);
        return res.status(503).json({ error: 'No se pudo enviar el código por ningún canal.', detalles: errores });
    }

    console.log(`🚀 OTP [${codigo}] → ${telefono} vía: ${canalesUsados.join(', ')}`);
    res.status(200).json({
        success: true,
        canalesUsados,
        advertencias: Object.keys(errores).length > 0 ? errores : undefined,
    });
});

// POST /api/verificar-otp
app.post('/api/verificar-otp', async (req, res) => {
    const { telefono, codigo } = req.body;
    if (!telefono || !codigo) return res.status(400).json({ error: 'Faltan campos telefono o codigo' });

    const resultado = verificarOtpStore(telefono, codigo);
    if (!resultado.ok) {
        console.warn(`⚠️  OTP inválido para ${telefono}: ${resultado.motivo}`);
        return res.status(401).json({ error: resultado.motivo });
    }

    console.log(`✅ OTP verificado para ${telefono}`);

    if (adminAuth) {
        try {
            const uid         = 'pulpo_' + telefono.replace(/[^0-9]/g, '');
            const customToken = await adminAuth.createCustomToken(uid, { telefono, auth_method: 'pulpo_otp' });
            return res.status(200).json({ success: true, customToken, uid });
        } catch (e) {
            console.error('❌ Error generando Custom Token:', e.message);
            return res.status(500).json({ error: 'Código correcto pero falló la generación del token: ' + e.message });
        }
    }

    res.status(200).json({ success: true });
});

// GET /api/status
app.get('/api/status', (_req, res) => {
    res.json({
        servidor: 'ok',
        timestamp: new Date().toISOString(),
        whatsapp: waListo ? 'conectado' : 'desconectado',
        sms_africastalking: atSms ? `listo (${AT_USERNAME})` : 'no configurado',
        firebase_admin: adminAuth ? 'listo' : 'no disponible',
        otp_pendientes: otpStore.size,
    });
});

// ── Arranque ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
    await loadBaileys();
    await conectarWhatsApp();

    app.listen(PORT, () => {
        console.log(`\n🐙 Servidor Pulpo OTP v3 activo en puerto ${PORT}`);
        console.log(`   Estado: http://localhost:${PORT}/api/status\n`);
    });
})();
