/**
 * server.js — Pulpo OTP Server v3 (Baileys)
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const P       = require('pino');

// ── Baileys ──────────────────────────────────────────────────────────────────
let makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, Boom;

async function loadBaileys() {
    const baileys = await import('@whiskeysockets/baileys');
    const boomPkg = await import('@hapi/boom');
    makeWASocket               = baileys.default;
    useMultiFileAuthState      = baileys.useMultiFileAuthState;
    DisconnectReason           = baileys.DisconnectReason;
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    Boom                       = boomPkg.Boom;
}

// ── Firebase Admin ────────────────────────────────────────────────────────────
let adminAuth = null;
try {
    const admin = require('firebase-admin');
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    } else {
        credential = admin.credential.cert(require('./serviceAccount.json'));
    }
    admin.initializeApp({ credential });
    adminAuth = admin.auth();
    console.log('🔥 Firebase Admin conectado');
} catch (e) {
    console.warn('⚠️  Firebase Admin no disponible:', e.message);
}

// ── Africa's Talking ──────────────────────────────────────────────────────────
const AT_USERNAME = process.env.AT_USERNAME || 'sandbox';
const AT_API_KEY  = process.env.AT_API_KEY  || '';
let atSms = null;
if (AT_API_KEY) {
    const AfricasTalking = require('africastalking');
    const at = AfricasTalking({ apiKey: AT_API_KEY, username: AT_USERNAME });
    atSms = at.SMS;
    console.log(`📱 Africa's Talking listo (username: ${AT_USERNAME})`);
} else {
    console.warn("⚠️  AT_API_KEY falta — SMS deshabilitado");
}

// ── OTP Store ─────────────────────────────────────────────────────────────────
const otpStore      = new Map();
const OTP_TTL_MS    = 10 * 60 * 1000;
const OTP_MAX_TRIES = 5;

function generarCodigo() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function guardarOtp(tel, cod) { otpStore.set(tel, { codigo: cod, expira: Date.now() + OTP_TTL_MS, intentos: 0 }); }
function verificarOtpStore(tel, cod) {
    const e = otpStore.get(tel);
    if (!e)                         return { ok: false, motivo: 'No existe código. Solicita uno nuevo.' };
    if (Date.now() > e.expira)      return { ok: false, motivo: 'Código expirado.' };
    if (e.intentos >= OTP_MAX_TRIES) return { ok: false, motivo: 'Demasiados intentos.' };
    e.intentos++;
    if (e.codigo !== cod) return { ok: false, motivo: `Incorrecto. Restantes: ${OTP_MAX_TRIES - e.intentos}` };
    otpStore.delete(tel);
    return { ok: true };
}
setInterval(() => { const n = Date.now(); for (const [t, e] of otpStore) if (n > e.expira) otpStore.delete(t); }, 300_000);

// ── WhatsApp ──────────────────────────────────────────────────────────────────
let waSocket        = null;
let waListo         = false;
let pairingCode     = null;   // código de 8 letras para vincular sin QR
let pairingPending  = false;  // esperando que el usuario ingrese el código

function limpiarSesion() {
    try { fs.rmSync('wa_session', { recursive: true, force: true }); } catch (_) {}
    console.log('🗑️  Sesión limpiada');
}

async function conectarWhatsApp(telefono = null) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('wa_session');
        const logger = P({ level: 'silent' });

        if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }

        const yaRegistrado = !!state.creds.me;

        waSocket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            browser              : ['Ubuntu', 'Chrome', '120.0.0'],
            connectTimeoutMs     : 60_000,
            keepAliveIntervalMs  : 30_000,
            defaultQueryTimeoutMs: 60_000,
            syncFullHistory      : false,
            markOnlineOnConnect  : false,
        });

        waSocket.ev.on('creds.update', saveCreds);

        // Si no hay sesión guardada y se pasó un teléfono → pedir código de vinculación
        if (!yaRegistrado && telefono) {
            try {
                await new Promise(r => setTimeout(r, 3000)); // esperar handshake
                const numero = telefono.replace(/[^0-9]/g, '');
                pairingCode    = await waSocket.requestPairingCode(numero);
                pairingPending = true;
                console.log(`🔑 Código de vinculación: ${pairingCode}`);
            } catch (e) {
                console.error('❌ Error obteniendo código:', e.message);
            }
        }

        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                waListo        = true;
                pairingCode    = null;
                pairingPending = false;
                console.log('✅ WhatsApp conectado y listo');
            }

            if (connection === 'close') {
                waListo = false;
                const code = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode : undefined;
                console.warn(`⚠️  Desconectado (código ${code})`);

                if (code === DisconnectReason.loggedOut) {
                    limpiarSesion();
                    pairingCode    = null;
                    pairingPending = false;
                }
                setTimeout(() => conectarWhatsApp(), 8_000);
            }
        });

    } catch (err) {
        console.error('❌ Error iniciando WhatsApp:', err.message);
        setTimeout(() => conectarWhatsApp(), 10_000);
    }
}

async function enviarWhatsApp(telefono, codigo) {
    if (!waListo || !waSocket) throw new Error('WhatsApp no listo. Visita /api/qr');
    const jid = telefono.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await waSocket.sendMessage(jid, {
        text: `🐙 *PULPO*\n\nTu código: *${codigo}*\n\n⏱️ Válido 10 min.\n_No lo compartas._`
    });
}

async function enviarSms(telefono, codigo) {
    if (!atSms) throw new Error("Africa's Talking no configurado.");
    await atSms.send({ to: [telefono], message: `PULPO: Tu codigo es ${codigo}. Valido 10 min.`, from: process.env.AT_SENDER_ID || 'PULPO' });
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// GET /api/qr — panel de vinculación
app.get('/api/qr', (_req, res) => {
    const style = `font-family:sans-serif;text-align:center;padding:40px;max-width:500px;margin:0 auto`;

    if (waListo) {
        return res.send(`<html><body style="${style};background:#f0fff0">
            <h2 style="color:green">✅ WhatsApp conectado</h2>
            <p>El bot está activo.</p>
            <a href="/api/status">Ver estado completo</a>
        </body></html>`);
    }

    if (pairingPending && pairingCode) {
        return res.send(`<html>
        <head><meta http-equiv="refresh" content="10"></head>
        <body style="${style};background:#e8f5e9">
            <h2>🔑 Código de vinculación</h2>
            <div style="font-size:48px;font-weight:bold;letter-spacing:8px;color:#1b5e20;margin:20px 0;background:#fff;padding:20px;border-radius:12px;border:3px solid #4caf50">
                ${pairingCode}
            </div>
            <p><strong>Pasos:</strong></p>
            <ol style="text-align:left;display:inline-block">
                <li>Abre WhatsApp en tu teléfono</li>
                <li>Ve a <strong>Dispositivos vinculados</strong></li>
                <li>Toca <strong>Vincular con número de teléfono</strong></li>
                <li>Ingresa el código de arriba</li>
            </ol>
            <p style="color:gray;font-size:13px">Esta página se recarga sola. El código expira en ~60 seg.</p>
        </body></html>`);
    }

    // Sin sesión y sin código → mostrar formulario para pedir teléfono
    res.send(`<html><body style="${style};background:#f5f5f5">
        <h2>📱 Vincular WhatsApp</h2>
        <p>Ingresa el número de teléfono del WhatsApp que usará el bot<br>
        <small style="color:gray">(con código de país, sin espacios ni +)</small></p>
        <form method="POST" action="/api/pair">
            <input name="telefono" placeholder="258841234567" required
                style="padding:12px;font-size:18px;width:260px;border-radius:8px;border:2px solid #333;text-align:center"/>
            <br><br>
            <button type="submit"
                style="background:#1976d2;color:white;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer">
                Obtener código →
            </button>
        </form>
        <br>
        <form method="POST" action="/api/reset-wa">
            <button type="submit" style="background:#e53935;color:white;border:none;padding:8px 20px;border-radius:6px;font-size:13px;cursor:pointer">
                🗑️ Limpiar sesión y reiniciar
            </button>
        </form>
    </body></html>`);
});

// POST /api/pair — solicita código de vinculación por teléfono
app.post('/api/pair', async (req, res) => {
    const { telefono } = req.body;
    if (!telefono) return res.redirect('/api/qr');
    console.log(`🔑 Solicitando código para: ${telefono}`);
    pairingCode    = null;
    pairingPending = false;
    waListo        = false;
    if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }
    limpiarSesion();
    setTimeout(() => conectarWhatsApp(telefono), 1_000);
    res.redirect('/api/qr');
});

// POST /api/reset-wa
app.post('/api/reset-wa', async (_req, res) => {
    console.log('🔄 Reset manual');
    waListo = false; pairingCode = null; pairingPending = false;
    if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }
    limpiarSesion();
    setTimeout(() => conectarWhatsApp(), 1_000);
    res.redirect('/api/qr');
});

// POST /api/enviar-otp
app.post('/api/enviar-otp', async (req, res) => {
    const { telefono, canal = 'ambos' } = req.body;
    if (!telefono) return res.status(400).json({ error: 'Falta telefono' });

    const codigo = generarCodigo();
    guardarOtp(telefono, codigo);

    const canalesUsados = [], errores = {}, tareas = [];

    if (canal === 'whatsapp' || canal === 'ambos')
        tareas.push(enviarWhatsApp(telefono, codigo).then(() => canalesUsados.push('whatsapp')).catch(e => { errores.whatsapp = e.message; }));
    if (canal === 'sms' || canal === 'ambos')
        tareas.push(enviarSms(telefono, codigo).then(() => canalesUsados.push('sms')).catch(e => { errores.sms = e.message; }));

    await Promise.allSettled(tareas);

    if (!canalesUsados.length) {
        otpStore.delete(telefono);
        return res.status(503).json({ error: 'No se pudo enviar.', detalles: errores });
    }
    console.log(`🚀 OTP → ${telefono} vía: ${canalesUsados.join(', ')}`);
    res.json({ success: true, canalesUsados, advertencias: Object.keys(errores).length ? errores : undefined });
});

// POST /api/verificar-otp
app.post('/api/verificar-otp', async (req, res) => {
    const { telefono, codigo } = req.body;
    if (!telefono || !codigo) return res.status(400).json({ error: 'Faltan campos' });

    const r = verificarOtpStore(telefono, codigo);
    if (!r.ok) return res.status(401).json({ error: r.motivo });

    if (adminAuth) {
        try {
            const uid = 'pulpo_' + telefono.replace(/[^0-9]/g, '');
            const customToken = await adminAuth.createCustomToken(uid, { telefono, auth_method: 'pulpo_otp' });
            return res.json({ success: true, customToken, uid });
        } catch (e) { return res.status(500).json({ error: 'Token falló: ' + e.message }); }
    }
    res.json({ success: true });
});

// GET /api/status
app.get('/api/status', (_req, res) => res.json({
    servidor: 'ok',
    timestamp: new Date().toISOString(),
    whatsapp: waListo ? 'conectado' : (qrActual ? 'esperando QR' : 'conectando...'),
    qr_disponible: !!qrActual,
    intentos_fallidos: intentosFallidos,
    sms: atSms ? `listo (${AT_USERNAME})` : 'no configurado',
    firebase: adminAuth ? 'listo' : 'no disponible',
    otp_pendientes: otpStore.size,
}));

// ── Arranque ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
    await loadBaileys();
    await conectarWhatsApp();
    app.listen(PORT, () => {
        console.log(`\n🐙 Pulpo OTP activo en puerto ${PORT}`);
        console.log(`   QR:     https://pulpo-bot.onrender.com/api/qr`);
        console.log(`   Estado: https://pulpo-bot.onrender.com/api/status\n`);
    });
})();
