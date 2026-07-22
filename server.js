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

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Upstream Dynamic QRIS Request
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
          try {
            const json = JSON.parse(responseBody);
            resolve(json);
          } catch (e) {
            resolve({ raw: responseBody });
          }
        });
      });

      req.on('error', (err) => {
        if (attempt < retries) {
          setTimeout(() => executeReq(attempt + 1), 300);
        } else {
          reject(err);
        }
      });

      req.write(postData);
      req.end();
    };

    executeReq(0);
  });
}

// Helper: Extract Amount from Text
function extractAmountFromText(text) {
  if (!text) return null;
  const str = typeof text === 'object' ? JSON.stringify(text) : String(text);
  
  const matches = str.match(/(?:rp\.?|IDR)?\s*([\d\.,]+)/gi);
  if (!matches) return null;

  for (const match of matches) {
    const cleanNum = match.replace(/[^\d]/g, '');
    const num = parseInt(cleanNum, 10);
    if (!isNaN(num) && num >= 100) {
      return num;
    }
  }
  return null;
}

// -------------------------------------------------------------
// 1. MERCHANT / DEVELOPER AUTH & MANAGEMENT API
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
      password, // Simple auth for demo
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

    return res.json({
      ok: true,
      message: 'Login berhasil!',
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        api_key: merchant.api_key,
        webhook_token: merchant.webhook_token
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// Reset API Key / Webhook Token
app.post('/api/merchant/reset-keys', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.body.api_key;
    const merchant = await db.getMerchantByApiKey(apiKeyHeader);
    if (!merchant) {
      return res.status(401).json({ ok: false, message: 'API Key tidak valid' });
    }

    merchant.api_key = 'pz_live_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    merchant.webhook_token = 'pz_wh_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);

    await db.saveMerchant(merchant);

    return res.json({
      ok: true,
      message: 'API Key & Webhook Token baru berhasil di-reset!',
      api_key: merchant.api_key,
      webhook_token: merchant.webhook_token
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// -------------------------------------------------------------
// 2. GENERATE DYNAMIC QRIS (MULTI-TENANT API)
// -------------------------------------------------------------
app.post('/api/qris/generate', async (req, res) => {
  try {
    let { base_amount, unique_code, payload_static, amount, auto_unique, api_key } = req.body;
    const apiKeyHeader = req.headers['x-api-key'] || api_key;

    let merchant = null;
    if (apiKeyHeader) {
      merchant = await db.getMerchantByApiKey(apiKeyHeader);
    }

    base_amount = parseInt(base_amount || 0, 10);
    unique_code = parseInt(unique_code || 0, 10);

    if (auto_unique || (!unique_code && base_amount > 0)) {
      unique_code = Math.floor(Math.random() * 899) + 100; // 100 - 999
    }

    const defaultStaticPayload = '00020101021126570011ID.DANA.WWW011893600915300000000002150000000000000005204581253033605802ID5911PanzzPayDemo6007JAKARTA6304ABCD';

    const postParams = {
      payload_static: payload_static || defaultStaticPayload,
      qr: 'png'
    };

    if (base_amount > 0) postParams.base_amount = base_amount;
    if (unique_code > 0) postParams.unique_code = unique_code;
    if (amount > 0) postParams.amount = amount;

    let data;
    try {
      data = await postToUpstreamGateway('/qris/dynamic', postParams);
    } catch (netErr) {
      console.warn('PanzzPay Upstream warning, using local engine:', netErr.message);
      const total = (base_amount + unique_code) || amount || 10000;
      data = {
        base_amount,
        unique_code,
        total,
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
    console.error('Error generating dynamic QRIS:', error);
    return res.status(500).json({ ok: false, message: 'Server error: ' + error.message });
  }
});

// -------------------------------------------------------------
// 3. INVOICES STATUS & LISTING
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

// Manual Override Mark as Paid (Admin Dashboard feature)
app.post('/api/merchant/invoices/:id/mark-paid', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.body.api_key;
    const merchant = await db.getMerchantByApiKey(apiKeyHeader);
    if (!merchant) {
      return res.status(401).json({ ok: false, message: 'API Key tidak valid' });
    }

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

// -------------------------------------------------------------
// 4. MULTI-TENANT WEBHOOK CALLBACK RECEIVER
// -------------------------------------------------------------
app.post('/api/webhook/callback', async (req, res) => {
  const token = req.query.token || req.headers['authorization'] || 'DEFAULT_TOKEN';
  const body = req.body;
  const rawText = typeof body === 'object' ? JSON.stringify(body) : String(body);
  
  const extractedAmount = extractAmountFromText(body);

  // Identify Merchant by Webhook Token
  let merchant = await db.getMerchantByWebhookToken(token);

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
    token,
    raw_payload: body,
    extracted_amount: extractedAmount,
    matched_invoice_id: matchedInvoice ? matchedInvoice.id : null,
    source,
    status: matchedInvoice ? 'MATCHED' : 'UNMATCHED'
  };

  await db.saveWebhookLog(logEntry);

  return res.json({
    ok: true,
    message: matchedInvoice ? `Pembayaran Rp ${extractedAmount.toLocaleString('id-ID')} Berhasil Divalidasi!` : 'Webhook diterima, tidak ada invoice pending yang cocok.',
    log: logEntry,
    matched_invoice: matchedInvoice
  });
});

app.get('/api/webhook/logs', async (req, res) => {
  const apiKeyHeader = req.headers['x-api-key'] || req.query.api_key;
  let merchantId = null;
  if (apiKeyHeader) {
    const merchant = await db.getMerchantByApiKey(apiKeyHeader);
    if (merchant) merchantId = merchant.id;
  }

  const logs = await db.getWebhookLogsByMerchant(merchantId);
  res.json({ ok: true, logs });
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`⚡ PanzzPay Multi-Developer Server is running at http://localhost:${PORT}`);
});
