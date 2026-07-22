import { db } from './firebase.js';

async function checkFirestore() {
  const health = await db.getHealth(true);
  if (!health.ok) {
    console.error('Firestore belum terhubung:');
    console.error(JSON.stringify(health, null, 2));
    process.exitCode = 1;
    return;
  }

  const [merchants, invoices, webhookLogs] = await Promise.all([
    db.getAllMerchants(),
    db.getAllInvoices(),
    db.getAllWebhookLogs()
  ]);

  console.log(JSON.stringify({
    ok: true,
    projectId: health.projectId,
    collections: {
      merchants: merchants.length,
      invoices: invoices.length,
      webhook_logs: webhookLogs.length
    }
  }, null, 2));
}

checkFirestore().catch(error => {
  console.error('Pemeriksaan Firestore gagal:', error.message);
  process.exitCode = 1;
});
