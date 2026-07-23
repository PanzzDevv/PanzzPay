import assert from 'node:assert/strict';
import test from 'node:test';
import { FirebaseService } from '../firebase.js';

class FakeDocumentSnapshot {
  constructor(id, value) {
    this.id = id;
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return structuredClone(this.value);
  }
}

class FakeQuerySnapshot {
  constructor(documents) {
    this.docs = documents;
    this.empty = documents.length === 0;
    this.size = documents.length;
  }

  forEach(callback) {
    this.docs.forEach(callback);
  }
}

class FakeQuery {
  constructor(store, filters = [], order = null, maximum = null) {
    this.store = store;
    this.filters = filters;
    this.order = order;
    this.maximum = maximum;
  }

  where(field, operator, value) {
    assert.equal(operator, '==');
    return new FakeQuery(this.store, [...this.filters, [field, value]], this.order, this.maximum);
  }

  orderBy(field, direction) {
    return new FakeQuery(this.store, this.filters, [field, direction], this.maximum);
  }

  limit(maximum) {
    return new FakeQuery(this.store, this.filters, this.order, maximum);
  }

  async get() {
    if (this.order && this.store.failOrderedQueries) {
      const error = new Error('The query requires an index.');
      error.code = 9;
      throw error;
    }
    let rows = Array.from(this.store.entries())
      .map(([id, value]) => new FakeDocumentSnapshot(id, value))
      .filter(document => this.filters.every(([field, value]) => document.value[field] === value));

    if (this.order) {
      const [field, direction] = this.order;
      rows.sort((left, right) => {
        const comparison = String(left.value[field] || '').localeCompare(String(right.value[field] || ''));
        return direction === 'desc' ? -comparison : comparison;
      });
    }
    if (this.maximum !== null) rows = rows.slice(0, this.maximum);
    return new FakeQuerySnapshot(rows);
  }
}

class FakeCollection extends FakeQuery {
  constructor(store) {
    super(store);
  }

  doc(id) {
    return {
      get: async () => new FakeDocumentSnapshot(id, this.store.get(id)),
      set: async (value, options = {}) => {
        const current = options.merge ? this.store.get(id) || {} : {};
        this.store.set(id, structuredClone({ ...current, ...value }));
      }
    };
  }
}

class FakeFirestore {
  constructor(seed = {}) {
    this.collections = new Map(
      Object.entries(seed).map(([name, rows]) => [name, new Map(rows.map(row => [row.id, structuredClone(row)]))])
    );
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return new FakeCollection(this.collections.get(name));
  }
}

class FakeAuth {
  constructor() {
    this.users = new Map();
  }

  async getUserByEmail(email) {
    const user = Array.from(this.users.values()).find(candidate => candidate.email === email);
    if (user) return structuredClone(user);
    const error = new Error('User not found');
    error.code = 'auth/user-not-found';
    throw error;
  }

  async getUser(uid) {
    const user = this.users.get(uid);
    if (user) return structuredClone(user);
    const error = new Error('User not found');
    error.code = 'auth/user-not-found';
    throw error;
  }

  async createUser(data) {
    const user = { ...data, uid: data.uid || `uid-${this.users.size + 1}` };
    this.users.set(user.uid, user);
    return structuredClone(user);
  }

  async updateUser(uid, data) {
    const user = { ...this.users.get(uid), ...data, uid };
    this.users.set(uid, user);
    return structuredClone(user);
  }

  async setCustomUserClaims(uid, customClaims) {
    const user = { ...this.users.get(uid), customClaims, uid };
    this.users.set(uid, user);
  }
}

test('merchant writes are mirrored to Firestore and Firebase Auth', async () => {
  const firestore = new FakeFirestore();
  const auth = new FakeAuth();
  const service = new FirebaseService({ firestore, auth, skipLocalBackup: true });
  await auth.createUser({ uid: 'MCH-1', email: 'owner@example.com', emailVerified: true });

  await service.saveMerchant({
    id: 'MCH-1',
    name: 'Merchant One',
    email: 'OWNER@EXAMPLE.COM',
    password: 'secret123',
    api_key: 'api-1',
    webhook_token: 'webhook-1',
    status: 'ACTIVE'
  });

  const stored = firestore.collections.get('merchants').get('MCH-1');
  assert.equal(stored.email, 'owner@example.com');
  assert.equal(stored.api_key, undefined);
  assert.match(stored.api_key_hash, /^[a-f0-9]{64}$/);
  assert.equal((await service.getMerchantByEmail('OWNER@example.com')).id, 'MCH-1');
  assert.equal(auth.users.get('MCH-1').emailVerified, true);
  assert.equal(auth.users.get('MCH-1').disabled, false);
  assert.equal(auth.users.get('MCH-1').customClaims.role, 'merchant');
});

test('cloud data is authoritative for invoices and status updates', async () => {
  const firestore = new FakeFirestore({
    invoices: [{
      id: 'INV-1',
      merchant_id: 'MCH-1',
      status: 'PAID',
      total_amount: 12000,
      created_at: '2026-07-23T02:00:00.000Z'
    }]
  });
  const service = new FirebaseService({ firestore, skipLocalBackup: true });
  service.inMemoryInvoices.set('INV-1', { id: 'INV-1', status: 'PENDING', created_at: '2026-07-22T02:00:00.000Z' });

  const invoice = await service.getInvoice('INV-1');
  assert.equal(invoice.status, 'PAID');

  const updated = await service.updateInvoiceStatus('INV-1', 'REFUNDED', { note: 'test' });
  assert.equal(updated.status, 'REFUNDED');
  assert.equal(firestore.collections.get('invoices').get('INV-1').note, 'test');
});

test('webhook logs are read from Firestore and filtered per merchant', async () => {
  const firestore = new FakeFirestore({
    webhook_logs: [
      { id: 'LOG-1', merchant_id: 'MCH-1', received_at: '2026-07-23T01:00:00.000Z' },
      { id: 'LOG-2', merchant_id: 'MCH-2', received_at: '2026-07-23T02:00:00.000Z' }
    ]
  });
  const service = new FirebaseService({ firestore, skipLocalBackup: true });

  const allLogs = await service.getAllWebhookLogs();
  const merchantLogs = await service.getWebhookLogsByMerchant('MCH-1');

  assert.deepEqual(allLogs.map(log => log.id), ['LOG-2', 'LOG-1']);
  assert.deepEqual(merchantLogs.map(log => log.id), ['LOG-1']);
});

test('merchant history falls back safely while composite indexes are unavailable', async () => {
  const firestore = new FakeFirestore({
    invoices: [
      { id: 'INV-OLD', merchant_id: 'MCH-1', created_at: '2026-07-23T01:00:00.000Z' },
      { id: 'INV-NEW', merchant_id: 'MCH-1', created_at: '2026-07-23T03:00:00.000Z' },
      { id: 'INV-OTHER', merchant_id: 'MCH-2', created_at: '2026-07-23T04:00:00.000Z' }
    ],
    webhook_logs: [
      { id: 'LOG-OLD', merchant_id: 'MCH-1', received_at: '2026-07-23T01:00:00.000Z' },
      { id: 'LOG-NEW', merchant_id: 'MCH-1', received_at: '2026-07-23T02:00:00.000Z' }
    ]
  });
  firestore.collections.get('invoices').failOrderedQueries = true;
  firestore.collections.get('webhook_logs').failOrderedQueries = true;
  const service = new FirebaseService({ firestore, skipLocalBackup: true });

  const invoices = await service.getInvoicesByMerchant('MCH-1');
  const logs = await service.getWebhookLogsByMerchant('MCH-1');

  assert.deepEqual(invoices.map(invoice => invoice.id), ['INV-NEW', 'INV-OLD']);
  assert.deepEqual(logs.map(log => log.id), ['LOG-NEW', 'LOG-OLD']);
});

test('merchant suspension is synchronized to Firebase Auth', async () => {
  const firestore = new FakeFirestore();
  const auth = new FakeAuth();
  const service = new FirebaseService({ firestore, auth, skipLocalBackup: true });
  await auth.createUser({ uid: 'MCH-2', email: 'two@example.com', emailVerified: true });
  await service.saveMerchant({
    id: 'MCH-2',
    name: 'Merchant Two',
    email: 'two@example.com',
    password: 'secret123',
    status: 'ACTIVE'
  });

  await service.toggleMerchantStatus('MCH-2', 'SUSPENDED');
  assert.equal(auth.users.get('MCH-2').disabled, true);
  assert.equal(firestore.collections.get('merchants').get('MCH-2').status, 'SUSPENDED');
});

test('webhook matching is merchant-scoped and idempotent', async () => {
  const firestore = new FakeFirestore();
  const service = new FirebaseService({ firestore, skipLocalBackup: true });
  const merchant = { id: 'MCH-1', name: 'One', status: 'ACTIVE' };
  await service.saveInvoice({ id: 'INV-OTHER', merchant_id: 'MCH-2', total_amount: 15000, status: 'PENDING' });
  await service.saveInvoice({ id: 'INV-OWNED', merchant_id: 'MCH-1', total_amount: 15000, status: 'PENDING' });

  const first = await service.processWebhookEvent({
    merchant,
    eventId: 'event-12345678',
    amount: 15000,
    source: 'DANA',
    payloadDigest: 'digest',
    receivedAt: '2026-07-23T03:00:00.000Z'
  });
  const duplicate = await service.processWebhookEvent({
    merchant,
    eventId: 'event-12345678',
    amount: 15000,
    source: 'DANA',
    payloadDigest: 'digest',
    receivedAt: '2026-07-23T03:00:01.000Z'
  });

  assert.equal(first.invoice.id, 'INV-OWNED');
  assert.equal((await service.getInvoice('INV-OTHER')).status, 'PENDING');
  assert.equal(duplicate.duplicate, true);
});
