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
let waSocket = null;
let waListo  = false;
let qrActual = null;
let intentosFallidos = 0;

function limpiarSesion() {
    try { fs.rmSync('wa_session', { recursive: true, force: true }); } catch (_) {}
    console.log('🗑️  Sesión limpiada');
}

async function conectarWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('wa_session');
        const logger = P({ level: 'silent' });

        if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }

        waSocket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            browser           : ['Ubuntu', 'Chrome', '120.0.0'],
            connectTimeoutMs  : 60_000,
            keepAliveIntervalMs: 30_000,
            defaultQueryTimeoutMs: 60_000,
            syncFullHistory   : false,
            markOnlineOnConnect: false,
        });

        waSocket.ev.on('creds.update', saveCreds);

        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                intentosFallidos = 0;
                qrActual = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
                console.log('📱 QR generado — visita /api/qr para escanearlo');
            }

            if (connection === 'open') {
                waListo  = true;
                qrActual = null;
                intentosFallidos = 0;
                console.log('✅ WhatsApp conectado y listo');
            }

            if (connection === 'close') {
                waListo = false;
                const code = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode : undefined;

                console.warn(`⚠️  Desconectado (código ${code})`);

                if (code === DisconnectReason.loggedOut) {
                    console.error('❌ Sesión cerrada. Visita /api/qr → Reiniciar para vincular de nuevo.');
                    limpiarSesion();
                    setTimeout(conectarWhatsApp, 5_000);
                    return;
                }

                // Si falla muchas veces sin generar QR → limpiar sesión y reintentar
                intentosFallidos++;
                if (intentosFallidos >= 5) {
                    console.warn('⚠️  Muchos fallos — limpiando sesión para forzar QR nuevo');
                    limpiarSesion();
                    intentosFallidos = 0;
                }

                const delay = intentosFallidos > 2 ? 15_000 : 5_000;
                setTimeout(conectarWhatsApp, delay);
            }
        });

    } catch (err) {
        console.error('❌ Error iniciando WhatsApp:', err.message);
        setTimeout(conectarWhatsApp, 10_000);
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

// GET /api/qr
app.get('/api/qr', (_req, res) => {
    if (waListo) {
        return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fff0">
            <h2 style="color:green">✅ WhatsApp ya está conectado</h2>
            <p>El bot está activo y funcionando.</p>
            <a href="/api/status">Ver estado</a>
        </body></html>`);
    }

    const resetBtn = `
        <form method="POST" action="/api/reset-wa" style="margin-top:20px">
            <button type="submit" style="background:#e53935;color:white;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px">
                🔄 Reiniciar conexión
            </button>
        </form>
        <p style="color:gray;font-size:12px">Usa esto si el QR no aparece después de 30 segundos</p>`;

    if (!qrActual) {
        return res.send(`<html>
            <head><meta http-equiv="refresh" content="5"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#fffbe6">
                <h2>⏳ Generando QR...</h2>
                <p>Esta página se actualiza cada 5 segundos.</p>
                ${resetBtn}
            </body></html>`);
    }

    res.send(`<html>
        <head><meta http-equiv="refresh" content="25"></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
            <h2>📱 Escanea con WhatsApp</h2>
            <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
            <img src="${qrActual}" style="border:4px solid #333;border-radius:8px;margin:20px"/>
            <p style="color:gray;font-size:13px">QR se recarga solo cada 25 seg.</p>
            ${resetBtn}
        </body></html>`);
});

// POST /api/reset-wa — fuerza sesión limpia y reconexión
app.post('/api/reset-wa', async (_req, res) => {
    console.log('🔄 Reset manual solicitado');
    waListo  = false;
    qrActual = null;
    intentosFallidos = 0;
    if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }
    limpiarSesion();
    setTimeout(conectarWhatsApp, 1_000);
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
