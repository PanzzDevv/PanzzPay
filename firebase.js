import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COLLECTIONS = Object.freeze({
  merchants: 'merchants',
  invoices: 'invoices',
  webhookLogs: 'webhook_logs'
});

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizePrivateKey(value) {
  return value ? String(value).replace(/\\n/g, '\n').trim() : '';
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} bukan JSON yang valid: ${error.message}`);
  }
}

function cleanFirestoreData(value) {
  if (Array.isArray(value)) {
    return value.map(cleanFirestoreData).filter(item => item !== undefined);
  }

  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, cleanFirestoreData(item)])
    );
  }

  return value;
}

function documentData(document) {
  const data = document.data();
  return { ...data, id: data.id || document.id };
}

export class FirebaseService {
  constructor(options = {}) {
    this.projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'panzzpay';
    this.serviceAccount = null;
    this.configSource = 'none';
    this.isFirebaseConfigured = false;
    this.firebaseRequired = parseBoolean(process.env.FIREBASE_REQUIRED, false);
    this.adminApp = null;
    this.firestoreInstance = options.firestore || null;
    this.authInstance = options.auth || null;
    this.lastFirebaseError = null;
    this.lastSuccessfulConnectionAt = null;
    this.skipLocalBackup = Boolean(options.skipLocalBackup);
    this.inMemoryMerchants = new Map();
    this.inMemoryInvoices = new Map();
    this.inMemoryLogs = [];

    if (this.firestoreInstance || this.authInstance) {
      this.isFirebaseConfigured = true;
      this.configSource = 'injected';
    } else {
      this.loadFirebaseConfig(options.serviceAccount);
    }

    if (!this.skipLocalBackup) this.loadLocalBackup();
  }

  loadFirebaseConfig(explicitServiceAccount = null) {
    try {
      let serviceAccount = explicitServiceAccount;
      let source = explicitServiceAccount ? 'constructor' : 'none';

      if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        serviceAccount = parseJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON, 'FIREBASE_SERVICE_ACCOUNT_JSON');
        source = 'FIREBASE_SERVICE_ACCOUNT_JSON';
      }

      if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
        serviceAccount = parseJson(decoded, 'FIREBASE_SERVICE_ACCOUNT_BASE64');
        source = 'FIREBASE_SERVICE_ACCOUNT_BASE64';
      }

      if (!serviceAccount && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        serviceAccount = {
          type: 'service_account',
          project_id: this.projectId,
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
          private_key: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
        };
        source = 'FIREBASE_* environment variables';
      }

      const localConfigPath = path.join(__dirname, 'firebase-config.json');
      if (!serviceAccount && fs.existsSync(localConfigPath)) {
        serviceAccount = parseJson(fs.readFileSync(localConfigPath, 'utf8'), 'firebase-config.json');
        source = 'firebase-config.json';
      }

      if (serviceAccount) {
        serviceAccount.private_key = normalizePrivateKey(serviceAccount.private_key);
        if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
          throw new Error('Service account wajib memiliki project_id, client_email, dan private_key');
        }
        this.serviceAccount = serviceAccount;
        this.projectId = serviceAccount.project_id;
        this.isFirebaseConfigured = true;
        this.configSource = source;
      } else if (
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.FIREBASE_CONFIG ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT
      ) {
        this.isFirebaseConfigured = true;
        this.configSource = 'Application Default Credentials';
      }

      if (this.isFirebaseConfigured) {
        console.log(`[FIREBASE CONFIGURED] Project: ${this.projectId}; source: ${this.configSource}`);
      } else {
        console.warn('[FIREBASE NOT CONFIGURED] Using local fallback. Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.');
      }
    } catch (error) {
      this.recordFirebaseError('configuration', error);
      if (this.firebaseRequired) throw error;
    }
  }

  getDataDir() {
    const localDir = path.join(__dirname, 'data');
    try {
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const testFile = path.join(localDir, '.test_write');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return localDir;
    } catch {
      const tmpDir = path.join('/tmp', 'panzzpay');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      return tmpDir;
    }
  }

  loadLocalBackup() {
    try {
      const dataDir = this.getDataDir();
      const files = {
        merchants: path.join(dataDir, 'merchants.json'),
        invoices: path.join(dataDir, 'invoices.json'),
        logs: path.join(dataDir, 'webhook_logs.json')
      };

      if (fs.existsSync(files.merchants)) {
        const merchants = JSON.parse(fs.readFileSync(files.merchants, 'utf8') || '[]');
        merchants.forEach(merchant => this.inMemoryMerchants.set(merchant.id, merchant));
      }
      if (fs.existsSync(files.invoices)) {
        const invoices = JSON.parse(fs.readFileSync(files.invoices, 'utf8') || '[]');
        invoices.forEach(invoice => this.inMemoryInvoices.set(invoice.id, invoice));
      }
      if (fs.existsSync(files.logs)) {
        this.inMemoryLogs = JSON.parse(fs.readFileSync(files.logs, 'utf8') || '[]');
      }
    } catch (error) {
      console.warn('[LOCAL BACKUP READ FAILED]', error.message);
    }
  }

  saveLocalBackup(type) {
    if (this.skipLocalBackup) return;
    try {
      const dataDir = this.getDataDir();
      if (type === 'merchants') {
        fs.writeFileSync(
          path.join(dataDir, 'merchants.json'),
          JSON.stringify(Array.from(this.inMemoryMerchants.values()), null, 2),
          'utf8'
        );
      } else if (type === 'invoices') {
        fs.writeFileSync(
          path.join(dataDir, 'invoices.json'),
          JSON.stringify(Array.from(this.inMemoryInvoices.values()), null, 2),
          'utf8'
        );
      } else if (type === 'logs') {
        fs.writeFileSync(
          path.join(dataDir, 'webhook_logs.json'),
          JSON.stringify(this.inMemoryLogs, null, 2),
          'utf8'
        );
      }
    } catch (error) {
      console.warn('[LOCAL BACKUP WRITE FAILED]', error.message);
    }
  }

  recordFirebaseError(context, error) {
    this.lastFirebaseError = {
      context,
      code: error?.code || null,
      message: error?.message || String(error),
      at: new Date().toISOString()
    };
    console.warn(`[FIREBASE ERROR] ${context}:`, this.lastFirebaseError.message);
  }

  async getAdminApp() {
    if (this.adminApp) return this.adminApp;
    if (!this.isFirebaseConfigured || this.configSource === 'injected') return null;

    try {
      const { applicationDefault, cert, getApps, initializeApp } = await import('firebase-admin/app');
      const existingApp = getApps()[0];
      if (existingApp) {
        this.adminApp = existingApp;
        return existingApp;
      }

      const options = { projectId: this.projectId };
      options.credential = this.serviceAccount ? cert(this.serviceAccount) : applicationDefault();
      this.adminApp = initializeApp(options);
      return this.adminApp;
    } catch (error) {
      this.recordFirebaseError('Admin SDK initialization', error);
      if (this.firebaseRequired) throw error;
      return null;
    }
  }

  async getFirestoreDB() {
    if (this.firestoreInstance) return this.firestoreInstance;
    const app = await this.getAdminApp();
    if (!app) return null;

    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      this.firestoreInstance = getFirestore(app);
      this.firestoreInstance.settings({ ignoreUndefinedProperties: true });
      return this.firestoreInstance;
    } catch (error) {
      this.recordFirebaseError('Firestore initialization', error);
      if (this.firebaseRequired) throw error;
      return null;
    }
  }

  async getAuthSDK() {
    if (this.authInstance) return this.authInstance;
    const app = await this.getAdminApp();
    if (!app) return null;

    try {
      const { getAuth } = await import('firebase-admin/auth');
      this.authInstance = getAuth(app);
      return this.authInstance;
    } catch (error) {
      this.recordFirebaseError('Firebase Auth initialization', error);
      if (this.firebaseRequired) throw error;
      return null;
    }
  }

  async probeConnection() {
    if (!this.isFirebaseConfigured) {
      const error = new Error('Firebase wajib aktif tetapi kredensial belum dikonfigurasi');
      this.recordFirebaseError('connection probe', error);
      if (this.firebaseRequired) throw error;
      return false;
    }
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return false;
      await firestore.collection(COLLECTIONS.merchants).limit(1).get();
      this.lastSuccessfulConnectionAt = new Date().toISOString();
      this.lastFirebaseError = null;
      return true;
    } catch (error) {
      this.recordFirebaseError('connection probe', error);
      if (this.firebaseRequired) throw error;
      return false;
    }
  }

  async getHealth(probe = false) {
    const connected = probe ? await this.probeConnection() : Boolean(this.lastSuccessfulConnectionAt);
    return {
      ok: connected,
      status: connected ? 'connected' : (this.isFirebaseConfigured ? 'degraded' : 'unconfigured'),
      projectId: this.projectId,
      configSource: this.configSource,
      lastSuccessfulConnectionAt: this.lastSuccessfulConnectionAt,
      lastError: this.lastFirebaseError
    };
  }

  getClientConfig() {
    let webConfig = {};
    if (process.env.FIREBASE_WEB_CONFIG) {
      try {
        webConfig = parseJson(process.env.FIREBASE_WEB_CONFIG, 'FIREBASE_WEB_CONFIG');
      } catch (error) {
        this.recordFirebaseError('web configuration', error);
      }
    }

    const projectId = webConfig.projectId || process.env.FIREBASE_PROJECT_ID || this.projectId;
    return {
      apiKey: webConfig.apiKey || process.env.FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
      authDomain: webConfig.authDomain || process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
      projectId,
      storageBucket: webConfig.storageBucket || process.env.FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: webConfig.messagingSenderId || process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: webConfig.appId || process.env.FIREBASE_APP_ID || ''
    };
  }

  buildSuperAdmin() {
    return {
      id: 'SUPERADMIN-001',
      name: 'PanzzPay Super Admin (Pemilik Platform)',
      email: (process.env.SUPER_ADMIN_EMAIL || 'admin@panzzpay.com').toLowerCase(),
      password: process.env.SUPER_ADMIN_PASSWORD || 'adminpanzzpay123',
      role: 'superadmin',
      api_key: process.env.SUPER_ADMIN_API_KEY || 'pz_admin_master_key_99999',
      webhook_token: process.env.SUPER_ADMIN_WEBHOOK_TOKEN || 'pz_wh_admin_master_token_99999',
      status: 'ACTIVE',
      created_at: this.inMemoryMerchants.get('SUPERADMIN-001')?.created_at || new Date().toISOString()
    };
  }

  async init() {
    const connected = await this.probeConnection();
    await this.seedSuperAdmin();
    console.log(connected
      ? `[FIRESTORE READY] ${Object.values(COLLECTIONS).join(', ')}`
      : '[FIRESTORE FALLBACK] Cloud unavailable; local persistence remains active.');
    return this.getHealth(false);
  }

  async seedSuperAdmin() {
    const superAdmin = this.buildSuperAdmin();
    this.inMemoryMerchants.set(superAdmin.id, superAdmin);
    this.saveLocalBackup('merchants');
    await this.syncToFirebase(COLLECTIONS.merchants, superAdmin.id, superAdmin);
  }

  async generateFirebaseVerificationLink(email, redirectHost = 'http://localhost:3000') {
    const auth = await this.getAuthSDK();
    if (!auth) return { ok: false, error: 'Firebase Auth belum terhubung' };

    try {
      const link = await auth.generateEmailVerificationLink(email, {
        url: `${redirectHost}/portal.html?verified=true&email=${encodeURIComponent(email)}`,
        handleCodeInApp: false
      });
      return { ok: true, link };
    } catch (error) {
      this.recordFirebaseError(`verification link for ${email}`, error);
      return { ok: false, error: error.message };
    }
  }

  async syncMerchantAuth(merchant) {
    if (!merchant.email) return false;
    const auth = await this.getAuthSDK();
    if (!auth) return false;

    try {
      let user;
      try {
        user = await auth.getUserByEmail(merchant.email);
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
        const createData = {
          uid: merchant.id,
          email: merchant.email,
          displayName: merchant.name || undefined,
          emailVerified: merchant.status === 'ACTIVE',
          disabled: merchant.status === 'SUSPENDED'
        };
        if (merchant.password && String(merchant.password).length >= 6) createData.password = merchant.password;
        user = await auth.createUser(createData);
      }

      await auth.updateUser(user.uid, {
        displayName: merchant.name || undefined,
        emailVerified: merchant.status === 'ACTIVE',
        disabled: merchant.status === 'SUSPENDED'
      });
      return true;
    } catch (error) {
      this.recordFirebaseError(`Auth sync for ${merchant.email}`, error);
      return false;
    }
  }

  async syncToFirebase(collectionName, docId, data) {
    if (!this.isFirebaseConfigured) {
      if (this.firebaseRequired) {
        throw new Error(`Firebase belum dikonfigurasi; write ${collectionName}/${docId} dibatalkan`);
      }
      return false;
    }
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return false;
      await firestore.collection(collectionName).doc(String(docId)).set(cleanFirestoreData(data), { merge: true });
      this.lastSuccessfulConnectionAt = new Date().toISOString();
      this.lastFirebaseError = null;
      if (collectionName === COLLECTIONS.merchants) await this.syncMerchantAuth(data);
      return true;
    } catch (error) {
      this.recordFirebaseError(`write ${collectionName}/${docId}`, error);
      if (this.firebaseRequired) throw error;
      return false;
    }
  }

  async readDocument(collectionName, id) {
    if (!this.isFirebaseConfigured) return null;
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return null;
      const snapshot = await firestore.collection(collectionName).doc(String(id)).get();
      this.lastSuccessfulConnectionAt = new Date().toISOString();
      this.lastFirebaseError = null;
      return snapshot.exists ? documentData(snapshot) : null;
    } catch (error) {
      this.recordFirebaseError(`read ${collectionName}/${id}`, error);
      if (this.firebaseRequired) throw error;
      return null;
    }
  }

  async queryOneMerchant(field, value) {
    if (!this.isFirebaseConfigured) return null;
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return null;
      const snapshot = await firestore.collection(COLLECTIONS.merchants).where(field, '==', value).limit(1).get();
      this.lastSuccessfulConnectionAt = new Date().toISOString();
      this.lastFirebaseError = null;
      return snapshot.empty ? null : documentData(snapshot.docs[0]);
    } catch (error) {
      this.recordFirebaseError(`query merchants by ${field}`, error);
      if (this.firebaseRequired) throw error;
      return null;
    }
  }

  async saveMerchant(merchant) {
    if (!merchant?.id) throw new Error('Merchant id wajib diisi');
    const normalized = {
      ...merchant,
      email: merchant.email ? String(merchant.email).toLowerCase().trim() : merchant.email,
      role: merchant.role || 'merchant',
      status: merchant.status || 'UNVERIFIED'
    };
    this.inMemoryMerchants.set(normalized.id, normalized);
    this.saveLocalBackup('merchants');
    await this.syncToFirebase(COLLECTIONS.merchants, normalized.id, normalized);
    return normalized;
  }

  async getAllMerchants() {
    if (this.isFirebaseConfigured) {
      try {
        const firestore = await this.getFirestoreDB();
        if (firestore) {
          const snapshot = await firestore.collection(COLLECTIONS.merchants).get();
          const remote = snapshot.docs.map(documentData);
          this.inMemoryMerchants = new Map(remote.map(merchant => [merchant.id, merchant]));
          this.lastSuccessfulConnectionAt = new Date().toISOString();
          this.lastFirebaseError = null;
        }
      } catch (error) {
        this.recordFirebaseError('read all merchants', error);
        if (this.firebaseRequired) throw error;
      }
    }

    if (!this.inMemoryMerchants.has('SUPERADMIN-001')) {
      const superAdmin = this.buildSuperAdmin();
      this.inMemoryMerchants.set(superAdmin.id, superAdmin);
    }
    this.saveLocalBackup('merchants');
    return Array.from(this.inMemoryMerchants.values());
  }

  async getMerchantById(id) {
    if (!id) return null;
    const remote = await this.readDocument(COLLECTIONS.merchants, id);
    if (remote) {
      this.inMemoryMerchants.set(remote.id, remote);
      return remote;
    }
    if (id === 'SUPERADMIN-001') return this.inMemoryMerchants.get(id) || this.buildSuperAdmin();
    return this.inMemoryMerchants.get(id) || null;
  }

  async findMerchant(field, value) {
    if (!value) return null;
    const normalized = field === 'email' ? String(value).toLowerCase().trim() : String(value);
    const remote = await this.queryOneMerchant(field, normalized);
    if (remote) {
      this.inMemoryMerchants.set(remote.id, remote);
      return remote;
    }
    return Array.from(this.inMemoryMerchants.values()).find(merchant => {
      const candidate = merchant[field];
      if (field === 'email') return candidate && String(candidate).toLowerCase().trim() === normalized;
      return candidate === normalized;
    }) || null;
  }

  getMerchantByApiKey(apiKey) {
    return this.findMerchant('api_key', apiKey);
  }

  getMerchantByWebhookToken(token) {
    return this.findMerchant('webhook_token', token);
  }

  getMerchantByEmail(email) {
    return this.findMerchant('email', email);
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
    const saved = await this.saveMerchant(merchant);
    return { ok: true, message: 'Verifikasi email berhasil! Akun Anda sekarang aktif.', merchant: saved };
  }

  async toggleMerchantStatus(merchantId, status) {
    const merchant = await this.getMerchantById(merchantId);
    if (!merchant) return null;
    merchant.status = status;
    return this.saveMerchant(merchant);
  }

  async saveInvoice(invoice) {
    if (!invoice?.id) throw new Error('Invoice id wajib diisi');
    this.inMemoryInvoices.set(invoice.id, invoice);
    this.saveLocalBackup('invoices');
    await this.syncToFirebase(COLLECTIONS.invoices, invoice.id, invoice);
    return invoice;
  }

  async getInvoice(id) {
    if (!id) return null;
    const remote = await this.readDocument(COLLECTIONS.invoices, id);
    if (remote) {
      this.inMemoryInvoices.set(remote.id, remote);
      return remote;
    }
    return this.inMemoryInvoices.get(id) || null;
  }

  async readInvoices(merchantId = null) {
    if (!this.isFirebaseConfigured) return null;
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return null;
      let query = firestore.collection(COLLECTIONS.invoices);
      if (merchantId) query = query.where('merchant_id', '==', merchantId);

      let snapshot;
      try {
        snapshot = await query.orderBy('created_at', 'desc').limit(100).get();
      } catch (indexError) {
        snapshot = await query.limit(100).get();
      }

      const invoices = snapshot.docs.map(documentData)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      this.lastSuccessfulConnectionAt = new Date().toISOString();
      this.lastFirebaseError = null;
      return invoices;
    } catch (error) {
      this.recordFirebaseError(`read invoices${merchantId ? ` for ${merchantId}` : ''}`, error);
      if (this.firebaseRequired) throw error;
      return null;
    }
  }

  async getAllInvoices() {
    const remote = await this.readInvoices();
    if (remote) {
      this.inMemoryInvoices = new Map(remote.map(invoice => [invoice.id, invoice]));
      this.saveLocalBackup('invoices');
      return remote;
    }
    return Array.from(this.inMemoryInvoices.values())
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  async getInvoicesByMerchant(merchantId) {
    const remote = await this.readInvoices(merchantId);
    if (remote) {
      remote.forEach(invoice => this.inMemoryInvoices.set(invoice.id, invoice));
      this.saveLocalBackup('invoices');
      return remote;
    }
    return Array.from(this.inMemoryInvoices.values())
      .filter(invoice => !merchantId || invoice.merchant_id === merchantId)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  async updateInvoiceStatus(id, status, details = {}) {
    const invoice = await this.getInvoice(id);
    if (!invoice) return null;
    return this.saveInvoice({ ...invoice, ...details, status });
  }

  async saveWebhookLog(logEntry) {
    if (!logEntry?.id) throw new Error('Webhook log id wajib diisi');
    this.inMemoryLogs = [logEntry, ...this.inMemoryLogs.filter(log => log.id !== logEntry.id)].slice(0, 200);
    this.saveLocalBackup('logs');
    await this.syncToFirebase(COLLECTIONS.webhookLogs, logEntry.id, logEntry);
    return logEntry;
  }

  async readWebhookLogs(merchantId = null) {
    if (!this.isFirebaseConfigured) return null;
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return null;
      let query = firestore.collection(COLLECTIONS.webhookLogs);
      if (merchantId) query = query.where('merchant_id', '==', merchantId);

      let snapshot;
      try {
        snapshot = await query.orderBy('received_at', 'desc').limit(200).get();
      } catch (indexError) {
        snapshot = await query.limit(200).get();
      }

      const logs = snapshot.docs.map(documentData)
        .sort((a, b) => new Date(b.received_at || 0) - new Date(a.received_at || 0));
      this.lastSuccessfulConnectionAt = new Date().toISOString();
      this.lastFirebaseError = null;
      return logs;
    } catch (error) {
      this.recordFirebaseError(`read webhook logs${merchantId ? ` for ${merchantId}` : ''}`, error);
      if (this.firebaseRequired) throw error;
      return null;
    }
  }

  async getAllWebhookLogs() {
    const remote = await this.readWebhookLogs();
    if (remote) {
      this.inMemoryLogs = remote;
      this.saveLocalBackup('logs');
      return remote;
    }
    return this.inMemoryLogs;
  }

  async getWebhookLogsByMerchant(merchantId) {
    if (!merchantId) return this.getAllWebhookLogs();
    const remote = await this.readWebhookLogs(merchantId);
    if (remote) return remote;
    return this.inMemoryLogs.filter(log => log.merchant_id === merchantId);
  }
}

export const db = new FirebaseService();
