import express from 'express';
import cors from 'cors';
import path from 'path';
import https from 'https';
import querystring from 'querystring';
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
// 1. AUTHENTICATION & ROLE MANAGEMENT (Super Admin & Merchant)
// -------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi' });
    }

    const existing = await db.getMerchantByEmail(email);
    if (existing) {
      return res.status(400).json({ ok: false, message: 'Email sudah terdaftar. Silakan login.' });
    }

    const merchantId = 'MCH-' + Date.now().toString(36).toUpperCase();
    const apiKey = 'pz_live_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    const webhookToken = 'pz_wh_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);

    const merchant = {
      id: merchantId,
      name: name || 'Developer PanzzPay',
      email: email.toLowerCase(),
      password,
      role: 'merchant',
      status: 'ACTIVE',
      api_key: apiKey,
      webhook_token: webhookToken,
      created_at: new Date().toISOString()
    };

    await db.saveMerchant(merchant);

    return res.json({
      ok: true,
      message: 'Pendaftaran merchant berhasil!',
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        role: merchant.role,
        status: merchant.status,
        api_key: merchant.api_key,
        webhook_token: merchant.webhook_token
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
// 2. SUPER ADMIN ENDPOINTS (Restricted to Super Admin Master Key)
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
        qr_png_data_url: 'data:image/png;base64,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'
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
