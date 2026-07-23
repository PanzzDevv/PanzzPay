import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
import path from 'path';
import https from 'https';
import querystring from 'querystring';
import { fileURLToPath } from 'url';
import { db } from './firebase.js';
import { requireIdentity, requireMerchant, requireSessionMerchant, requireSuperAdmin, currentMerchantResponse } from './middleware/auth.js';
import { validate } from './middleware/validate.js';
import { buildEventId, generateId, getBearerToken, hashSecret, isTrustedOrigin, parseCookies, publicMerchant, securityLog, stableStringify } from './lib/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const sessionCookieName = '__session';
const sessionDurationMs = 5 * 24 * 60 * 60 * 1000;
let databaseStartupError = null;
const databaseReady = process.env.NODE_ENV === 'test'
  ? Promise.resolve()
  : db.init().catch(error => {
      databaseStartupError = error;
      securityLog('database_startup_failed', { code: error.code, message: error.message });
    });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", 'https://www.gstatic.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https://api.qrserver.com'],
      connectSrc: [
        "'self'",
        'https://identitytoolkit.googleapis.com',
        'https://securetoken.googleapis.com',
        'https://www.googleapis.com'
      ],
      frameSrc: ['https://accounts.google.com', 'https://*.firebaseapp.com'],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use((req, res, next) => {
  const origin = req.get('origin');
  const localDevelopment = !isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  if (origin && !localDevelopment && !isTrustedOrigin(req, origin)) {
    securityLog('cors_origin_rejected', { origin, path: req.path, ip: req.ip });
    return res.status(403).json({ ok: false, message: 'Origin request tidak diizinkan' });
  }
  return next();
});
app.use(cors({
  credentials: true,
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Webhook-Token', 'X-Webhook-Event-Id']
}));
app.use(express.json({ limit: '4mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.text({ type: 'text/plain', limit: '64kb' }));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.API_RATE_LIMIT) || 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, message: 'Terlalu banyak request. Coba lagi sebentar.' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, message: 'Terlalu banyak percobaan autentikasi. Coba lagi nanti.' }
});
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.WEBHOOK_RATE_LIMIT) || 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, message: 'Batas webhook terlampaui.' }
});

app.use('/api', apiLimiter);
app.use('/api', async (req, res, next) => {
  try {
    await databaseReady;
    if (databaseStartupError) {
      if (req.path === '/health/firebase') {
        return res.status(503).json({
          ok: false,
          status: 'unavailable',
          projectId: db.projectId
        });
      }
      throw Object.assign(new Error('Layanan database sementara tidak tersedia.'), { status: 503 });
    }
    return next();
  } catch (error) {
    return next(error);
  }
});
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!String(req.headers.cookie || '').includes(`${sessionCookieName}=`)) return next();
  const origin = req.get('origin');
  if (origin && !isTrustedOrigin(req, origin)) {
    securityLog('csrf_origin_rejected', { origin, path: req.path, ip: req.ip });
    return res.status(403).json({ ok: false, message: 'Origin request tidak diizinkan' });
  }
  return next();
});
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny', maxAge: isProduction ? '1h' : 0 }));

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(10, 'Password minimal 10 karakter').max(128)
  .regex(/[a-z]/, 'Password wajib memiliki huruf kecil')
  .regex(/[A-Z]/, 'Password wajib memiliki huruf besar')
  .regex(/[0-9]/, 'Password wajib memiliki angka');
const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema
}).strict();
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
const resendSchema = loginSchema;
const statusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
const qrisGenerateSchema = z.object({
  base_amount: z.coerce.number().int().min(100).max(999_999_999),
  unique_code: z.coerce.number().int().min(0).max(999).optional().default(0),
  auto_unique: z.boolean().optional().default(false)
}).strict();
const qrisPayloadSchema = z.object({ qris_payload: z.string().trim().min(20).max(4096) }).strict();
const imageSchema = z.object({ image_base64: z.string().startsWith('data:image/').max(4_000_000) }).strict();

function sessionCookieOptions() {
  return {
    maxAge: sessionDurationMs,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/'
  };
}

function clearSessionCookie(res) {
  const { maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(sessionCookieName, options);
}

async function firebaseIdentityRequest(endpoint, payload) {
  const apiKey = db.getClientConfig().apiKey;
  if (!apiKey) throw Object.assign(new Error('FIREBASE_API_KEY belum dikonfigurasi'), { status: 503 });
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  const data = await response.json();
  if (!response.ok) {
    const code = data.error?.message || 'FIREBASE_AUTH_ERROR';
    throw Object.assign(new Error(code), { code, status: 401 });
  }
  return data;
}

async function sendNativeVerificationEmail(email, password) {
  const signIn = await firebaseIdentityRequest('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true
  });
  await firebaseIdentityRequest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: signIn.idToken
  });
}

async function verifyFreshIdToken(idToken) {
  const auth = await db.getAuthSDK();
  if (!auth) throw Object.assign(new Error('Firebase Auth tidak tersedia'), { status: 503 });
  const decoded = await auth.verifyIdToken(idToken, true);
  const ageSeconds = Math.floor(Date.now() / 1000) - decoded.auth_time;
  if (ageSeconds > 5 * 60) throw Object.assign(new Error('Login terlalu lama; silakan autentikasi ulang'), { status: 401 });
  return decoded;
}

async function issueSession(res, idToken, decodedToken) {
  const auth = await db.getAuthSDK();
  if (!auth) throw Object.assign(new Error('Firebase Auth tidak tersedia'), { status: 503 });
  const decoded = decodedToken || await verifyFreshIdToken(idToken);
  const sessionCookie = await auth.createSessionCookie(idToken, { expiresIn: sessionDurationMs });
  res.cookie(sessionCookieName, sessionCookie, sessionCookieOptions());
  return decoded;
}

function safeAuthMessage(error) {
  const mapping = {
    EMAIL_EXISTS: 'Email sudah terdaftar.',
    INVALID_LOGIN_CREDENTIALS: 'Email atau password salah.',
    EMAIL_NOT_FOUND: 'Email atau password salah.',
    INVALID_PASSWORD: 'Email atau password salah.',
    USER_DISABLED: 'Akun dinonaktifkan.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Terlalu banyak percobaan. Coba lagi nanti.'
  };
  return mapping[error.code] || 'Autentikasi gagal.';
}

function postToUpstreamGateway(endpointPath, postParams, retries = 2) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify(postParams);
    const executeRequest = attempt => {
      const request = https.request({
        hostname: 'restapi.amgeekz.my.id',
        port: 443,
        path: endpointPath,
        method: 'POST',
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'PanzzPay-API/3.0',
          Connection: 'close'
        }
      }, response => {
        let responseBody = '';
        response.on('data', chunk => {
          responseBody += chunk;
          if (responseBody.length > 2_000_000) request.destroy(new Error('Respons upstream terlalu besar'));
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(`Upstream merespons HTTP ${response.statusCode}`));
          }
          try {
            return resolve(JSON.parse(responseBody));
          } catch {
            return reject(new Error('Respons upstream bukan JSON valid'));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Upstream timeout')));
      request.on('error', error => {
        if (attempt < retries) return setTimeout(() => executeRequest(attempt + 1), 250 * (attempt + 1));
        return reject(error);
      });
      request.write(postData);
      request.end();
    };
    executeRequest(0);
  });
}

function extractAmountFromText(input) {
  if (!input) return null;
  if (typeof input === 'object' && input.amount !== undefined) {
    const amount = Number(String(input.amount).replace(/[^\d]/g, ''));
    if (Number.isSafeInteger(amount) && amount >= 100 && amount <= 999_999_999) return amount;
  }
  const text = typeof input === 'object'
    ? `${input.message || ''} ${input.title || ''} ${input.text || ''}`
    : String(input);
  const currencyMatch = text.match(/(?:rp\.?|idr)\s*([\d.,]+)/i);
  if (!currencyMatch) return null;
  const amount = Number(currencyMatch[1].replace(/[^\d]/g, ''));
  return Number.isSafeInteger(amount) && amount >= 100 && amount <= 999_999_999 ? amount : null;
}

function paymentSource(payload) {
  const text = stableStringify(payload);
  if (/shopeepay/i.test(text)) return 'ShopeePay';
  if (/dana/i.test(text)) return 'DANA';
  if (/gopay/i.test(text)) return 'GoPay';
  if (/ovo/i.test(text)) return 'OVO';
  if (/bca/i.test(text)) return 'm-BCA';
  if (/brimo|bri/i.test(text)) return 'BRImo';
  if (/mandiri|livin/i.test(text)) return 'Livin by Mandiri';
  return 'Transfer QRIS';
}

app.post('/api/auth/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  let createdUser = null;
  try {
    const auth = await db.getAuthSDK();
    if (!auth) return res.status(503).json({ ok: false, message: 'Firebase Auth belum tersedia' });
    createdUser = await auth.createUser({
      email: req.body.email,
      password: req.body.password,
      displayName: req.body.name,
      emailVerified: false,
      disabled: false
    });
    const { credentials } = await db.provisionMerchant({
      uid: createdUser.uid,
      email: createdUser.email,
      email_verified: false,
      firebase: { sign_in_provider: 'password' }
    }, { name: req.body.name, provider: 'password' });
    await sendNativeVerificationEmail(req.body.email, req.body.password);
    securityLog('merchant_registered', { uid: createdUser.uid, email: createdUser.email, ip: req.ip });
    return res.status(201).json({
      ok: true,
      require_verification: true,
      message: 'Pendaftaran berhasil. Periksa email untuk verifikasi sebelum login.',
      credentials: {
        api_key: credentials.apiKey,
        webhook_url: `${req.protocol}://${req.get('host')}/api/webhook/callback#token=${credentials.webhookToken}`
      }
    });
  } catch (error) {
    if (createdUser && error.code !== 'auth/email-already-exists') {
      securityLog('registration_partial_failure', { uid: createdUser.uid, code: error.code });
    }
    return res.status(error.code === 'auth/email-already-exists' ? 409 : (error.status || 400))
      .json({ ok: false, message: safeAuthMessage(error) });
  }
});

app.post('/api/auth/login', authLimiter, validate(loginSchema), async (req, res) => {
  try {
    const signIn = await firebaseIdentityRequest('accounts:signInWithPassword', {
      email: req.body.email,
      password: req.body.password,
      returnSecureToken: true
    });
    const decoded = await verifyFreshIdToken(signIn.idToken);
    if (!decoded.email_verified) {
      securityLog('login_blocked', { uid: decoded.uid, ip: req.ip, reason: 'EMAIL_NOT_VERIFIED' });
      return res.status(403).json({ ok: false, code: 'EMAIL_NOT_VERIFIED', message: 'Verifikasi email terlebih dahulu.' });
    }
    const { merchant } = await db.provisionMerchant(decoded, { provider: 'password' });
    if (merchant.status === 'SUSPENDED') {
      securityLog('login_blocked', { uid: decoded.uid, ip: req.ip, reason: 'ACCOUNT_SUSPENDED' });
      return res.status(403).json({ ok: false, code: 'ACCOUNT_SUSPENDED', message: 'Akun ditangguhkan.' });
    }
    await issueSession(res, signIn.idToken, decoded);
    securityLog('login_succeeded', { uid: decoded.uid, ip: req.ip });
    return res.json({ ok: true, merchant: currentMerchantResponse(merchant) });
  } catch (error) {
    securityLog('login_failed', { email: req.body.email, ip: req.ip, code: error.code });
    return res.status(error.status || 401).json({ ok: false, message: safeAuthMessage(error) });
  }
});

app.get('/api/auth/session', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const sessionCookie = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!sessionCookie) return res.json({ ok: true, authenticated: false });

  try {
    const auth = await db.getAuthSDK();
    if (!auth) throw Object.assign(new Error('Firebase Auth tidak tersedia'), { status: 503 });
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    if (!decoded.email_verified) {
      clearSessionCookie(res);
      return res.json({ ok: true, authenticated: false });
    }
    const merchant = await db.getMerchantById(decoded.uid);
    if (!merchant || merchant.status !== 'ACTIVE') {
      clearSessionCookie(res);
      return res.json({ ok: true, authenticated: false });
    }
    return res.json({
      ok: true,
      authenticated: true,
      merchant: currentMerchantResponse(merchant)
    });
  } catch (error) {
    clearSessionCookie(res);
    securityLog('session_restore_failed', { ip: req.ip, code: error.code });
    return res.json({ ok: true, authenticated: false });
  }
});

app.post('/api/auth/google', authLimiter, requireIdentity({ allowSession: false }), async (req, res, next) => {
  try {
    const idToken = getBearerToken(req.headers.authorization);
    const decoded = await verifyFreshIdToken(idToken);
    const { merchant, credentials } = await db.provisionMerchant(decoded, { provider: 'google.com' });
    if (merchant.status === 'SUSPENDED') {
      return res.status(403).json({ ok: false, message: 'Akun ditangguhkan.' });
    }
    await issueSession(res, idToken, decoded);
    return res.json({
      ok: true,
      merchant: currentMerchantResponse(merchant),
      credentials: credentials ? {
        api_key: credentials.apiKey,
        webhook_url: `${req.protocol}://${req.get('host')}/api/webhook/callback#token=${credentials.webhookToken}`
      } : undefined
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/resend-verification', authLimiter, validate(resendSchema), async (req, res) => {
  try {
    await sendNativeVerificationEmail(req.body.email, req.body.password);
  } catch (error) {
    securityLog('verification_resend_failed', { email: req.body.email, ip: req.ip, code: error.code });
  }
  return res.json({ ok: true, message: 'Jika kredensial benar, email verifikasi telah dikirim ulang.' });
});

app.get('/api/auth/me', requireSessionMerchant, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, merchant: currentMerchantResponse(req.merchant) });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.all(['/api/auth/check-status', '/api/auth/verify-otp', '/api/auth/verify-link', '/api/auth/resend-otp'], (req, res) => {
  return res.status(410).json({ ok: false, message: 'Endpoint autentikasi lama sudah dinonaktifkan demi keamanan.' });
});

app.get('/api/auth/config', (req, res) => {
  const config = db.getClientConfig();
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({ ...config, enabled: Boolean(config.apiKey && config.projectId) });
});

app.get('/api/health/firebase', async (req, res) => {
  const health = await db.getHealth(true);
  return res.status(health.ok ? 200 : 503).json({ ok: health.ok, status: health.status, projectId: health.projectId });
});

app.get('/api/superadmin/merchants', requireSuperAdmin, async (req, res, next) => {
  try {
    const [merchants, invoices] = await Promise.all([db.getAllMerchants(), db.getAllInvoices()]);
    return res.json({
      ok: true,
      merchants: merchants.map(merchant => {
        const merchantInvoices = invoices.filter(invoice => invoice.merchant_id === merchant.id);
        return {
          ...publicMerchant(merchant),
          total_invoices: merchantInvoices.length,
          total_omset: merchantInvoices.filter(invoice => invoice.status === 'PAID')
            .reduce((sum, invoice) => sum + Number(invoice.total_amount || 0), 0)
        };
      })
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/superadmin/merchants/:id/toggle-status', requireSuperAdmin,
  validate(z.object({ status: statusSchema }).strict()), async (req, res, next) => {
    try {
      if (req.params.id === req.merchant.id) return res.status(400).json({ ok: false, message: 'Admin tidak dapat menangguhkan dirinya sendiri.' });
      const updated = await db.toggleMerchantStatus(req.params.id, req.body.status);
      if (!updated) return res.status(404).json({ ok: false, message: 'Merchant tidak ditemukan' });
      securityLog('merchant_status_changed', { adminUid: req.merchant.id, merchantId: updated.id, status: updated.status });
      return res.json({ ok: true, merchant: publicMerchant(updated) });
    } catch (error) {
      return next(error);
    }
  });

app.get('/api/superadmin/stats', requireSuperAdmin, async (req, res, next) => {
  try {
    const [merchants, invoices, logs] = await Promise.all([
      db.getAllMerchants(), db.getAllInvoices(), db.getAllWebhookLogs()
    ]);
    return res.json({
      ok: true,
      stats: {
        total_platform_omset: invoices.filter(invoice => invoice.status === 'PAID').reduce((sum, invoice) => sum + Number(invoice.total_amount || 0), 0),
        total_merchants: merchants.filter(merchant => merchant.role !== 'superadmin').length,
        total_invoices: invoices.length,
        total_paid_invoices: invoices.filter(invoice => invoice.status === 'PAID').length,
        total_webhook_logs: logs.length
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/qris/generate', requireMerchant, validate(qrisGenerateSchema), async (req, res, next) => {
  try {
    let { base_amount: baseAmount, unique_code: uniqueCode, auto_unique: autoUnique } = req.body;
    if (autoUnique || !uniqueCode) {
      let available = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        uniqueCode = crypto.randomInt(100, 1000);
        const collision = await db.getPendingInvoiceByAmount(req.merchant.id, baseAmount + uniqueCode);
        if (!collision) {
          available = true;
          break;
        }
      }
      if (!available) return res.status(409).json({ ok: false, message: 'Tidak dapat memperoleh kode unik pembayaran. Coba lagi.' });
    } else {
      const collision = await db.getPendingInvoiceByAmount(req.merchant.id, baseAmount + uniqueCode);
      if (collision) return res.status(409).json({ ok: false, message: 'Nominal total sedang dipakai invoice pending lain.' });
    }
    if (baseAmount + uniqueCode > 999_999_999) {
      return res.status(400).json({ ok: false, message: 'Nominal total melebihi batas maksimum.' });
    }
    const activePayload = req.merchant.qris_payload;
    if (!activePayload) return res.status(400).json({ ok: false, message: 'Merchant belum mengatur payload QRIS statis.' });

    const upstream = await postToUpstreamGateway('/qris/dynamic', {
      qr: 'png',
      payload_static: activePayload,
      base_amount: baseAmount,
      unique_code: uniqueCode
    });
    if (typeof upstream.payload !== 'string' || upstream.payload.length > 4096 ||
        typeof upstream.qr_png_data_url !== 'string' || upstream.qr_png_data_url.length > 2_000_000 ||
        !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\r\n]+$/i.test(upstream.qr_png_data_url)) {
      return res.status(502).json({ ok: false, message: 'Provider QRIS mengembalikan respons tidak lengkap.' });
    }

    const invoice = {
      id: generateId('INV-'),
      merchant_id: req.merchant.id,
      merchant_name: req.merchant.name,
      base_amount: baseAmount,
      unique_code: uniqueCode,
      total_amount: baseAmount + uniqueCode,
      payload: upstream.payload,
      qr_png_data_url: upstream.qr_png_data_url,
      currency: 'IDR',
      status: 'PENDING',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
    };
    await db.saveInvoice(invoice);
    return res.status(201).json({ ok: true, invoice });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/invoices', requireMerchant, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const invoices = await db.getInvoicesByMerchant(req.merchant.id, { limit, cursor: req.query.cursor });
    return res.json({ ok: true, invoices, next_cursor: invoices.length === limit ? invoices.at(-1)?.created_at : null });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/invoices/:id', async (req, res, next) => {
  try {
    const invoice = await db.getInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ ok: false, message: 'Invoice tidak ditemukan' });
    let current = invoice;
    if (invoice.status === 'PENDING' && invoice.expires_at && Date.now() > Date.parse(invoice.expires_at)) {
      current = await db.updateInvoiceStatus(invoice.id, 'EXPIRED');
    }
    return res.json({
      ok: true,
      invoice: {
        id: current.id,
        base_amount: current.base_amount,
        unique_code: current.unique_code,
        total_amount: current.total_amount,
        currency: current.currency || 'IDR',
        status: current.status,
        payment_source: current.payment_source || null,
        created_at: current.created_at,
        expires_at: current.expires_at,
        paid_at: current.paid_at || null
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/webhook/logs', requireMerchant, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const logs = await db.getWebhookLogsByMerchant(req.merchant.id, { limit, cursor: req.query.cursor });
    return res.json({ ok: true, logs, next_cursor: logs.length === limit ? logs.at(-1)?.received_at : null });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/qris/decode', requireSessionMerchant, validate(imageSchema), async (req, res, next) => {
  try {
    const base64Data = req.body.image_base64.replace(/^data:image\/[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer.length || buffer.length > 3_000_000) return res.status(400).json({ ok: false, message: 'Ukuran gambar QRIS tidak valid.' });
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'image/png' }), 'qrcode.png');
    const response = await fetch('https://api.qrserver.com/v1/read-qr-code/', {
      method: 'POST', body: formData, signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return res.status(502).json({ ok: false, message: 'Layanan pembaca QR sedang tidak tersedia.' });
    const result = await response.json();
    const payload = result?.[0]?.symbol?.[0]?.data;
    if (!payload || typeof payload !== 'string') return res.status(422).json({ ok: false, message: 'QRIS tidak dapat dibaca.' });
    return res.json({ ok: true, payload });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/merchant/invoices/:id/mark-paid', requireSessionMerchant, async (req, res, next) => {
  try {
    const updated = await db.updateOwnedInvoiceStatus(req.params.id, req.merchant.id, 'PAID', {
      paid_at: new Date().toISOString(),
      payment_source: 'Manual Merchant Override'
    });
    if (!updated) return res.status(404).json({ ok: false, message: 'Invoice merchant tidak ditemukan' });
    securityLog('invoice_manually_paid', { merchantId: req.merchant.id, invoiceId: updated.id, ip: req.ip });
    return res.json({ ok: true, invoice: updated });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/merchant/qris-payload', requireSessionMerchant, validate(qrisPayloadSchema), async (req, res, next) => {
  try {
    const merchant = await db.saveMerchant({ ...req.merchant, qris_payload: req.body.qris_payload });
    return res.json({ ok: true, merchant: currentMerchantResponse(merchant) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/merchant/credentials/rotate', requireSessionMerchant, async (req, res, next) => {
  try {
    const result = await db.rotateMerchantCredentials(req.merchant.id);
    securityLog('merchant_credentials_rotated', { merchantId: req.merchant.id, ip: req.ip });
    return res.json({
      ok: true,
      message: 'Kredensial lama langsung tidak berlaku. Simpan kredensial baru sekarang.',
      credentials: {
        api_key: result.credentials.apiKey,
        webhook_url: `${req.protocol}://${req.get('host')}/api/webhook/callback#token=${result.credentials.webhookToken}`
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/webhook/callback', webhookLimiter, async (req, res, next) => {
  try {
    if (req.query.token) return res.status(400).json({ ok: false, message: 'Token pada URL tidak lagi diterima. Gunakan Authorization: Bearer.' });
    const token = getBearerToken(req.headers.authorization) || req.get('x-webhook-token');
    if (!token) return res.status(401).json({ ok: false, message: 'Webhook token diperlukan' });
    const merchant = await db.getMerchantByWebhookToken(token);
    if (!merchant || merchant.status !== 'ACTIVE') return res.status(401).json({ ok: false, message: 'Webhook token tidak valid' });

    const amount = extractAmountFromText(req.body);
    if (!amount) return res.status(422).json({ ok: false, message: 'Nominal pembayaran tidak ditemukan atau tidak valid' });
    const suppliedEventId = req.get('x-webhook-event-id') || req.body?.event_id || req.body?.transaction_id || req.body?.reference_id;
    const eventId = buildEventId(merchant.id, req.body, suppliedEventId);
    const receivedAt = new Date().toISOString();
    const result = await db.processWebhookEvent({
      merchant,
      eventId,
      amount,
      source: paymentSource(req.body),
      payloadDigest: hashSecret(stableStringify(req.body)),
      receivedAt
    });
    if (result.duplicate) return res.status(200).json({ ok: true, duplicate: true, event_id: eventId });
    return res.status(result.invoice ? 200 : 202).json({
      ok: true,
      duplicate: false,
      event_id: eventId,
      matched_invoice_id: result.invoice?.id || null,
      status: result.invoice ? 'MATCHED' : 'UNMATCHED'
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/app/check-update', async (req, res) => {
  try {
    const response = await fetch('https://api.github.com/repos/PanzzDevv/PanzzPay/releases/latest', {
      headers: { 'User-Agent': 'PanzzPay-Server' }, signal: AbortSignal.timeout(8_000)
    });
    if (response.ok) {
      const release = await response.json();
      const tag = release.tag_name || 'v2.1.0';
      const asset = release.assets?.find(item => item.name.endsWith('.apk'));
      const parts = tag.replace(/[^0-9.]/g, '').split('.').map(value => Number(value) || 0);
      return res.json({
        ok: true,
        versionCode: (parts[0] || 2) * 100 + (parts[1] || 1) * 10 + (parts[2] || 0),
        versionName: tag.replace(/^v/, ''),
        downloadUrl: asset?.browser_download_url || 'https://github.com/PanzzDevv/PanzzPay/releases/latest/download/panzzpay-forwarder.apk',
        releaseNotes: String(release.body || 'Pembaruan otomatis dari GitHub Release.').slice(0, 5000),
        forceUpdate: false
      });
    }
  } catch {}
  return res.status(503).json({ ok: false, message: 'Informasi update belum tersedia.' });
});

app.get('/downloads/panzzpay-forwarder.apk', (req, res) => {
  return res.redirect(302, 'https://github.com/PanzzDevv/PanzzPay/releases/latest/download/panzzpay-forwarder.apk');
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  securityLog('request_error', { path: req.path, method: req.method, code: error.code, message: error.message });
  const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  return res.status(status).json({ ok: false, message: status === 500 ? 'Terjadi kesalahan pada server.' : error.message });
});

export { app };
export default app;

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  databaseReady.then(() => {
    if (databaseStartupError && db.firebaseRequired) {
      console.error('Server startup failed:', databaseStartupError.message);
      process.exitCode = 1;
      return;
    }
    app.listen(PORT, () => console.log(`PanzzPay server berjalan di http://localhost:${PORT}`));
  });
}
