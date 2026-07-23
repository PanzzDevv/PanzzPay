import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateSecret, hashSecret } from './lib/security.js';

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

function isMissingFirestoreIndex(error) {
  return Number(error?.code) === 9 || /requires an index/i.test(String(error?.message || ''));
}

export class FirebaseService {
  constructor(options = {}) {
    this.projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'panzzpay';
    this.serviceAccount = null;
    this.configSource = 'none';
    this.isFirebaseConfigured = false;
    const productionDefault = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
    this.firebaseRequired = parseBoolean(process.env.FIREBASE_REQUIRED, productionDefault);
    this.adminApp = null;
    this.firestoreInstance = options.firestore || null;
    this.authInstance = options.auth || null;
    this.lastFirebaseError = null;
    this.lastSuccessfulConnectionAt = null;
    this.skipLocalBackup = Boolean(options.skipLocalBackup);
    this.inMemoryMerchants = new Map();
    this.inMemoryInvoices = new Map();
    this.inMemoryLogs = [];
    this.processedWebhookEvents = new Map();

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
        merchants.forEach(merchant => {
          const sanitized = { ...merchant };
          if (sanitized.api_key) {
            sanitized.api_key_hash = hashSecret(sanitized.api_key);
            sanitized.api_key_hint = `${String(sanitized.api_key).slice(0, 10)}…`;
          }
          if (sanitized.webhook_token) {
            sanitized.webhook_token_hash = hashSecret(sanitized.webhook_token);
            sanitized.webhook_token_hint = `${String(sanitized.webhook_token).slice(0, 10)}…`;
          }
          delete sanitized.api_key;
          delete sanitized.webhook_token;
          delete sanitized.password;
          delete sanitized.password_hash;
          delete sanitized.otp_code;
          this.inMemoryMerchants.set(sanitized.id, sanitized);
        });
        this.saveLocalBackup('merchants');
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

  async init() {
    const connected = await this.probeConnection();
    await this.seedConfiguredSuperAdmin();
    console.log(connected
      ? `[FIRESTORE READY] ${Object.values(COLLECTIONS).join(', ')}`
      : '[FIRESTORE FALLBACK] Cloud unavailable; local persistence remains active.');
    return this.getHealth(false);
  }

  async seedConfiguredSuperAdmin() {
    const uid = String(process.env.SUPER_ADMIN_UID || '').trim();
    const email = String(process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
    if (!uid || !email) return;

    const existing = await this.getMerchantById(uid);
    await this.saveMerchant({
      ...existing,
      id: uid,
      name: existing?.name || 'PanzzPay Super Admin',
      email,
      role: 'superadmin',
      status: 'ACTIVE',
      provider: existing?.provider || 'password',
      created_at: existing?.created_at || new Date().toISOString()
    });
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
      const user = await auth.getUser(merchant.id);

      await auth.updateUser(user.uid, {
        displayName: merchant.name || undefined,
        disabled: merchant.status === 'SUSPENDED'
      });
      await auth.setCustomUserClaims(user.uid, {
        ...(user.customClaims || {}),
        role: merchant.role || 'merchant'
      });
      return true;
    } catch (error) {
      if (error.code === 'auth/user-not-found') return false;
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
      await firestore.collection(collectionName).doc(String(docId)).set(
        cleanFirestoreData(data),
        { merge: collectionName !== COLLECTIONS.merchants }
      );
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
    const now = new Date().toISOString();
    const normalized = {
      ...merchant,
      email: merchant.email ? String(merchant.email).toLowerCase().trim() : merchant.email,
      role: merchant.role || 'merchant',
      status: merchant.status || 'UNVERIFIED',
      updated_at: now
    };
    if (normalized.api_key) {
      normalized.api_key_hash = hashSecret(normalized.api_key);
      normalized.api_key_hint = `${String(normalized.api_key).slice(0, 10)}…`;
    }
    if (normalized.webhook_token) {
      normalized.webhook_token_hash = hashSecret(normalized.webhook_token);
      normalized.webhook_token_hint = `${String(normalized.webhook_token).slice(0, 10)}…`;
    }
    delete normalized.api_key;
    delete normalized.webhook_token;
    delete normalized.password;
    delete normalized.password_hash;
    delete normalized.otp_code;
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

  async getMerchantByApiKey(apiKey) {
    if (!apiKey) return null;
    const hashed = hashSecret(apiKey);
    let merchant = await this.findMerchant('api_key_hash', hashed);
    if (!merchant) {
      merchant = await this.findMerchant('api_key', apiKey);
      if (merchant) merchant = await this.saveMerchant({ ...merchant, api_key: apiKey });
    }
    return merchant;
  }

  async getMerchantByWebhookToken(token) {
    if (!token) return null;
    const hashed = hashSecret(token);
    let merchant = await this.findMerchant('webhook_token_hash', hashed);
    if (!merchant) {
      merchant = await this.findMerchant('webhook_token', token);
      if (merchant) merchant = await this.saveMerchant({ ...merchant, webhook_token: token });
    }
    return merchant;
  }

  getMerchantByEmail(email) {
    return this.findMerchant('email', email);
  }

  async provisionMerchant(identity, profile = {}) {
    const existing = await this.getMerchantById(identity.uid);
    const isConfiguredAdmin = identity.uid === process.env.SUPER_ADMIN_UID;
    const credentials = existing ? null : {
      apiKey: generateSecret('pz_live_'),
      webhookToken: generateSecret('pz_wh_')
    };
    const merchant = await this.saveMerchant({
      ...existing,
      id: identity.uid,
      name: profile.name || identity.name || existing?.name || String(identity.email || '').split('@')[0],
      email: String(identity.email || existing?.email || '').toLowerCase(),
      role: isConfiguredAdmin ? 'superadmin' : (existing?.role || 'merchant'),
      status: existing?.status === 'SUSPENDED'
        ? 'SUSPENDED'
        : (identity.email_verified ? 'ACTIVE' : 'UNVERIFIED'),
      provider: profile.provider || existing?.provider || identity.firebase?.sign_in_provider || 'password',
      picture: identity.picture || existing?.picture || null,
      api_key: credentials?.apiKey,
      webhook_token: credentials?.webhookToken,
      created_at: existing?.created_at || new Date().toISOString()
    });
    return { merchant, credentials };
  }

  async rotateMerchantCredentials(merchantId) {
    const merchant = await this.getMerchantById(merchantId);
    if (!merchant) return null;
    const credentials = {
      apiKey: generateSecret('pz_live_'),
      webhookToken: generateSecret('pz_wh_')
    };
    const updated = await this.saveMerchant({
      ...merchant,
      api_key: credentials.apiKey,
      webhook_token: credentials.webhookToken
    });
    return { merchant: updated, credentials };
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

  async readInvoices(merchantId = null, options = {}) {
    if (!this.isFirebaseConfigured) return null;
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return null;
      const pageSize = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
      let baseQuery = firestore.collection(COLLECTIONS.invoices);
      if (merchantId) baseQuery = baseQuery.where('merchant_id', '==', merchantId);

      let invoices;
      try {
        let orderedQuery = baseQuery.orderBy('created_at', 'desc');
        if (options.cursor && typeof orderedQuery.startAfter === 'function') orderedQuery = orderedQuery.startAfter(options.cursor);
        const snapshot = await orderedQuery.limit(pageSize).get();
        invoices = snapshot.docs.map(documentData);
      } catch (indexError) {
        if (!isMissingFirestoreIndex(indexError)) throw indexError;
        const snapshot = await baseQuery.get();
        invoices = snapshot.docs.map(documentData)
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        const cursorTime = Date.parse(options.cursor || '');
        if (Number.isFinite(cursorTime)) {
          invoices = invoices.filter(invoice => Date.parse(invoice.created_at || '') < cursorTime);
        }
        invoices = invoices.slice(0, pageSize);
      }

      invoices.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
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

  async getInvoicesByMerchant(merchantId, options = {}) {
    const remote = await this.readInvoices(merchantId, options);
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

  async updateOwnedInvoiceStatus(id, merchantId, status, details = {}) {
    const invoice = await this.getInvoice(id);
    if (!invoice || invoice.merchant_id !== merchantId) return null;
    if (invoice.status !== 'PENDING' && status === 'PAID') return invoice;
    return this.saveInvoice({ ...invoice, ...details, status });
  }

  async getPendingInvoiceByAmount(merchantId, totalAmount) {
    const firestore = await this.getFirestoreDB();
    if (firestore) {
      try {
        const snapshot = await firestore.collection(COLLECTIONS.invoices)
          .where('merchant_id', '==', merchantId)
          .where('status', '==', 'PENDING')
          .where('total_amount', '==', totalAmount)
          .limit(1)
          .get();
        return snapshot.empty ? null : documentData(snapshot.docs[0]);
      } catch (error) {
        if (isMissingFirestoreIndex(error)) {
          const fallback = await firestore.collection(COLLECTIONS.invoices)
            .where('merchant_id', '==', merchantId)
            .get();
          const match = fallback.docs.map(documentData).find(invoice =>
            invoice.status === 'PENDING' && invoice.total_amount === totalAmount
          );
          return match || null;
        }
        this.recordFirebaseError('check pending invoice amount', error);
        if (this.firebaseRequired) throw error;
      }
    }
    return Array.from(this.inMemoryInvoices.values()).find(invoice =>
      invoice.merchant_id === merchantId && invoice.status === 'PENDING' && invoice.total_amount === totalAmount
    ) || null;
  }

  async processWebhookEvent({ merchant, eventId, amount, source, payloadDigest, receivedAt }) {
    const logId = `LOG-${hashSecret(`${merchant.id}:${eventId}`)}`;
    const firestore = await this.getFirestoreDB();

    if (firestore && typeof firestore.runTransaction === 'function') {
      return firestore.runTransaction(async transaction => {
        const logRef = firestore.collection(COLLECTIONS.webhookLogs).doc(logId);
        const existingLog = await transaction.get(logRef);
        if (existingLog.exists) return { duplicate: true, log: documentData(existingLog), invoice: null };

        const query = firestore.collection(COLLECTIONS.invoices)
          .where('merchant_id', '==', merchant.id);
        const invoiceSnapshot = await transaction.get(query);
        const invoiceDocument = invoiceSnapshot.docs.find(document => {
          const invoice = document.data();
          return invoice.status === 'PENDING' && (invoice.total_amount === amount || invoice.base_amount === amount);
        }) || null;
        let invoice = null;
        if (invoiceDocument) {
          invoice = {
            ...documentData(invoiceDocument),
            status: 'PAID',
            paid_at: receivedAt,
            payment_source: source,
            payment_event_id: eventId
          };
          transaction.set(invoiceDocument.ref, invoice, { merge: true });
        }

        const log = {
          id: logId,
          merchant_id: merchant.id,
          event_id: eventId,
          received_at: receivedAt,
          payload_digest: payloadDigest,
          extracted_amount: amount,
          matched_invoice_id: invoice?.id || null,
          source,
          status: invoice ? 'MATCHED' : 'UNMATCHED'
        };
        transaction.create(logRef, log);
        return { duplicate: false, log, invoice };
      });
    }

    if (this.firebaseRequired) throw new Error('Firestore transaction tidak tersedia');
    if (this.processedWebhookEvents.has(logId)) {
      return { duplicate: true, log: this.processedWebhookEvents.get(logId), invoice: null };
    }
    const invoice = Array.from(this.inMemoryInvoices.values()).find(candidate =>
      candidate.merchant_id === merchant.id && candidate.status === 'PENDING' && (candidate.total_amount === amount || candidate.base_amount === amount)
    );
    const updated = invoice ? await this.updateOwnedInvoiceStatus(invoice.id, merchant.id, 'PAID', {
      paid_at: receivedAt,
      payment_source: source,
      payment_event_id: eventId
    }) : null;
    const log = {
      id: logId,
      merchant_id: merchant.id,
      event_id: eventId,
      received_at: receivedAt,
      payload_digest: payloadDigest,
      extracted_amount: amount,
      matched_invoice_id: updated?.id || null,
      source,
      status: updated ? 'MATCHED' : 'UNMATCHED'
    };
    this.processedWebhookEvents.set(logId, log);
    await this.saveWebhookLog(log);
    return { duplicate: false, log, invoice: updated };
  }

  async saveWebhookLog(logEntry) {
    if (!logEntry?.id) throw new Error('Webhook log id wajib diisi');
    this.inMemoryLogs = [logEntry, ...this.inMemoryLogs.filter(log => log.id !== logEntry.id)].slice(0, 200);
    this.saveLocalBackup('logs');
    await this.syncToFirebase(COLLECTIONS.webhookLogs, logEntry.id, logEntry);
    return logEntry;
  }

  async readWebhookLogs(merchantId = null, options = {}) {
    if (!this.isFirebaseConfigured) return null;
    try {
      const firestore = await this.getFirestoreDB();
      if (!firestore) return null;
      const pageSize = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
      let baseQuery = firestore.collection(COLLECTIONS.webhookLogs);
      if (merchantId) baseQuery = baseQuery.where('merchant_id', '==', merchantId);

      let logs;
      try {
        let orderedQuery = baseQuery.orderBy('received_at', 'desc');
        if (options.cursor && typeof orderedQuery.startAfter === 'function') orderedQuery = orderedQuery.startAfter(options.cursor);
        const snapshot = await orderedQuery.limit(pageSize).get();
        logs = snapshot.docs.map(documentData);
      } catch (indexError) {
        if (!isMissingFirestoreIndex(indexError)) throw indexError;
        const snapshot = await baseQuery.get();
        logs = snapshot.docs.map(documentData)
          .sort((a, b) => new Date(b.received_at || 0) - new Date(a.received_at || 0));
        const cursorTime = Date.parse(options.cursor || '');
        if (Number.isFinite(cursorTime)) {
          logs = logs.filter(log => Date.parse(log.received_at || '') < cursorTime);
        }
        logs = logs.slice(0, pageSize);
      }

      logs.sort((a, b) => new Date(b.received_at || 0) - new Date(a.received_at || 0));
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

  async getWebhookLogsByMerchant(merchantId, options = {}) {
    if (!merchantId) return this.getAllWebhookLogs();
    const remote = await this.readWebhookLogs(merchantId, options);
    if (remote) return remote;
    return this.inMemoryLogs.filter(log => log.merchant_id === merchantId);
  }
}

export const db = new FirebaseService();
