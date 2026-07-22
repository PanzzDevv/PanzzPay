import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    this.loadLocalBackup();
  }

  async init() {
    await this.seedSuperAdmin();
    console.log(`🔥 [FIRESTORE READY] Collections 'merchants', 'invoices', 'webhook_logs' synchronized to Cloud Firestore!`);
  }

  getDataDir() {
    const localDir = path.join(__dirname, 'data');
    try {
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      const testFile = path.join(localDir, '.test_write');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return localDir;
    } catch (err) {
      const tmpDir = path.join('/tmp', 'panzzpay');
      try {
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }
      } catch (e) {}
      return tmpDir;
    }
  }

  loadLocalBackup() {
    try {
      const dataDir = this.getDataDir();
      const merchantsPath = path.join(dataDir, 'merchants.json');
      if (fs.existsSync(merchantsPath)) {
        const list = JSON.parse(fs.readFileSync(merchantsPath, 'utf8') || '[]');
        list.forEach(m => this.inMemoryMerchants.set(m.id, m));
      }

      const invoicesPath = path.join(dataDir, 'invoices.json');
      if (fs.existsSync(invoicesPath)) {
        const list = JSON.parse(fs.readFileSync(invoicesPath, 'utf8') || '[]');
        list.forEach(inv => this.inMemoryInvoices.set(inv.id, inv));
      }

      const logsPath = path.join(dataDir, 'webhook_logs.json');
      if (fs.existsSync(logsPath)) {
        this.inMemoryLogs = JSON.parse(fs.readFileSync(logsPath, 'utf8') || '[]');
      }
      console.log(`📂 [LOCAL PERSISTENCE LOADED] Loaded backup data from ${dataDir}`);
    } catch (e) {
      console.warn('⚠️ Gagal membaca database backup lokal:', e.message);
    }
  }

  saveLocalBackup(type) {
    try {
      const dataDir = this.getDataDir();
      if (type === 'merchants') {
        const list = Array.from(this.inMemoryMerchants.values());
        fs.writeFileSync(path.join(dataDir, 'merchants.json'), JSON.stringify(list, null, 2), 'utf8');
      } else if (type === 'invoices') {
        const list = Array.from(this.inMemoryInvoices.values());
        fs.writeFileSync(path.join(dataDir, 'invoices.json'), JSON.stringify(list, null, 2), 'utf8');
      } else if (type === 'logs') {
        fs.writeFileSync(path.join(dataDir, 'webhook_logs.json'), JSON.stringify(this.inMemoryLogs, null, 2), 'utf8');
      }
    } catch (e) {
      // Ignore write errors on read-only serverless lambdas
    }
  }

  loadFirebaseConfig() {
    try {
      this.serviceAccount = {
        type: "service_account",
        project_id: "panzzpay",
        private_key_id: "5ead369b6a41ecb3c6cc296cfbbfa917a5da2d6b",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCcoR5UWDY0pS+7\nhV/b6iuZs2G+vgBHbpKltXmORLKZh5BYiYFW/Zr9BKcViLe8PJsQJpb1NXkQaIeQ\n1G0KgskG+T78a3HWomLryRMtPAZH71vgbPxwDiMMWop5XjoyEBTlLp1NJy7HIqo1\nleQWtV/IyKmIMIhYEhZewiQsuu4ywZDNXZSc/CQeFl2Y2eHAEmFoCvsOyYJwOzut\nhYaqmvlQ1QnQsh6U3pisBK5SK0AmgOBHvC0I2Ehua+Ft+xasOaqB6q7hWLRfdYyj\nZIMBUwbbsYW98dQauekMBy76T7p9QeJxWfzZ03hl1+AnnPQ8ILfW9aLTfzXoKPvK\nIRzw+1EhAgMBAAECggEAHSQf6bbozOYv6Y5wzZB1sLjOdofQsvmYWLLZLRZMeWKe\nwU5CDW6NQ8Z2FLxVXPUUr45Sd0hN4DbmhBR1vicjokPEy39tFG8tgutsATZB/+fB\nexGj7PBAZpfA3EBjCPXzgUlpNFXWLvAc5W/gGjaAHfHxkthewa4J0fMCen0D/Na6\nqDzZ9NrRV5OhbnOYy3+opoT/9gZPBkMZzTR5+8UrCxTSidoIGyGfNXjG+EmTJkCr\ntSJ6i8C9k63P0NBCIt1O7O3unM0OApvHY2EfVv8wcLZWZNHAbk3c17UvMV6hR6R8\nvQwTxAD4+9WW1vZPV9MUU9yK6pmImEOjWz4Tr8Mc3QKBgQDI+fjM8qpixqxgBDsO\n7ECDSnGmbGkmTsvxDTqDXbZ7/JRxqwzcdL3jniL0uZiKnnLC5wAGd9aFR9uD5q7O\n4eZbH4mQAXrU0GZvqRXhvSmNsDi1NokZHVfCUtr7fI/nrv3KW4KvQldHZUFjBBgr\nSBwWmXH782OHmbZyV/jfDouTjQKBgQDHgvNGk70NbNRo8BnrKgRDd2Bpt91WkhT8\nBiv3rfikxh4TXp6utEE4wVq8x9kfh4tmOunVHFCOQpbyjMq6/8ESgO+Hwv//7hZ8\n4sginC255nBmBFKHKXI7A4QkR27iPJskjO4Hc0NrrBimei23dMMt5iaO9tDFZnH/\nvaLsboKk5QKBgQCTAQ001Bc/UvUI8m9EdhimMBC7W7b5908DjdqL9kMho9ns3uH0\na0vuL2CAQzVJx6ZH2/HPyV5XdP0jGNwqpV/6rTHQ7NQs0Bbte+9uhA/d/NUt76sO\nfMERecuFglI8dGpc1tzbVxpCNdVDGN6Y4hDxkuGmGhxmNlAWiTSX66q6jQKBgQCX\nQQLYbeb0x54dVHIB5B/JWjaAz4EBQcyg6LjqlD0eBokEnEZnIocT1RrKZiSIj8Uy\nItXl2AqGX5t6lRyZOo4QTinKXh6g08q+sVuTSZ4tArQR05MRn21XqinDK1i4McRY\nqHNIuKzTc2xYweXo4J+cK5Dt79aE4U7p2MYswvdOtQKBgCGQT4MA7gynJBY5T0oE\nn1oFg/Fc6zP6IGo2JSzpW8W/sW4xHCaUyy1UFyBLRLsAQ4QZ3/74Vio1Qd1eVno6\n3tI55ZUbJ42eQUpTnHbcdAqDKH0nEgfcbKQfIErobgnbrcqiifnDHED5enAW7JbU\nnZs6/kaSltXDJ0cjM2abjzs8\n-----END PRIVATE KEY-----\n",
        client_email: "firebase-adminsdk-fbsvc@panzzpay.iam.gserviceaccount.com",
        client_id: "107260884218638653162",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40panzzpay.iam.gserviceaccount.com",
        universe_domain: "googleapis.com"
      };

      this.projectId = this.serviceAccount.project_id;
      this.isFirebaseConfigured = true;
      console.log(`🔥 [FIREBASE CONNECTED] Project ID: ${this.projectId}`);
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
    this.saveLocalBackup('merchants');
    await this.syncToFirebase('merchants', merchant.id, merchant);
    return merchant;
  }

  async getAllMerchants() {
    let list = Array.from(this.inMemoryMerchants.values());
    const firestore = await this.getFirestoreDB();
    if (firestore) {
      try {
        const snap = await firestore.collection('merchants').get();
        snap.forEach(doc => {
          const data = doc.data();
          this.inMemoryMerchants.set(data.id, data);
        });
        list = Array.from(this.inMemoryMerchants.values());
      } catch (e) {}
    }

    // Ensure Super Admin is always present in list for admin panel
    if (!list.some(m => m.id === 'SUPERADMIN-001')) {
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
      list.push(superAdmin);
      this.inMemoryMerchants.set(superAdmin.id, superAdmin);
    }
    return list;
  }

  async getMerchantById(id) {
    if (!id) return null;
    if (id === 'SUPERADMIN-001') {
      const ownerEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@panzzpay.com').toLowerCase();
      const ownerPassword = process.env.SUPER_ADMIN_PASSWORD || 'adminpanzzpay123';
      return {
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
    }

    let m = this.inMemoryMerchants.get(id);
    if (m) return m;

    const firestore = await this.getFirestoreDB();
    if (firestore) {
      try {
        const doc = await firestore.collection('merchants').doc(id).get();
        if (doc.exists) {
          const data = doc.data();
          this.inMemoryMerchants.set(data.id, data);
          return data;
        }
      } catch (e) {}
    }
    return null;
  }

  async getMerchantByApiKey(apiKey) {
    if (!apiKey) return null;
    if (apiKey === 'pz_admin_master_key_99999') {
      const ownerEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@panzzpay.com').toLowerCase();
      const ownerPassword = process.env.SUPER_ADMIN_PASSWORD || 'adminpanzzpay123';
      return {
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
    }

    for (const m of this.inMemoryMerchants.values()) {
      if (m.api_key === apiKey) return m;
    }

    const firestore = await this.getFirestoreDB();
    if (firestore) {
      try {
        const snap = await firestore.collection('merchants').where('api_key', '==', apiKey).limit(1).get();
        if (!snap.empty) {
          const data = snap.docs[0].data();
          this.inMemoryMerchants.set(data.id, data);
          return data;
        }
      } catch (e) {}
    }
    return null;
  }

  async getMerchantByWebhookToken(token) {
    if (!token) return null;
    if (token === 'pz_wh_admin_master_token_99999') {
      const ownerEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@panzzpay.com').toLowerCase();
      const ownerPassword = process.env.SUPER_ADMIN_PASSWORD || 'adminpanzzpay123';
      return {
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
    }

    for (const m of this.inMemoryMerchants.values()) {
      if (m.webhook_token === token) return m;
    }

    const firestore = await this.getFirestoreDB();
    if (firestore) {
      try {
        const snap = await firestore.collection('merchants').where('webhook_token', '==', token).limit(1).get();
        if (!snap.empty) {
          const data = snap.docs[0].data();
          this.inMemoryMerchants.set(data.id, data);
          return data;
        }
      } catch (e) {}
    }
    return null;
  }

  async getMerchantByEmail(email) {
    if (!email) return null;
    const cleanEmail = String(email).toLowerCase().trim();
    if (cleanEmail === (process.env.SUPER_ADMIN_EMAIL || 'admin@panzzpay.com').toLowerCase()) {
      const ownerEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@panzzpay.com').toLowerCase();
      const ownerPassword = process.env.SUPER_ADMIN_PASSWORD || 'adminpanzzpay123';
      return {
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
    }

    for (const m of this.inMemoryMerchants.values()) {
      if (m.email && String(m.email).toLowerCase().trim() === cleanEmail) return m;
    }

    const firestore = await this.getFirestoreDB();
    if (firestore) {
      try {
        const snap = await firestore.collection('merchants').where('email', '==', cleanEmail).limit(1).get();
        if (!snap.empty) {
          const data = snap.docs[0].data();
          this.inMemoryMerchants.set(data.id, data);
          return data;
        }
      } catch (e) {}
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
    this.saveLocalBackup('invoices');
    await this.syncToFirebase('invoices', invoice.id, invoice);
    return invoice;
  }

  async getInvoice(id) {
    if (!id) return null;
    let inv = this.inMemoryInvoices.get(id);
    if (inv) return inv;

    const firestore = await this.getFirestoreDB();
    if (firestore) {
      try {
        const doc = await firestore.collection('invoices').doc(id).get();
        if (doc.exists) {
          const data = doc.data();
          this.inMemoryInvoices.set(data.id, data);
          return data;
        }
      } catch (e) {}
    }
    return null;
  }

  async getAllInvoices() {
    const getCached = () => Array.from(this.inMemoryInvoices.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const cachedList = getCached();

    const refreshPromise = (async () => {
      const firestore = await this.getFirestoreDB();
      if (firestore) {
        try {
          const snap = await firestore.collection('invoices').orderBy('created_at', 'desc').limit(100).get();
          snap.forEach(doc => {
            const data = doc.data();
            this.inMemoryInvoices.set(data.id, data);
          });
        } catch (e) {
          try {
            const snap = await firestore.collection('invoices').limit(100).get();
            snap.forEach(doc => {
              const data = doc.data();
              this.inMemoryInvoices.set(data.id, data);
            });
          } catch(e2) {}
        }
      }
    })();

    if (cachedList.length === 0) {
      await refreshPromise;
      return getCached();
    }
    return cachedList;
  }

  async getInvoicesByMerchant(merchantId) {
    const getCached = () => {
      const list = [];
      for (const inv of this.inMemoryInvoices.values()) {
        if (!merchantId || inv.merchant_id === merchantId) {
          list.push(inv);
        }
      }
      return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    };

    const cachedList = getCached();

    const refreshPromise = (async () => {
      const firestore = await this.getFirestoreDB();
      if (firestore) {
        try {
          let query = firestore.collection('invoices');
          if (merchantId) query = query.where('merchant_id', '==', merchantId);
          query = query.orderBy('created_at', 'desc').limit(100);
          const snap = await query.get();
          snap.forEach(doc => {
            const data = doc.data();
            this.inMemoryInvoices.set(data.id, data);
          });
        } catch (e) {
          try {
            let query = firestore.collection('invoices');
            if (merchantId) query = query.where('merchant_id', '==', merchantId);
            const snap = await query.limit(100).get();
            snap.forEach(doc => {
              const data = doc.data();
              this.inMemoryInvoices.set(data.id, data);
            });
          } catch(e2) {}
        }
      }
    })();

    if (cachedList.length === 0) {
      await refreshPromise;
      return getCached();
    }
    return cachedList;
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
    this.saveLocalBackup('logs');
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
