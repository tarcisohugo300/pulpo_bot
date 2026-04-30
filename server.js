/**
 * server.js — Pulpo OTP Server v5 (Email via Gmail)
 */

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const nodemailer   = require('nodemailer');
const app          = express();

app.use(cors());
app.use(express.json());

// ── Gmail Transporter ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
    },
});

transporter.verify((err) => {
    if (err) console.error('❌ Gmail no conectó:', err.message);
    else console.log('📧 Gmail listo:', process.env.GMAIL_USER);
});

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
    console.log('🔥 Firebase Admin listo');
} catch (e) {
    console.warn('⚠️  Firebase Admin no disponible:', e.message);
}

// ── OTP Store ─────────────────────────────────────────────────────────────────
const otpStore      = new Map();
const OTP_TTL_MS    = 10 * 60 * 1000;
const OTP_MAX_TRIES = 5;

function generarCodigo() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
function guardarOtp(key, codigo) {
    otpStore.set(key, { codigo, expira: Date.now() + OTP_TTL_MS, intentos: 0 });
}
function verificarOtpStore(key, codigoIngresado) {
    const e = otpStore.get(key);
    if (!e)                          return { ok: false, motivo: 'No existe código activo. Solicita uno nuevo.' };
    if (Date.now() > e.expira)       return { ok: false, motivo: 'Código expirado. Solicita uno nuevo.' };
    if (e.intentos >= OTP_MAX_TRIES) return { ok: false, motivo: 'Demasiados intentos. Solicita un nuevo código.' };
    e.intentos++;
    if (e.codigo !== codigoIngresado)
        return { ok: false, motivo: `Código incorrecto. Intentos restantes: ${OTP_MAX_TRIES - e.intentos}` };
    otpStore.delete(key);
    return { ok: true };
}
setInterval(() => {
    const n = Date.now();
    for (const [k, e] of otpStore) if (n > e.expira) otpStore.delete(k);
}, 300_000);

// ── Enviar email ──────────────────────────────────────────────────────────────
async function enviarEmail(email, codigo) {
    await transporter.sendMail({
        from   : `"Pulpo 🐙" <${process.env.GMAIL_USER}>`,
        to     : email,
        subject: `${codigo} es tu código de verificación Pulpo`,
        html   : `
            <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;border-radius:12px;background:#f9f9f9">
                <h2 style="color:#4A148C;margin-bottom:8px">🐙 Pulpo</h2>
                <p style="color:#555">Tu código de verificación es:</p>
                <div style="font-size:42px;font-weight:bold;letter-spacing:8px;color:#4A148C;text-align:center;padding:24px;background:#fff;border-radius:8px;margin:16px 0">
                    ${codigo}
                </div>
                <p style="color:#888;font-size:13px">Válido por 10 minutos. No lo compartas con nadie.</p>
            </div>
        `,
    });
}

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────

// POST /api/enviar-otp  { "email": "usuario@gmail.com" }
app.post('/api/enviar-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta el campo "email"' });

    const codigo = generarCodigo();
    guardarOtp(email, codigo);

    try {
        await enviarEmail(email, codigo);
        console.log(`✅ OTP enviado a ${email}`);
        res.json({ success: true, canal: 'email' });
    } catch (e) {
        console.error(`❌ Error enviando email a ${email}:`, e.message);
        otpStore.delete(email);
        res.status(503).json({ error: 'No se pudo enviar el email.', detalle: e.message });
    }
});

// POST /api/verificar-otp  { "email": "...", "codigo": "123456" }
app.post('/api/verificar-otp', async (req, res) => {
    const { email, codigo } = req.body;
    if (!email || !codigo) return res.status(400).json({ error: 'Faltan campos' });

    const r = verificarOtpStore(email, codigo);
    if (!r.ok) return res.status(401).json({ error: r.motivo });

    console.log(`✅ OTP verificado para ${email}`);

    if (adminAuth) {
        try {
            const uid         = 'pulpo_' + email.replace(/[^a-zA-Z0-9]/g, '_');
            const customToken = await adminAuth.createCustomToken(uid, { email, auth_method: 'pulpo_otp' });
            return res.json({ success: true, customToken, uid });
        } catch (e) {
            return res.status(500).json({ error: 'Token falló: ' + e.message });
        }
    }
    res.json({ success: true });
});

// GET /api/status
app.get('/api/status', (_req, res) => res.json({
    servidor      : 'ok',
    timestamp     : new Date().toISOString(),
    canal         : 'email via Gmail',
    gmail         : process.env.GMAIL_USER,
    firebase_admin: adminAuth ? 'listo' : 'no disponible',
    otp_pendientes: otpStore.size,
}));

// ── Arranque ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🐙 Pulpo OTP v5 activo en puerto ${PORT}\n`);
});
