import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'test';
const { app } = await import('../server.js');
let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('protected merchant collections reject anonymous access', async () => {
  const [invoices, logs] = await Promise.all([
    fetch(`${baseUrl}/api/invoices`),
    fetch(`${baseUrl}/api/webhook/logs`)
  ]);
  assert.equal(invoices.status, 401);
  assert.equal(logs.status, 401);
});

test('anonymous session check is quiet and does not expose merchant data', async () => {
  const response = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, authenticated: false });
});

test('legacy verification bypass endpoints are disabled', async () => {
  const response = await fetch(`${baseUrl}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'attacker@example.com' })
  });
  assert.equal(response.status, 410);
});

test('webhook tokens in query strings are rejected', async () => {
  const response = await fetch(`${baseUrl}/api/webhook/callback?token=secret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 10000, event_id: 'event-12345678' })
  });
  assert.equal(response.status, 400);
});

test('webhook simulator requires an authenticated merchant session', async () => {
  const response = await fetch(`${baseUrl}/api/webhook/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Pembayaran masuk Rp 10.000' })
  });
  assert.equal(response.status, 401);
});

test('registration validation rejects weak passwords and unknown fields', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test', email: 'test@example.com', password: 'weak', role: 'superadmin' })
  });
  assert.equal(response.status, 400);
});

test('security headers are present', async () => {
  const response = await fetch(`${baseUrl}/api/auth/config`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
});
