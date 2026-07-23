import crypto from 'crypto';

const SENSITIVE_KEYS = /^(password|token|authorization|cookie|api[_-]?key|webhook[_-]?token|private[_-]?key|id[_-]?token)$/i;

export function hashSecret(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function generateSecret(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

export function generateId(prefix) {
  return `${prefix}${crypto.randomUUID()}`;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildEventId(merchantId, payload, suppliedId = '') {
  const normalizedId = String(suppliedId || '').trim();
  if (normalizedId && /^[A-Za-z0-9._:-]{8,200}$/.test(normalizedId)) return normalizedId;
  return `derived_${hashSecret(`${merchantId}:${stableStringify(payload)}`)}`;
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const separator = part.indexOf('=');
        if (separator < 0) return [part, ''];
        const key = part.slice(0, separator);
        const value = part.slice(separator + 1);
        try {
          return [key, decodeURIComponent(value)];
        } catch {
          return [key, value];
        }
      })
  );
}

export function getBearerToken(header = '') {
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

export function publicMerchant(merchant, options = {}) {
  if (!merchant) return null;
  const result = {
    id: merchant.id,
    name: merchant.name,
    email: merchant.email,
    role: merchant.role || 'merchant',
    status: merchant.status || 'ACTIVE',
    provider: merchant.provider || 'password',
    picture: merchant.picture || null,
    qris_payload: options.includeQris ? (merchant.qris_payload || '') : undefined,
    qris_configured: Boolean(merchant.qris_payload),
    telegram_chat_id: merchant.telegram_chat_id || '',
    telegram_bot_token: merchant.telegram_bot_token || '',
    telegram_enabled: merchant.telegram_enabled !== false,
    api_key_hint: merchant.api_key_hint || null,
    webhook_token_hint: merchant.webhook_token_hint || null,
    created_at: merchant.created_at || null,
    updated_at: merchant.updated_at || null
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

export function redact(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(item, depth + 1)
    ]));
  }
  if (typeof value === 'string' && value.length > 1000) return `${value.slice(0, 1000)}…`;
  return value;
}

export function securityLog(event, details = {}) {
  console.log(JSON.stringify({
    level: 'security',
    event,
    at: new Date().toISOString(),
    ...redact(details)
  }));
}

export function getTrustedOrigins() {
  return new Set(
    String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim().replace(/\/$/, ''))
      .filter(Boolean)
  );
}

export function isTrustedOrigin(req, origin) {
  if (!origin) return true;
  const normalized = String(origin).replace(/\/$/, '');
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  return normalized === requestOrigin || getTrustedOrigins().has(normalized);
}
