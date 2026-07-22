/**
 * ==============================================================================
 * PANZZPAY BOT PAYMENT TESTER & SIMULATOR SCRIPT
 * ==============================================================================
 * Script ini mensimulasikan Alur Pembayaran Lengkap pada Bot (Telegram/WhatsApp/Web)
 * menggunakan API PanzzPay Gateway.
 * 
 * Cara Menjalankan:
 *   node test_payment_bot.js
 * ==============================================================================
 */

import http from 'http';

// Ganti SERVER_URL dengan server PanzzPay Anda (lokal atau live Vercel)
const PANZZPAY_SERVER = process.env.PANZZPAY_SERVER || 'http://localhost:3000';
const BOT_WEBHOOK_PORT = 4000;

console.log(`
===================================================================
🤖 PANZZPAY BOT PAYMENT GATEWAY TESTER & SIMULATOR
===================================================================
Target Server PanzzPay: ${PANZZPAY_SERVER}
Port Webhook Bot     : ${BOT_WEBHOOK_PORT}
===================================================================
`);

// ------------------------------------------------------------------
// 1. MEMBUAT SERVER LISTENER WEBHOOK BOT LOKAL (PORT 4000)
// ------------------------------------------------------------------
const botServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook/bot-callback') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        console.log('\n===================================================================');
        console.log('⚡ [BOT RECEIVED WEBHOOK CALLBACK FROM PANZZPAY!]');
        console.log('===================================================================');
        console.log('📥 Data Callback Diterima Bot:', JSON.stringify(payload, null, 2));
        
        if (payload.matched_invoice) {
          console.log('\n🎉 [SUKSES DISAMPAIKAN KE BOT!]');
          console.log(`✅ Invoice ID      : ${payload.matched_invoice.id}`);
          console.log(`✅ Total Lunas      : Rp ${payload.matched_invoice.total_amount.toLocaleString('id-ID')}`);
          console.log(`✅ Sumber Pembayaran: ${payload.source}`);
          console.log('📦 BOT OTOMATIS MENGIRIM PRODUK / LISENSI KE PELANGGAN! 🚀');
        } else {
          console.log('ℹ️ Webhook diterima, tetapi belum match dengan invoice pending.');
        }
        console.log('===================================================================\n');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Callback diterima Bot' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

botServer.listen(BOT_WEBHOOK_PORT, async () => {
  console.log(`📡 [STEP 1] Webhook Receiver Bot aktif di http://localhost:${BOT_WEBHOOK_PORT}/webhook/bot-callback\n`);
  
  // Jalankan simulasi transaksi
  runPaymentSimulation();
});

// ------------------------------------------------------------------
// 2. SIMULASI ALUR PEMBAYARAN BOT
// ------------------------------------------------------------------
async function runPaymentSimulation() {
  try {
    const baseAmount = 25000;
    console.log(`🛒 [STEP 2] Pelanggan meminta pembayaran produk seharga Rp ${baseAmount.toLocaleString('id-ID')}...`);

    // A. Memanggil API PanzzPay untuk membuat Dynamic QRIS & Kode Unik
    const createRes = await fetch(`${PANZZPAY_SERVER}/api/qris/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_amount: baseAmount,
        auto_unique: true
      })
    });

    const createData = await createRes.json();
    if (!createData.ok) {
      console.error('❌ Gagal membuat invoice PanzzPay:', createData.message);
      process.exit(1);
    }

    const invoice = createData.invoice;
    console.log(`\n📄 [STEP 3] Invoice Berhasil Dibuat oleh PanzzPay:`);
    console.log(`   • Invoice ID   : ${invoice.id}`);
    console.log(`   • Harga Dasar  : Rp ${invoice.base_amount.toLocaleString('id-ID')}`);
    console.log(`   • Kode Unik    : ${invoice.unique_code}`);
    console.log(`   • Total Tagihan: Rp ${invoice.total_amount.toLocaleString('id-ID')} 🔥`);
    console.log(`   • Expired      : ${invoice.expires_at}`);
    console.log(`   • String QRIS  : ${invoice.payload.substring(0, 45)}...`);

    console.log('\n📲 [STEP 4] Bot menampilkan QRIS & instruksi ke Pelanggan:');
    console.log(`   "Silakan scan QRIS dan transfer tepat sejumlah Rp ${invoice.total_amount.toLocaleString('id-ID')} via DANA/ShopeePay/BCA"`);

    // B. Simulasikan Pembayaran Masuk dari Aplikasi HP (ShopeePay / DANA)
    console.log('\n⏳ Menunggu simulasi transfer uang masuk (3 detik)...');
    await new Promise(r => setTimeout(r, 3000));

    console.log(`\n📲 [STEP 5] Mensimulasikan notifikasi payment masuk sebesar Rp ${invoice.total_amount.toLocaleString('id-ID')} dari ShopeePay...`);

    const webhookPayload = {
      title: "Transfer Masuk",
      message: `Pembayaran QRIS Rp ${invoice.total_amount.toLocaleString('id-ID')} dari ShopeePay diterima`,
      package_name: "com.shopeepay.id",
      source: "PanzzPay Bot Test Simulation",
      timestamp: Date.now()
    };

    const callbackRes = await fetch(`${PANZZPAY_SERVER}/api/webhook/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload)
    });

    const callbackData = await callbackRes.json();
    console.log(`⚡ [STEP 6] Respon dari Webhook Gateway PanzzPay:`, callbackData.message);

    // Selesai pengujian
    setTimeout(() => {
      console.log('✅ Uji Coba Pembayaran Bot Selesai dengan Sukses!');
      botServer.close();
      process.exit(0);
    }, 1500);

  } catch (err) {
    console.error('❌ Error simulasi bot payment:', err.message);
    botServer.close();
    process.exit(1);
  }
}
