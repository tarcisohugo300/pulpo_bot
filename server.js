/**
 * server.js — Pulpo OTP Server v3 (Baileys — sin Puppeteer)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dual-channel OTP: WhatsApp (Baileys) + SMS (Africa's Talking)
 *
 * ENDPOINTS:
 *   GET  /api/qr             — Página web con QR para vincular WhatsApp
 *   POST /api/enviar-otp     — Genera código y envía por canal elegido
 *   POST /api/verificar-otp  — Verifica el código y devuelve Firebase Custom Token
 *   GET  /api/status         — Estado de ambos canales
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const P       = require('pino');

// ── Baileys ──────────────────────────────────────────────────────────────────
let makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore;
let Boom;

async function loadBaileys() {
    const baileys = await import('@whiskeysockets/baileys');
    const boomPkg = await import('@hapi/boom');
    makeWASocket               = baileys.default;
    useMultiFileAuthState      = baileys.useMultiFileAuthState;
    DisconnectReason           = baileys.DisconnectReason;
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    Boom = boomPkg.Boom;
}

// ── Firebase Admin ────────────────────────────────────────────────────────────
let adminAuth = null;
try {
    const admin = require('firebase-admin');

    // Primero intenta desde variable de entorno (Render), luego desde archivo (local)
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        credential = admin.credential.cert(sa);
    } else {
        const sa = require('./serviceAccount.json');
        credential = admin.credential.cert(sa);
    }

    admin.initializeApp({ credential });
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

// ── OTP Store ─────────────────────────────────────────────────────────────────
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
    if (!entry)                          return { ok: false, motivo: 'No existe código. Solicita uno nuevo.' };
    if (Date.now() > entry.expira)       return { ok: false, motivo: 'Código expirado. Solicita uno nuevo.' };
    if (entry.intentos >= OTP_MAX_TRIES) return { ok: false, motivo: 'Demasiados intentos. Solicita un nuevo código.' };
    entry.intentos++;
    if (entry.codigo !== codigoIngresado)
        return { ok: false, motivo: `Código incorrecto. Intentos restantes: ${OTP_MAX_TRIES - entry.intentos}` };
    otpStore.delete(telefono);
    return { ok: true };
}
setInterval(() => {
    const ahora = Date.now();
    for (const [tel, entry] of otpStore.entries())
        if (ahora > entry.expira) otpStore.delete(tel);
}, 5 * 60 * 1000);

// ── WhatsApp via Baileys ──────────────────────────────────────────────────────
let waSocket = null;
let waListo  = false;
let qrActual = null;   // último QR recibido (como URL de imagen)

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('wa_session');
    const logger = P({ level: 'silent' });

    waSocket = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: ['Pulpo OTP', 'Chrome', '120.0.0'],
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000,
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR recibido → convertir a URL de imagen para mostrarlo en el navegador
        if (qr) {
            qrActual = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
            console.log('📱 Nuevo QR disponible → visita /api/qr para escanearlo');
        }

        if (connection === 'open') {
            waListo  = true;
            qrActual = null;
            console.log('✅ WhatsApp conectado y listo');
        }

        if (connection === 'close') {
            waListo = false;
            const code = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output?.statusCode
                : undefined;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.warn(`⚠️  WhatsApp desconectado (código ${code}). Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(conectarWhatsApp, 3000);
            else console.error('❌ Sesión cerrada. Visita /api/qr para vincular de nuevo.');
        }
    });
}

async function enviarWhatsApp(telefono, codigo) {
    if (!waListo || !waSocket) throw new Error('WhatsApp no está listo. Visita /api/qr para vincular.');
    const jid    = telefono.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const mensaje =
        `🐙 *PULPO*\n\n` +
        `Tu código de verificación es: *${codigo}*\n\n` +
        `⏱️ Válido por 10 minutos.\n` +
        `_No compartas este código con nadie._`;
    await waSocket.sendMessage(jid, { text: mensaje });
}

async function enviarSms(telefono, codigo) {
    if (!atSms) throw new Error("Africa's Talking no configurado.");
    await atSms.send({
        to: [telefono],
        message: `PULPO: Tu codigo es ${codigo}. Valido 10 min. No lo compartas.`,
        from: process.env.AT_SENDER_ID || 'PULPO',
    });
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// GET /api/qr — página web para escanear el QR de WhatsApp
app.get('/api/qr', (_req, res) => {
    if (waListo) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fff0">
                <h2 style="color:green">✅ WhatsApp ya está conectado</h2>
                <p>No necesitas escanear nada.</p>
                <a href="/api/status">Ver estado completo</a>
            </body></html>
        `);
    }
    if (!qrActual) {
        return res.send(`
            <html>
            <head><meta http-equiv="refresh" content="5"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#fffbe6">
                <h2>⏳ Generando QR...</h2>
                <p>Esta página se actualiza sola cada 5 segundos.</p>
            </body></html>
        `);
    }
    res.send(`
        <html>
        <head><meta http-equiv="refresh" content="30"></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
            <h2>📱 Escanea este QR con WhatsApp</h2>
            <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
            <img src="${qrActual}" style="border:4px solid #333;border-radius:8px;margin:20px"/>
            <p style="color:gray;font-size:13px">El QR expira en ~60 seg. La página se recarga automáticamente.</p>
        </body></html>
    `);
});

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
        return res.status(503).json({ error: 'No se pudo enviar por ningún canal.', detalles: errores });
    }

    console.log(`🚀 OTP [${codigo}] → ${telefono} vía: ${canalesUsados.join(', ')}`);
    res.status(200).json({ success: true, canalesUsados,
        advertencias: Object.keys(errores).length > 0 ? errores : undefined });
});

// POST /api/verificar-otp
app.post('/api/verificar-otp', async (req, res) => {
    const { telefono, codigo } = req.body;
    if (!telefono || !codigo) return res.status(400).json({ error: 'Faltan campos' });

    const resultado = verificarOtpStore(telefono, codigo);
    if (!resultado.ok) return res.status(401).json({ error: resultado.motivo });

    console.log(`✅ OTP verificado para ${telefono}`);

    if (adminAuth) {
        try {
            const uid         = 'pulpo_' + telefono.replace(/[^0-9]/g, '');
            const customToken = await adminAuth.createCustomToken(uid, { telefono, auth_method: 'pulpo_otp' });
            return res.status(200).json({ success: true, customToken, uid });
        } catch (e) {
            return res.status(500).json({ error: 'Token falló: ' + e.message });
        }
    }
    res.status(200).json({ success: true });
});

// GET /api/status
app.get('/api/status', (_req, res) => {
    res.json({
        servidor: 'ok',
        timestamp: new Date().toISOString(),
        whatsapp: waListo ? 'conectado' : (qrActual ? 'esperando QR' : 'conectando...'),
        qr_disponible: !!qrActual,
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
        console.log(`   QR:     https://tu-app.onrender.com/api/qr`);
        console.log(`   Estado: https://tu-app.onrender.com/api/status\n`);
    });
})();
