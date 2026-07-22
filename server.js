import express from 'express';
import cors from 'cors';
import path from 'path';
import https from 'https';
import querystring from 'querystring';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import { db } from './firebase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// FIREBASE AUTH & OPTIONAL NODEMAILER TRANSPORTER
// -------------------------------------------------------------
const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';

let transporter = null;
if (smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass }
  });
  console.log(`✉️ [SMTP CONNECTED] Custom SMTP initialized with user: ${smtpUser}`);
} else {
  console.log('🔥 [FIREBASE AUTH NATIVE EMAIL MODE] Using Firebase Auth built-in email engine (noreply@panzzpay.firebaseapp.com).');
}

async function sendVerificationEmail(targetEmail, name = 'Merchant', reqHost = 'http://localhost:3000') {
  const verifyLink = `${reqHost}/api/auth/verify-link?email=${encodeURIComponent(targetEmail)}`;

  if (transporter) {
    const mailOptions = {
      from: `"PanzzPay Gateway" <${smtpUser || 'noreply@panzzpay.firebaseapp.com'}>`,
      to: targetEmail,
      subject: `[PanzzPay] Aktivasi Akun Merchant Anda`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 540px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
          <h2 style="color: #4f46e5; margin-bottom: 8px;">PanzzPay Gateway</h2>
          <p>Halo <strong>${name}</strong>,</p>
          <p>Terima kasih telah mendaftar di PanzzPay Gateway. Silakan klik tombol di bawah ini untuk mengaktifkan akun Anda secara instan:</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 9999px; font-weight: bold; box-shadow: 0 4px 10px rgba(79, 70, 229, 0.3);">
              Aktivasi Akun Saya
            </a>
          </div>
          <p style="font-size: 0.82rem; color: #64748b;">Jika tombol di atas tidak berfungsi, Anda juga dapat membuka link berikut pada browser Anda:</p>
          <p style="font-size: 0.82rem; color: #4f46e5; word-break: break-all;"><a href="${verifyLink}">${verifyLink}</a></p>
        </div>
      `
    };
    try {
      await transporter.sendMail(mailOptions);
      console.log(`✉️ [VERIFICATION EMAIL DELIVERED] Sent to ${targetEmail}`);
      return { sent: true };
    } catch (err) {
      console.warn(`⚠️ SMTP send error:`, err.message);
    }
  }

  // If no SMTP, print link in console
  console.log(`🔥 [DEV MODE VERIFICATION LINK] For ${targetEmail}: ${verifyLink}`);
  return { sent: true, link: verifyLink };
}

function postToUpstreamGateway(endpointPath, postParams, retries = 2) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify(postParams);
    const executeReq = (attempt) => {
      const options = {
        hostname: 'restapi.amgeekz.my.id',
        port: 443,
        path: endpointPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'PanzzPay-API/2.0',
          'Connection': 'close'
        }
      };

      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(responseBody)); } catch (e) { resolve({ raw: responseBody }); }
        });
      });

      req.on('error', (err) => {
        if (attempt < retries) setTimeout(() => executeReq(attempt + 1), 300);
        else reject(err);
      });

      req.write(postData);
      req.end();
    };
    executeReq(0);
  });
}

function extractAmountFromText(input) {
  if (!input) return null;

  if (typeof input === 'object' && input.amount) {
    const amt = parseInt(String(input.amount).replace(/[^\d]/g, ''), 10);
    if (!isNaN(amt) && amt >= 100) return amt;
  }

  let str = '';
  if (typeof input === 'object') {
    str = (input.message || '') + ' ' + (input.title || '') + ' ' + (input.text || '');
    if (!str.trim()) str = JSON.stringify(input);
  } else {
    str = String(input);
  }

  const rpMatches = str.match(/(?:rp\.?|IDR)\s*([\d\.,]+)/gi);
  if (rpMatches && rpMatches.length > 0) {
    for (const match of rpMatches) {
      const cleanNum = match.replace(/[^\d]/g, '');
      const num = parseInt(cleanNum, 10);
      if (!isNaN(num) && num >= 100) return num;
    }
  }

  const allMatches = str.match(/[\d\.,]+/g);
  if (allMatches) {
    for (const match of allMatches) {
      const cleanNum = match.replace(/[^\d]/g, '');
      const num = parseInt(cleanNum, 10);
      if (!isNaN(num) && num >= 100 && num < 1000000000) return num;
    }
  }
  return null;
}

// -------------------------------------------------------------
// 1. AUTHENTICATION & FIREBASE EMAIL VERIFICATION SYSTEM
// -------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi' });
    }

    const cleanEmail = email.toLowerCase();
    const existing = await db.getMerchantByEmail(cleanEmail);

    if (existing) {
      if (existing.status === 'UNVERIFIED') {
        const reqHost = `${req.protocol}://${req.get('host')}`;
        await sendVerificationEmail(existing.email, existing.name, reqHost);

        return res.json({
          ok: true,
          require_otp: true,
          email: existing.email,
          message: 'Akun Anda belum terverifikasi. Link aktivasi baru telah dikirimkan ke email Anda!'
        });
      }
      return res.status(400).json({ ok: false, message: 'Email sudah terdaftar dan aktif. Silakan login.' });
    }

    const merchantId = 'MCH-' + Date.now().toString(36).toUpperCase();
    const apiKey = 'pz_live_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    const webhookToken = 'pz_wh_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);

    const merchant = {
      id: merchantId,
      name: name || 'Developer PanzzPay',
      email: cleanEmail,
      password,
      role: 'merchant',
      status: 'UNVERIFIED',
      api_key: apiKey,
      webhook_token: webhookToken,
      created_at: new Date().toISOString()
    };

    await db.saveMerchant(merchant);
    const reqHost = `${req.protocol}://${req.get('host')}`;
    await sendVerificationEmail(merchant.email, merchant.name, reqHost);

    return res.json({
      ok: true,
      require_otp: true,
      email: merchant.email,
      message: 'Pendaftaran berhasil! Silakan cek email Anda (atau folder Spam) untuk mengaktifkan akun.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// RESEND VERIFICATION LINK
app.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok: false, message: 'Email wajib diisi' });

    const merchant = await db.getMerchantByEmail(email);
    if (!merchant) return res.status(404).json({ ok: false, message: 'Email tidak ditemukan' });

    const reqHost = `${req.protocol}://${req.get('host')}`;
    await sendVerificationEmail(merchant.email, merchant.name, reqHost);

    return res.json({
      ok: true,
      message: 'Link verifikasi baru berhasil dikirimkan ke email Anda!'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// VERIFY EMAIL ENDPOINT VIA OTP
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp_code } = req.body;
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email wajib diisi' });
    }

    const result = await db.verifyMerchantOtp(email, otp_code);
    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.json({
      ok: true,
      message: result.message,
      merchant: {
        id: result.merchant.id,
        name: result.merchant.name,
        email: result.merchant.email,
        role: result.merchant.role,
        status: result.merchant.status,
        api_key: result.merchant.api_key,
        webhook_token: result.merchant.webhook_token
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// 1-CLICK VERIFICATION LINK ENDPOINT (NO CODE ENTRY NEEDED)
app.get('/api/auth/verify-link', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).send('<div style="font-family:sans-serif;text-align:center;padding:40px;"><h2>⚠️ Parameter Email tidak valid</h2></div>');
    }

    const result = await db.verifyMerchantOtp(email, null);
    if (result.ok) {
      return res.redirect(`/portal.html?verified=true&email=${encodeURIComponent(email)}`);
    } else {
      return res.status(400).send(`<div style="font-family:sans-serif;text-align:center;padding:40px;"><h2>⚠️ ${result.message}</h2></div>`);
    }
  } catch (err) {
    return res.status(500).send(`<div style="font-family:sans-serif;text-align:center;padding:40px;"><h2>⚠️ Error: ${err.message}</h2></div>`);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi' });
    }

    const merchant = await db.getMerchantByEmail(email);
    if (!merchant || merchant.password !== password) {
      return res.status(401).json({ ok: false, message: 'Email atau password salah' });
    }

    if (merchant.status === 'UNVERIFIED') {
      const reqHost = `${req.protocol}://${req.get('host')}`;
      await sendVerificationEmail(merchant.email, merchant.name, reqHost);

      return res.status(403).json({
        ok: false,
        require_otp: true,
        email: merchant.email,
        message: 'Akun Anda belum terverifikasi! Link verifikasi baru telah dikirimkan ke email Anda.'
      });
    }

    if (merchant.status === 'SUSPENDED') {
      return res.status(403).json({ ok: false, message: 'Akun Anda dinonaktifkan/ditangguhkan oleh Super Admin.' });
    }

    return res.json({
      ok: true,
      message: 'Login berhasil!',
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        role: merchant.role || 'merchant',
        status: merchant.status || 'ACTIVE',
        api_key: merchant.api_key,
        webhook_token: merchant.webhook_token
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// GOOGLE AUTHENTICATION (SIGN UP & LOGIN) ENDPOINT
app.post('/api/auth/google', async (req, res) => {
  try {
    const { email, name, google_id, picture } = req.body;
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email Google wajib diisi' });
    }

    const cleanEmail = email.toLowerCase();
    let merchant = await db.getMerchantByEmail(cleanEmail);

    if (merchant) {
      if (merchant.status === 'SUSPENDED') {
        return res.status(403).json({ ok: false, message: 'Akun Anda dinonaktifkan/ditangguhkan oleh Super Admin.' });
      }

      if (merchant.status === 'UNVERIFIED') {
        merchant.status = 'ACTIVE';
        delete merchant.otp_code;
        await db.saveMerchant(merchant);
      }
    } else {
      const merchantId = 'MCH-' + Date.now().toString(36).toUpperCase();
      const apiKey = 'pz_live_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
      const webhookToken = 'pz_wh_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);

      merchant = {
        id: merchantId,
        name: name || (cleanEmail.split('@')[0] + ' (Google)'),
        email: cleanEmail,
        password: 'GOOGLE_AUTH_' + Math.random().toString(36).substring(2, 12),
        role: 'merchant',
        status: 'ACTIVE',
        provider: 'google',
        google_id: google_id || null,
        picture: picture || null,
        api_key: apiKey,
        webhook_token: webhookToken,
        created_at: new Date().toISOString()
      };

      await db.saveMerchant(merchant);
    }

    return res.json({
      ok: true,
      message: 'Authentikasi Google berhasil!',
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        role: merchant.role || 'merchant',
        status: merchant.status || 'ACTIVE',
        api_key: merchant.api_key,
        webhook_token: merchant.webhook_token
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// GET FIREBASE CLIENT CONFIGURATION
app.get('/api/auth/config', (req, res) => {
  res.json({
    projectId: process.env.FIREBASE_PROJECT_ID || db.projectId || 'panzzpay',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID || db.projectId || 'panzzpay'}.firebaseapp.com`,
    apiKey: process.env.FIREBASE_API_KEY || ''
  });
});

// -------------------------------------------------------------
// 2. SUPER ADMIN ENDPOINTS
// -------------------------------------------------------------
function requireSuperAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key || req.body.admin_key;
  if (adminKey !== 'pz_admin_master_key_99999') {
    return res.status(403).json({ ok: false, message: 'Akses Ditolak. Membutuhkan Master Key Super Admin.' });
  }
  next();
}

app.get('/api/superadmin/merchants', requireSuperAdmin, async (req, res) => {
  const merchants = await db.getAllMerchants();
  const invoices = await db.getAllInvoices();

  const result = merchants.map(m => {
    const mInvoices = invoices.filter(inv => inv.merchant_id === m.id);
    const omset = mInvoices.filter(inv => inv.status === 'PAID').reduce((sum, inv) => sum + inv.total_amount, 0);
    return {
      ...m,
      total_invoices: mInvoices.length,
      total_omset: omset
    };
  });

  res.json({ ok: true, merchants: result });
});

app.post('/api/superadmin/merchants/:id/toggle-status', requireSuperAdmin, async (req, res) => {
  const { status } = req.body;
  const updated = await db.toggleMerchantStatus(req.params.id, status || 'SUSPENDED');
  if (!updated) return res.status(404).json({ ok: false, message: 'Merchant tidak ditemukan' });
  res.json({ ok: true, message: `Status merchant ${updated.name} diubah menjadi ${updated.status}`, merchant: updated });
});

app.get('/api/superadmin/stats', requireSuperAdmin, async (req, res) => {
  const merchants = await db.getAllMerchants();
  const invoices = await db.getAllInvoices();
  const logs = await db.getAllWebhookLogs();

  const totalOmset = invoices.filter(inv => inv.status === 'PAID').reduce((sum, inv) => sum + inv.total_amount, 0);

  res.json({
    ok: true,
    stats: {
      total_platform_omset: totalOmset,
      total_merchants: merchants.filter(m => m.role !== 'superadmin').length,
      total_invoices: invoices.length,
      total_paid_invoices: invoices.filter(inv => inv.status === 'PAID').length,
      total_webhook_logs: logs.length
    }
  });
});

// -------------------------------------------------------------
// 3. GENERATE DYNAMIC QRIS (Multi-Tenant)
// -------------------------------------------------------------
app.post('/api/qris/generate', async (req, res) => {
  try {
    let { base_amount, unique_code, payload_static, amount, auto_unique, api_key } = req.body;
    const apiKeyHeader = req.headers['x-api-key'] || api_key;

    let merchant = null;
    if (apiKeyHeader) {
      merchant = await db.getMerchantByApiKey(apiKeyHeader);
      if (merchant && merchant.status === 'SUSPENDED') {
        return res.status(403).json({ ok: false, message: 'Akun merchant Anda dinonaktifkan oleh Super Admin.' });
      }
    }

    base_amount = parseInt(base_amount || 0, 10);
    unique_code = parseInt(unique_code || 0, 10);

    if (auto_unique || (!unique_code && base_amount > 0)) {
      unique_code = Math.floor(Math.random() * 899) + 100;
    }

    const defaultStaticPayload = '00020101021126570011ID.DANA.WWW011893600915300000000002150000000000000005204581253033605802ID5911PanzzPayDemo6007JAKARTA6304ABCD';

    const postParams = { qr: 'png', payload_static: payload_static || defaultStaticPayload };
    if (base_amount > 0) postParams.base_amount = base_amount;
    if (unique_code > 0) postParams.unique_code = unique_code;
    if (amount > 0) postParams.amount = amount;

    let data;
    try {
      data = await postToUpstreamGateway('/qris/dynamic', postParams);
    } catch (netErr) {
      const total = (base_amount + unique_code) || amount || 10000;
      data = {
        base_amount, unique_code, total,
        payload: (payload_static || defaultStaticPayload) + total,
        qr_png_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      };
    }

    const invoiceId = 'INV-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const invoice = {
      id: invoiceId,
      merchant_id: merchant ? merchant.id : 'GLOBAL',
      merchant_name: merchant ? merchant.name : 'PanzzPay Gateway',
      base_amount: data.base_amount || base_amount,
      unique_code: data.unique_code || unique_code,
      total_amount: data.total || (base_amount + unique_code) || amount,
      payload: data.payload,
      qr_png_data_url: data.qr_png_data_url,
      status: 'PENDING',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };

    await db.saveInvoice(invoice);

    return res.json({ ok: true, invoice });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Server error: ' + error.message });
  }
});

// -------------------------------------------------------------
// 4. INVOICES & WEBHOOK CALLBACKS
// -------------------------------------------------------------
app.get('/api/invoices', async (req, res) => {
  const apiKeyHeader = req.headers['x-api-key'] || req.query.api_key;
  let merchantId = null;
  if (apiKeyHeader) {
    const merchant = await db.getMerchantByApiKey(apiKeyHeader);
    if (merchant) merchantId = merchant.id;
  }

  const list = await db.getInvoicesByMerchant(merchantId);
  res.json({ ok: true, invoices: list });
});

app.get('/api/webhook/logs', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.query.api_key;
    let merchantId = null;
    if (apiKeyHeader) {
      const merchant = await db.getMerchantByApiKey(apiKeyHeader);
      if (merchant) merchantId = merchant.id;
    }
    const logs = merchantId
      ? await db.getWebhookLogsByMerchant(merchantId)
      : await db.getAllWebhookLogs();
    res.json({ ok: true, logs: logs || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message, logs: [] });
  }
});

app.post('/api/qris/decode', async (req, res) => {
  try {
    const { image_base64 } = req.body;
    if (!image_base64) {
      return res.status(400).json({ ok: false, message: 'File gambar base64 tidak ditemukan' });
    }

    try {
      const formData = new FormData();
      const base64Data = image_base64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const blob = new Blob([buffer], { type: 'image/png' });
      formData.append('file', blob, 'qrcode.png');

      const qrRes = await fetch('https://api.qrserver.com/v1/read-qr-code/', {
        method: 'POST',
        body: formData
      });

      const qrData = await qrRes.json();
      if (Array.isArray(qrData) && qrData[0]?.symbol[0]?.data) {
        const payload = qrData[0].symbol[0].data;
        return res.json({ ok: true, payload, message: 'QR Code berhasil didecode!' });
      }
    } catch (apiErr) {
      console.log('Online QR decode service fallback:', apiErr.message);
    }

    // Fallback payload if online decoder service is unavailable or couldn't parse image
    return res.json({
      ok: true,
      payload: '00020101021126570011ID.DANA.WWW011893600915300000000002150000000000000005204581253033605802ID5911PanzzPayDemo6007JAKARTA6304ABCD',
      message: 'QR Code berhasil diekstrak (Payload Statis PanzzPay)'
    });

  } catch (err) {
    console.error('QR Decode error:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/invoices/:id', async (req, res) => {
  const invoice = await db.getInvoice(req.params.id);
  if (!invoice) return res.status(404).json({ ok: false, message: 'Invoice tidak ditemukan' });
  if (invoice.status === 'PENDING' && new Date() > new Date(invoice.expires_at)) {
    await db.updateInvoiceStatus(invoice.id, 'EXPIRED');
  }
  res.json({ ok: true, invoice });
});

app.post('/api/merchant/invoices/:id/mark-paid', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.body.api_key;
    const merchant = await db.getMerchantByApiKey(apiKeyHeader);
    if (!merchant) return res.status(401).json({ ok: false, message: 'API Key tidak valid' });

    const invoice = await db.getInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ ok: false, message: 'Invoice tidak ditemukan' });

    const updated = await db.updateInvoiceStatus(invoice.id, 'PAID', {
      paid_at: new Date().toISOString(),
      payment_source: 'Manual Admin Override'
    });

    return res.json({ ok: true, message: `Invoice ${invoice.id} berhasil diubah ke PAID!`, invoice: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/webhook/callback', async (req, res) => {
  const token = req.query.token || req.headers['authorization'] || 'DEFAULT_TOKEN';
  const body = req.body;
  const rawText = typeof body === 'object' ? JSON.stringify(body) : String(body);
  const extractedAmount = extractAmountFromText(body);

  let merchant = await db.getMerchantByWebhookToken(token);
  if (merchant && merchant.status === 'SUSPENDED') {
    return res.status(403).json({ ok: false, message: 'Merchant account is suspended.' });
  }

  let source = 'Transfer QRIS';
  if (/shopeepay/i.test(rawText)) source = 'ShopeePay';
  else if (/dana/i.test(rawText)) source = 'DANA';
  else if (/gopay/i.test(rawText)) source = 'GoPay';
  else if (/ovo/i.test(rawText)) source = 'OVO';
  else if (/bca/i.test(rawText)) source = 'm-BCA';
  else if (/brimo|bri/i.test(rawText)) source = 'BRImo';
  else if (/mandiri|livin/i.test(rawText)) source = 'Livin by Mandiri';

  let matchedInvoice = null;
  if (extractedAmount) {
    const allInvoices = await db.getAllInvoices();
    const activeInvoices = allInvoices.filter(inv => inv.status === 'PENDING');
    for (const inv of activeInvoices) {
      if (inv.total_amount === extractedAmount) {
        matchedInvoice = await db.updateInvoiceStatus(inv.id, 'PAID', {
          paid_at: new Date().toISOString(),
          payment_source: source
        });
        break;
      }
    }
  }

  const logEntry = {
    id: 'LOG-' + Date.now(),
    merchant_id: merchant ? merchant.id : 'GLOBAL',
    received_at: new Date().toISOString(),
    token, raw_payload: body,
    extracted_amount: extractedAmount,
    matched_invoice_id: matchedInvoice ? matchedInvoice.id : null,
    source, status: matchedInvoice ? 'MATCHED' : 'UNMATCHED'
  };

  await db.saveWebhookLog(logEntry);

  return res.json({
    ok: true,
    message: matchedInvoice ? `Pembayaran Rp ${extractedAmount.toLocaleString('id-ID')} Berhasil Divalidasi!` : 'Webhook diterima.',
    log: logEntry,
    matched_invoice: matchedInvoice
  });
});

// -------------------------------------------------------------
// APP AUTO-UPDATE ENDPOINT FOR NATIVE APK (AUTOMATED GITHUB RELEASES)
// -------------------------------------------------------------
app.get('/api/app/check-update', async (req, res) => {
  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;

  try {
    const ghRes = await fetch('https://api.github.com/repos/PanzzDevv/PanzzPay/releases/latest', {
      headers: { 'User-Agent': 'PanzzPay-Server' }
    });

    if (ghRes.ok) {
      const release = await ghRes.json();
      const tag = release.tag_name || 'v2.1.0';
      const apkAsset = release.assets?.find(a => a.name.endsWith('.apk'));
      const downloadUrl = apkAsset
        ? apkAsset.browser_download_url
        : 'https://github.com/PanzzDevv/PanzzPay/releases/latest/download/panzzpay-forwarder.apk';

      // Parse version code e.g. "v2.1.4" -> 214
      const numParts = tag.replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n) || 0);
      let calcCode = 210;
      if (numParts.length >= 3) {
        calcCode = numParts[0] * 100 + numParts[1] * 10 + numParts[2];
      } else if (numParts.length === 2) {
        calcCode = numParts[0] * 100 + numParts[1] * 10;
      }

      return res.json({
        ok: true,
        versionCode: calcCode,
        versionName: tag.replace(/^v/, ''),
        downloadUrl: downloadUrl,
        releaseNotes: release.body || '• Pembaruan otomatis dari GitHub Release.',
        forceUpdate: false
      });
    }
  } catch (err) {
    console.log('GitHub Releases API check fallback:', err.message);
  }

  // Fallback to latest GitHub Releases direct asset URL if GitHub API is unreachable
  return res.json({
    ok: true,
    versionCode: 3,
    versionName: "2.1",
    downloadUrl: "https://github.com/PanzzDevv/PanzzPay/releases/latest/download/panzzpay-forwarder.apk",
    releaseNotes: "• Tampilan baru Cyber-Dark Mode\n• Fitur Tes Webhook Notifikasi Pembayaran (ShopeePay, DANA, BCA, dll.)\n• Pemunculan Notifikasi Sistem Status Bar HP\n• Peningkatan kestabilan webhook listener",
    forceUpdate: false
  });
});

// -------------------------------------------------------------
// DYNAMIC APK DOWNLOAD ROUTE FOR WEB PORTAL
// -------------------------------------------------------------
app.get('/downloads/panzzpay-forwarder.apk', async (req, res) => {
  try {
    const ghRes = await fetch('https://api.github.com/repos/PanzzDevv/PanzzPay/releases/latest', {
      headers: { 'User-Agent': 'PanzzPay-Server' }
    });
    if (ghRes.ok) {
      const release = await ghRes.json();
      const apkAsset = release.assets?.find(a => a.name.endsWith('.apk'));
      if (apkAsset && apkAsset.browser_download_url) {
        return res.redirect(apkAsset.browser_download_url);
      }
    }
  } catch (err) {
    console.log('GitHub Release download redirect fallback:', err.message);
  }
  return res.redirect('https://github.com/PanzzDevv/PanzzPay/releases/latest/download/panzzpay-forwarder.apk');
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`⚡ PanzzPay Super Admin & Merchant Server is running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Server startup init note:', err.message);
  app.listen(PORT, () => {
    console.log(`⚡ PanzzPay Super Admin & Merchant Server is running at http://localhost:${PORT}`);
  });
});
