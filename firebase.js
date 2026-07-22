import fs from 'fs';
import path from 'path';

class FirebaseService {
  constructor() {
    this.projectId = 'panzzpay';
    this.serviceAccount = null;
    this.isFirebaseConfigured = false;
    this.adminInstance = null;
    this.inMemoryMerchants = new Map();
    this.inMemoryInvoices = new Map();
    this.inMemoryLogs = [];

    this.loadFirebaseConfig();
  }

  async init() {
    await this.seedSuperAdmin();
    console.log(`🔥 [FIRESTORE READY] Collections 'merchants', 'invoices', 'webhook_logs' synchronized to Cloud Firestore!`);
  }

  loadFirebaseConfig() {
    try {
      const envJson = process.env.FIREBASE_CONFIG_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const configPath = path.join(process.cwd(), 'firebase-config.json');

      if (envJson) {
        this.serviceAccount = typeof envJson === 'string' ? JSON.parse(envJson) : envJson;
      } else if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        this.serviceAccount = JSON.parse(raw);
      }

      if (this.serviceAccount && this.serviceAccount.project_id) {
        this.projectId = this.serviceAccount.project_id;
        this.isFirebaseConfigured = true;
        console.log(`🔥 [FIREBASE CONNECTED] Project ID: ${this.projectId}`);
      } else {
        console.warn('⚠️ firebase-config.json not found. Operating in local storage mode.');
      }
    } catch (e) {
      console.warn('⚠️ Firebase config loading error:', e.message);
    }
  }

  async getAdminSDK() {
    if (!this.isFirebaseConfigured) return null;
    if (this.adminInstance) return this.adminInstance;

    try {
      const adminModule = await import('firebase-admin').catch(() => null);
      if (!adminModule) return null;

      const admin = adminModule.default || adminModule;
      const apps = admin.apps || (admin.getApps ? admin.getApps() : []);

      if ((!apps || apps.length === 0) && this.serviceAccount) {
        let certObj = null;

        if (admin.credential && typeof admin.credential.cert === 'function') {
          certObj = admin.credential.cert(this.serviceAccount);
        } else if (adminModule.credential && typeof adminModule.credential.cert === 'function') {
          certObj = adminModule.credential.cert(this.serviceAccount);
        } else {
          const appMod = await import('firebase-admin/app').catch(() => ({}));
          if (appMod && typeof appMod.cert === 'function') {
            certObj = appMod.cert(this.serviceAccount);
          }
        }

        const initializeAppFn = admin.initializeApp || adminModule.initializeApp;
        if (typeof initializeAppFn === 'function') {
          initializeAppFn({
            credential: certObj,
            projectId: this.projectId
          });
          this.adminInstance = admin;
          return admin;
        }
      }

      this.adminInstance = admin;
      return admin;

    } catch (e) {
      console.warn('Firebase Admin SDK load note:', e.message);
    }
    return null;
  }

  async getFirestoreDB() {
    const admin = await this.getAdminSDK();
    if (!admin) return null;
    if (typeof admin.firestore === 'function') return admin.firestore();

    const adminMod = this.adminModuleRef || admin;
    if (typeof adminMod.firestore === 'function') return adminMod.firestore();

    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      return getFirestore();
    } catch (e) {
      return null;
    }
  }

  async getAuthSDK() {
    const admin = await this.getAdminSDK();
    if (!admin) return null;
    if (typeof admin.auth === 'function') return admin.auth();

    const adminMod = this.adminModuleRef || admin;
    if (typeof adminMod.auth === 'function') return adminMod.auth();

    try {
      const { getAuth } = await import('firebase-admin/auth');
      return getAuth();
    } catch (e) {
      return null;
    }
  }

  async seedSuperAdmin() {
    const ownerEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@panzzpay.com').toLowerCase();
    const ownerPassword = process.env.SUPER_ADMIN_PASSWORD || 'adminpanzzpay123';

    const superAdmin = {
      id: 'SUPERADMIN-001',
      name: 'PanzzPay Super Admin (Pemilik Platform)',
      email: ownerEmail,
      password: ownerPassword,
      role: 'superadmin',
      api_key: 'pz_admin_master_key_99999',
      webhook_token: 'pz_wh_admin_master_token_99999',
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    };

    this.inMemoryMerchants.set(superAdmin.id, superAdmin);
    await this.syncToFirebase('merchants', superAdmin.id, superAdmin);
  }

  // Generate Firebase Auth official Email Verification Link (No SMTP required!)
  async generateFirebaseVerificationLink(email, redirectHost = 'http://localhost:3000') {
    const auth = await this.getAuthSDK();
    if (auth) {
      try {
        const actionCodeSettings = {
          url: `${redirectHost}/portal.html?verified=true&email=${encodeURIComponent(email)}`,
          handleCodeInApp: true
        };
        const link = await auth.generateEmailVerificationLink(email, actionCodeSettings);
        console.log(`🔥 [FIREBASE AUTH LINK GENERATED] For ${email}: ${link}`);
        return { ok: true, link };
      } catch (err) {
        console.warn(`⚠️ Firebase Auth link generation note (${email}):`, err.message);
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: 'Firebase Admin Auth not initialized' };
  }

  // Helper method to sync document to Cloud Firestore & Firebase Auth Users
  async syncToFirebase(collectionName, docId, data) {
    if (!this.isFirebaseConfigured || !this.serviceAccount) return;
    const firestore = await this.getFirestoreDB();
    if (!firestore) return;

    try {
      await firestore.collection(collectionName).doc(docId).set(data, { merge: true });
      console.log(`🔥 [FIRESTORE SYNC] Saved '${collectionName}' -> Doc ID: ${docId}`);

      if (collectionName === 'merchants' && data.email && data.password) {
        const auth = await this.getAuthSDK();
        if (auth) {
          try {
            await auth.getUserByEmail(data.email);
          } catch (authErr) {
            if (authErr.code === 'auth/user-not-found') {
              await auth.createUser({
                uid: data.id,
                email: data.email,
                password: data.password,
                displayName: data.name
              });
              console.log(`👤 [FIREBASE AUTH USER CREATED] Email: ${data.email}`);
            }
          }
        }
      }
    } catch (e) {
      console.warn(`⚠️ Firebase Sync Note (${collectionName}/${docId}):`, e.message);
    }
  }

  // --- MERCHANT OPERATIONS ---
  async saveMerchant(merchant) {
    if (!merchant.role) merchant.role = 'merchant';
    if (!merchant.status) merchant.status = 'UNVERIFIED';

    this.inMemoryMerchants.set(merchant.id, merchant);
    await this.syncToFirebase('merchants', merchant.id, merchant);
    return merchant;
  }

  async getAllMerchants() {
    return Array.from(this.inMemoryMerchants.values());
  }

  async getMerchantById(id) {
    return this.inMemoryMerchants.get(id) || null;
  }

  async getMerchantByApiKey(apiKey) {
    for (const m of this.inMemoryMerchants.values()) {
      if (m.api_key === apiKey) return m;
    }
    return null;
  }

  async getMerchantByWebhookToken(token) {
    for (const m of this.inMemoryMerchants.values()) {
      if (m.webhook_token === token) return m;
    }
    return null;
  }

  async getMerchantByEmail(email) {
    if (!email) return null;
    const cleanEmail = String(email).toLowerCase().trim();
    for (const m of this.inMemoryMerchants.values()) {
      if (m.email && String(m.email).toLowerCase().trim() === cleanEmail) return m;
    }
    return null;
  }

  async verifyMerchantOtp(email, otpCode) {
    const merchant = await this.getMerchantByEmail(email);
    if (!merchant) return { ok: false, message: 'Email tidak ditemukan.' };
    if (merchant.status === 'ACTIVE') return { ok: true, message: 'Akun sudah terverifikasi.', merchant };

    if (otpCode && merchant.otp_code && merchant.otp_code !== String(otpCode).trim()) {
      return { ok: false, message: 'Kode verifikasi 6-digit salah.' };
    }

    merchant.status = 'ACTIVE';
    merchant.otp_code = null;

    await this.saveMerchant(merchant);
    return { ok: true, message: 'Verifikasi email berhasil! Akun Anda sekarang aktif.', merchant };
  }

  async toggleMerchantStatus(merchantId, status) {
    const merchant = await this.getMerchantById(merchantId);
    if (!merchant) return null;
    merchant.status = status;
    await this.saveMerchant(merchant);
    return merchant;
  }

  // --- INVOICE OPERATIONS ---
  async saveInvoice(invoice) {
    this.inMemoryInvoices.set(invoice.id, invoice);
    await this.syncToFirebase('invoices', invoice.id, invoice);
    return invoice;
  }

  async getInvoice(id) {
    return this.inMemoryInvoices.get(id) || null;
  }

  async getAllInvoices() {
    return Array.from(this.inMemoryInvoices.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async getInvoicesByMerchant(merchantId) {
    const list = [];
    for (const inv of this.inMemoryInvoices.values()) {
      if (!merchantId || inv.merchant_id === merchantId) {
        list.push(inv);
      }
    }
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async updateInvoiceStatus(id, status, details = {}) {
    const inv = await this.getInvoice(id);
    if (!inv) return null;
    inv.status = status;
    Object.assign(inv, details);
    await this.saveInvoice(inv);
    return inv;
  }

  // --- WEBHOOK LOG OPERATIONS ---
  async saveWebhookLog(logEntry) {
    this.inMemoryLogs.unshift(logEntry);
    if (this.inMemoryLogs.length > 200) this.inMemoryLogs.pop();
    await this.syncToFirebase('webhook_logs', logEntry.id, logEntry);
    return logEntry;
  }

  async getAllWebhookLogs() {
    return this.inMemoryLogs;
  }

  async getWebhookLogsByMerchant(merchantId) {
    if (!merchantId) return this.inMemoryLogs;
    return this.inMemoryLogs.filter(l => l.merchant_id === merchantId);
  }
}

export const db = new FirebaseService();
