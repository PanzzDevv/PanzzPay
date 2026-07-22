import { db } from './firebase.js';

async function test() {
  console.log('Testing Firestore write...');
  try {
    const res = await db.saveMerchant({
      id: 'SUPERADMIN-001',
      name: 'PanzzPay Super Admin (Pemilik Platform)',
      email: 'admin@panzzpay.com',
      password: 'adminpanzzpay123',
      role: 'superadmin',
      api_key: 'pz_admin_master_key_99999',
      webhook_token: 'pz_wh_admin_master_token_99999',
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    });

    await db.saveInvoice({
      id: 'INV-TEST-001',
      merchant_id: 'SUPERADMIN-001',
      base_amount: 10000,
      unique_code: 123,
      total_amount: 10123,
      status: 'PENDING',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });

    console.log('✅ [TEST SUCCESS] Firestore collections written!');
  } catch (err) {
    console.error('❌ [TEST ERROR]:', err);
  }
  process.exit(0);
}

test();
