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

async function sendOtpEmail(targetEmail, otpCode, name = 'Merchant', reqHost = 'http://localhost:3000') {
  // Generate Firebase Auth official verification link directly via firebase-admin
  const fbResult = await db.generateFirebaseVerificationLink(targetEmail, reqHost);

  if (transporter) {
    const mailOptions = {
      from: `"PanzzPay Gateway" <${smtpUser || 'noreply@panzzpay.firebaseapp.com'}>`,
      to: targetEmail,
      subject: `[PanzzPay] Verifikasi Email Akun Anda`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 540px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px;">
          <h2 style="color: #4f46e5;">PanzzPay Gateway</h2>
          <p>Halo <strong>${name}</strong>,</p>
          <p>Gunakan kode verifikasi 6-digit berikut atau klik link Firebase untuk mengaktifkan akun Anda:</p>
          <div style="background: #f1f5f9; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
            <span style="font-family: monospace; font-size: 28px; font-weight: bold; color: #4f46e5;">${otpCode}</span>
          </div>
          ${fbResult.ok ? `<p><a href="${fbResult.link}" style="display: inline-block; padding: 10px 20px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 8px;">Verifikasi via Link Firebase</a></p>` : ''}
        </div>
      `
    };
    try {
      await transporter.sendMail(mailOptions);
      console.log(`✉️ [EMAIL DELIVERED] Sent to ${targetEmail}`);
      return { sent: true };
    } catch (err) {
      console.warn(`⚠️ SMTP send error:`, err.message);
    }
  }

  return { sent: true, firebase_link: fbResult.link || null };
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

function extractAmountFromText(text) {
  if (!text) return null;
  const str = typeof text === 'object' ? JSON.stringify(text) : String(text);
  const matches = str.match(/(?:rp\.?|IDR)?\s*([\d\.,]+)/gi);
  if (!matches) return null;

  for (const match of matches) {
    const cleanNum = match.replace(/[^\d]/g, '');
    const num = parseInt(cleanNum, 10);
    if (!isNaN(num) && num >= 100) return num;
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
        const freshOtp = String(Math.floor(100000 + Math.random() * 900000));
        existing.otp_code = freshOtp;
        await db.saveMerchant(existing);

        const reqHost = `${req.protocol}://${req.get('host')}`;
        await sendOtpEmail(existing.email, freshOtp, existing.name, reqHost);

        return res.json({
          ok: true,
          require_otp: true,
          email: existing.email,
          message: 'Akun Anda belum terverifikasi. Permintaan verifikasi email Firebase telah diproses!'
        });
      }
      return res.status(400).json({ ok: false, message: 'Email sudah terdaftar dan aktif. Silakan login.' });
    }

    const merchantId = 'MCH-' + Date.now().toString(36).toUpperCase();
    const apiKey = 'pz_live_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    const webhookToken = 'pz_wh_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));

    const merchant = {
      id: merchantId,
      name: name || 'Developer PanzzPay',
      email: cleanEmail,
      password,
      role: 'merchant',
      status: 'UNVERIFIED',
      otp_code: otpCode,
      api_key: apiKey,
      webhook_token: webhookToken,
      created_at: new Date().toISOString()
    };

    await db.saveMerchant(merchant);
    const reqHost = `${req.protocol}://${req.get('host')}`;
    await sendOtpEmail(merchant.email, otpCode, merchant.name, reqHost);

    return res.json({
      ok: true,
      require_otp: true,
      email: merchant.email,
      message: 'Pendaftaran berhasil! Akun Anda terhubung dengan Firebase Auth.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// RESEND OTP CODE OR FIREBASE VERIFICATION LINK
app.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok: false, message: 'Email wajib diisi' });

    const merchant = await db.getMerchantByEmail(email);
    if (!merchant) return res.status(404).json({ ok: false, message: 'Email tidak ditemukan' });

    const freshOtp = String(Math.floor(100000 + Math.random() * 900000));
    merchant.otp_code = freshOtp;
    await db.saveMerchant(merchant);

    const reqHost = `${req.protocol}://${req.get('host')}`;
    await sendOtpEmail(merchant.email, freshOtp, merchant.name, reqHost);

    return res.json({
      ok: true,
      message: 'Kode verifikasi / link Firebase berhasil dikirimkan!'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// VERIFY EMAIL ENDPOINT
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
      const freshOtp = String(Math.floor(100000 + Math.random() * 900000));
      merchant.otp_code = freshOtp;
      await db.saveMerchant(merchant);
      const reqHost = `${req.protocol}://${req.get('host')}`;
      await sendOtpEmail(merchant.email, freshOtp, merchant.name, reqHost);

      return res.status(403).json({
        ok: false,
        require_otp: true,
        email: merchant.email,
        message: 'Akun Anda belum terverifikasi! Silakan cek link / email verifikasi Firebase Anda.'
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
    const activeInvoices = await db.getInvoicesByMerchant(merchant ? merchant.id : null);
    for (const inv of activeInvoices) {
      if (inv.status === 'PENDING' && inv.total_amount === extractedAmount) {
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚡ PanzzPay Super Admin & Merchant Server is running at http://localhost:${PORT}`);
});
