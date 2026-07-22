/**
 * =========================================================================
 * 🤖 PANZZPAY TELEGRAM BOT PAYMENT TESTING SCRIPT
 * =========================================================================
 * 
 * Script ini adalah contoh lengkap Bot Telegram interaktif yang terhubung
 * dengan PanzzPay QRIS Payment Gateway API.
 * 
 * CARA MENGGUNAKAN:
 * 1. Dapatkan Bot Token dari Telegram @BotFather.
 * 2. Jalankan perintah di terminal:
 *    set BOT_TOKEN=token_bot_anda_dari_botfather
 *    node test_telegram_bot.js
 * 
 * 3. Buka Bot Anda di Telegram, ketik /start atau /beli, dan pilih produk.
 * 4. PanzzPay akan membuatkan QRIS + Kode Unik secara otomatis.
 * 5. Gunakan aplikasi Android PanzzPay Forwarder untuk melakukan 'Tes Webhook',
 *    dan lihat Bot Telegram Anda secara otomatis mendeteksi pembayaran lunas!
 * =========================================================================
 */

import http from 'http';
import https from 'https';
import dns from 'dns';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const PANZZPAY_API_URL = process.env.PANZZPAY_URL || 'https://panzzpay.vercel.app';

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') {
  console.log('\n⚠️ [PERHATIAN] Anda belum memasukkan TELEGRAM_BOT_TOKEN!');
  console.log('Silakan set environment variable BOT_TOKEN atau isi BOT_TOKEN di baris 17 file ini.\n');
  console.log('Contoh menjalankan di PowerShell:');
  console.log('  $env:BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"');
  console.log('  node test_telegram_bot.js\n');
}

const httpsAgent = new https.Agent({ family: 4, keepAlive: true });

// Map simpan interval polling invoice aktif { invoiceId: { chatId, messageId, timer } }
const activePollers = new Map();

// Helper panggil Telegram Bot API via Native IPv4 HTTPS Request
function tgApi(method, body = {}) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });

    req.on('error', (err) => {
      console.error(`❌ Telegram API Error [${method}]:`, err.message);
      resolve({ ok: false, error: err.message });
    });

    req.write(postData);
    req.end();
  });
}

// Send photo with base64 to Telegram via Native IPv4 HTTPS Request
function tgSendPhotoBase64(chatId, base64DataUrl, caption, replyMarkup) {
  return new Promise((resolve) => {
    try {
      const base64Data = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const boundary = '----PanzzPayBoundary' + Math.random().toString(36).substring(2);
      let body = [];

      body.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
      body.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`);
      body.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`);

      if (replyMarkup) {
        body.push(`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${JSON.stringify(replyMarkup)}\r\n`);
      }

      body.push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="qris.png"\r\nContent-Type: image/png\r\n\r\n`);

      const headerBuffer = Buffer.from(body.join(''));
      const footerBuffer = Buffer.from(`\r\n--${boundary}--\r\n`);

      const fullBuffer = Buffer.concat([headerBuffer, buffer, footerBuffer]);

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/sendPhoto`,
        method: 'POST',
        agent: httpsAgent,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': fullBuffer.length
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ ok: false });
          }
        });
      });

      req.on('error', (err) => {
        console.error('❌ Error sending photo to Telegram:', err.message);
        resolve({ ok: false });
      });

      req.write(fullBuffer);
      req.end();
    } catch (err) {
      console.error('❌ Error sending photo:', err.message);
      resolve({ ok: false });
    }
  });
}

// -------------------------------------------------------------------------
// TELEGRAM BOT LONG-POLLING ENGINE
// -------------------------------------------------------------------------
let lastUpdateId = 0;

async function pollUpdates() {
  const data = await tgApi('getUpdates', { offset: lastUpdateId + 1, timeout: 20 });
  if (data && data.ok && Array.isArray(data.result)) {
    for (const update of data.result) {
      lastUpdateId = update.update_id;
      handleTelegramUpdate(update);
    }
  }
  setTimeout(pollUpdates, 1000);
}

async function handleTelegramUpdate(update) {
  // 1. Text Message (/start, /beli, /help)
  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    if (text.startsWith('/start') || text.startsWith('/beli') || text.startsWith('/products')) {
      await sendProductMenu(chatId);
    } else {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '👋 Halo! Ketik <b>/beli</b> atau <b>/start</b> untuk mencoba simulasi pembayaran QRIS PanzzPay.',
        parse_mode: 'HTML'
      });
    }
  }

  // 2. Inline Keyboard Button Click
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    if (data.startsWith('buy_')) {
      const amountStr = data.replace('buy_', '');
      const amount = parseInt(amountStr, 10);

      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '🔄 Memuat QRIS PanzzPay...' });
      await processPaymentCreation(chatId, amount);
    } else if (data.startsWith('check_')) {
      const invoiceId = data.replace('check_', '');
      await checkInvoiceStatusManual(chatId, cb.message.message_id, invoiceId, cb.id);
    }
  }
}

// Tampilkan Menu Produk Pilihan
async function sendProductMenu(chatId) {
  const menuText = `
<b>🛒 PANZZPAY PAYMENT GATEWAY TEST STORE</b>
<i>Pilih produk yang ingin Anda simulasikan pembayarannya:</i>
  `;

  const inlineKeyboard = {
    inline_keyboard: [
      [{ text: '💎 VIP Membership (Rp 10.000)', callback_data: 'buy_10000' }],
      [{ text: '🚀 Saldo Server Bot (Rp 25.000)', callback_data: 'buy_25000' }],
      [{ text: '🎁 Diamond Game Pack (Rp 50.000)', callback_data: 'buy_50000' }]
    ]
  };

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: menuText,
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard
  });
}

// Proses Pembuatan QRIS PanzzPay & Pengiriman ke Telegram
async function processPaymentCreation(chatId, baseAmount) {
  try {
    console.log(`⚡ Membuat Invoice QRIS PanzzPay sebesar Rp ${baseAmount.toLocaleString('id-ID')}...`);

    const res = await fetch(`${PANZZPAY_API_URL}/api/qris/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_amount: baseAmount, auto_unique: true })
    });

    const data = await res.json();

    if (!data.ok || !data.invoice) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '❌ Gagal membuat QRIS dari server PanzzPay. Silakan coba lagi.'
      });
      return;
    }

    const inv = data.invoice;
    const formattedTotal = inv.total_amount.toLocaleString('id-ID');
    const formattedBase = inv.base_amount.toLocaleString('id-ID');

    const caption = `
<b>🧾 INVOIS PEMBAYARAN PANZZPAY</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>ID Invois:</b> <code>${inv.id}</code>
<b>Harga Produk:</b> Rp ${formattedBase}
<b>Kode Unik:</b> +Rp ${inv.unique_code}
<b>TOTAL BAYAR:</b> <code>Rp ${formattedTotal}</code> 👈 <i>(Wajib Pas)</i>
<b>Status:</b> ⏳ <b>MENUNGGU PEMBAYARAN</b>
━━━━━━━━━━━━━━━━━━━━━━
📲 <b>PETUNJUK PEMBAYARAN:</b>
1. Scan QRIS di atas menggunakan <b>DANA, ShopeePay, GoPay, OVO, m-BCA, BRImo, atau Livin Mandiri</b>.
2. Pastikan nominal pembayaran pas <b>Rp ${formattedTotal}</b>.
3. Setelah bayar, Bot akan otomatis mendeteksi status LUNAS!

<i>(Bisa gunakan tombol 'Tes Webhook' di aplikasi PanzzPay Forwarder untuk simulasi bayar)</i>
    `;

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: '🔄 Cek Status Manual', callback_data: `check_${inv.id}` }]
      ]
    };

    let sendRes;
    if (inv.qr_png_data_url) {
      sendRes = await tgSendPhotoBase64(chatId, inv.qr_png_data_url, caption, inlineKeyboard);
    } else {
      sendRes = await tgApi('sendMessage', {
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
    }

    if (sendRes && sendRes.ok && sendRes.result) {
      const msgId = sendRes.result.message_id;
      startAutoPollingInvoice(chatId, msgId, inv.id, inv.total_amount);
    }

  } catch (err) {
    console.error('❌ Error processPaymentCreation:', err.message);
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `❌ Gagal menghubungi server PanzzPay: ${err.message}`
    });
  }
}

// Auto Polling Status Invoice dari PanzzPay Server
function startAutoPollingInvoice(chatId, messageId, invoiceId, totalAmount) {
  if (activePollers.has(invoiceId)) {
    clearInterval(activePollers.get(invoiceId).timer);
  }

  console.log(`⏱️ Memulai Auto-Polling untuk Invoice: ${invoiceId}...`);

  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${PANZZPAY_API_URL}/api/invoices/${invoiceId}`);
      const data = await res.json();

      if (data.ok && data.invoice) {
        const inv = data.invoice;

        if (inv.status === 'PAID') {
          clearInterval(timer);
          activePollers.delete(invoiceId);

          console.log(`🎉 INVOICE ${invoiceId} SUDAH LUNAS! Mengirim produk ke Telegram...`);

          const successText = `
🎉 <b>PEMBAYARAN BERHASIL DIVALIDASI!</b> ✅
━━━━━━━━━━━━━━━━━━━━━━
<b>ID Invois:</b> <code>${inv.id}</code>
<b>Total Dibayar:</b> Rp ${inv.total_amount.toLocaleString('id-ID')}
<b>Metode Pembayaran:</b> ${inv.payment_source || 'Transfer QRIS'}
<b>Status:</b> 💚 <b>LUNAS & TERVERIFIKASI</b>
━━━━━━━━━━━━━━━━━━━━━━
🎁 <b>PRODUK ANDA:</b>
<code>VIP-LIC-KEY-${Math.random().toString(36).substring(2, 10).toUpperCase()}</code>

<i>Terima kasih telah menggunakan PanzzPay Gateway!</i>
          `;

          await tgApi('sendMessage', {
            chat_id: chatId,
            text: successText,
            parse_mode: 'HTML'
          });
        }
      }
    } catch (e) {
      // ignore temporary polling network error
    }
  }, 4000);

  activePollers.set(invoiceId, { chatId, messageId, timer });
}

// Cek Manual Tombol
async function checkInvoiceStatusManual(chatId, messageId, invoiceId, queryId) {
  try {
    const res = await fetch(`${PANZZPAY_API_URL}/api/invoices/${invoiceId}`);
    const data = await res.json();

    if (data.ok && data.invoice) {
      const inv = data.invoice;
      if (inv.status === 'PAID') {
        await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: '✅ Pembayaran LUNAS!' });
      } else {
        await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: '⏳ Pembayaran belum diterima. Silakan scan QRIS terlebih dahulu.' });
      }
    } else {
      await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: '❓ Status invois tidak ditemukan.' });
    }
  } catch (e) {
    await tgApi('answerCallbackQuery', { callback_query_id: queryId, text: '❌ Gagal mengecek status.' });
  }
}

// START BOT
console.log('🤖 =======================================================');
console.log('🚀 PanzzPay Telegram Bot Test Engine is Running!');
console.log('🤖 =======================================================');
pollUpdates();
