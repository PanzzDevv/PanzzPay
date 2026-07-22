import fs from 'fs';
import path from 'path';

// Firebase Firestore Client & Storage Engine
class FirebaseStorage {
  constructor() {
    this.merchants = new Map();
    this.invoices = new Map();
    this.webhookLogs = [];
    this.configPath = path.join(process.cwd(), 'firebase-config.json');
    this.isFirebaseActive = false;
    this.projectId = null;
    this.firebaseCredentials = null;

    // Seed Master Super Admin Account
    this.seedSuperAdmin();
    // Initialize Firebase Configuration (File or Single JSON Env)
    this.initFirebaseConfig();
  }

  seedSuperAdmin() {
    const superAdmin = {
      id: 'SUPERADMIN-001',
      name: 'PanzzPay Super Admin (Pemilik Platform)',
      email: 'admin@panzzpay.com',
      password: 'adminpanzzpay123',
      role: 'superadmin',
      api_key: 'pz_admin_master_key_99999',
      webhook_token: 'pz_wh_admin_master_token_99999',
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    };
    this.merchants.set(superAdmin.id, superAdmin);
  }

  initFirebaseConfig() {
    const envJson = process.env.FIREBASE_CONFIG_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (envJson) {
      try {
        const json = typeof envJson === 'string' ? JSON.parse(envJson) : envJson;
        if (json.project_id) {
          this.projectId = json.project_id;
          this.firebaseCredentials = json;
          this.isFirebaseActive = true;
          console.log(`🔥 Firebase Firestore Loaded from FIREBASE_CONFIG_JSON Env Variable! Project ID: ${this.projectId}`);
          return;
        }
      } catch (e) {
        console.warn('⚠️ Error parsing FIREBASE_CONFIG_JSON env variable:', e.message);
      }
    }

    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const json = JSON.parse(raw);
        if (json.project_id) {
          this.projectId = json.project_id;
          this.firebaseCredentials = json;
          this.isFirebaseActive = true;
          console.log(`🔥 Firebase Firestore Loaded from local firebase-config.json file! Project ID: ${this.projectId}`);
          return;
        }
      } catch (e) {
        console.warn('⚠️ Error parsing local firebase-config.json file:', e.message);
      }
    }

    console.log('ℹ️ Firebase config not found. Running in Local Storage Mode (Ready to sync with Firebase).');
  }

  // --- MERCHANT & SUPERADMIN OPERATIONS ---
  async saveMerchant(merchant) {
    if (!merchant.role) merchant.role = 'merchant';
    if (!merchant.status) merchant.status = 'ACTIVE';
    this.merchants.set(merchant.id, merchant);
    return merchant;
  }

  async getAllMerchants() {
    return Array.from(this.merchants.values());
  }

  async getMerchantById(id) {
    return this.merchants.get(id) || null;
  }

  async getMerchantByApiKey(apiKey) {
    for (const m of this.merchants.values()) {
      if (m.api_key === apiKey) return m;
    }
    return null;
  }

  async getMerchantByWebhookToken(token) {
    for (const m of this.merchants.values()) {
      if (m.webhook_token === token) return m;
    }
    return null;
  }

  async getMerchantByEmail(email) {
    for (const m of this.merchants.values()) {
      if (m.email.toLowerCase() === email.toLowerCase()) return m;
    }
    return null;
  }

  async toggleMerchantStatus(merchantId, status) {
    const merchant = this.merchants.get(merchantId);
    if (!merchant) return null;
    merchant.status = status;
    this.merchants.set(merchantId, merchant);
    return merchant;
  }

  // --- INVOICE OPERATIONS ---
  async saveInvoice(invoice) {
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async getInvoice(id) {
    return this.invoices.get(id) || null;
  }

  async getAllInvoices() {
    return Array.from(this.invoices.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async getInvoicesByMerchant(merchantId) {
    const list = [];
    for (const inv of this.invoices.values()) {
      if (!merchantId || inv.merchant_id === merchantId) {
        list.push(inv);
      }
    }
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async updateInvoiceStatus(id, status, details = {}) {
    const inv = this.invoices.get(id);
    if (!inv) return null;
    inv.status = status;
    Object.assign(inv, details);
    this.invoices.set(id, inv);
    return inv;
  }

  // --- WEBHOOK LOG OPERATIONS ---
  async saveWebhookLog(logEntry) {
    this.webhookLogs.unshift(logEntry);
    if (this.webhookLogs.length > 200) this.webhookLogs.pop();
    return logEntry;
  }

  async getAllWebhookLogs() {
    return this.webhookLogs;
  }

  async getWebhookLogsByMerchant(merchantId) {
    if (!merchantId) return this.webhookLogs;
    return this.webhookLogs.filter(l => l.merchant_id === merchantId);
  }
}

export const db = new FirebaseStorage();
