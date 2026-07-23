import { db } from '../firebase.js';
import { getBearerToken, parseCookies, publicMerchant, securityLog } from '../lib/security.js';

async function decodeIdentity(req, allowSession = true) {
  const auth = await db.getAuthSDK();
  if (!auth) throw new Error('Firebase Auth belum tersedia');

  const bearer = getBearerToken(req.headers.authorization);
  if (bearer) return { decoded: await auth.verifyIdToken(bearer, true), mode: 'id-token' };

  if (allowSession) {
    const sessionCookie = parseCookies(req.headers.cookie).__session;
    if (sessionCookie) return { decoded: await auth.verifySessionCookie(sessionCookie, true), mode: 'session' };
  }
  return null;
}

export function requireIdentity(options = {}) {
  const { allowUnverified = false, allowSession = true } = options;
  return async (req, res, next) => {
    try {
      const identity = await decodeIdentity(req, allowSession);
      if (!identity) return res.status(401).json({ ok: false, message: 'Autentikasi Firebase diperlukan' });
      if (!allowUnverified && !identity.decoded.email_verified) {
        return res.status(403).json({ ok: false, code: 'EMAIL_NOT_VERIFIED', message: 'Email Firebase belum diverifikasi' });
      }
      req.identity = identity.decoded;
      req.authMode = identity.mode;
      return next();
    } catch (error) {
      securityLog('auth_rejected', { ip: req.ip, path: req.path, code: error.code });
      return res.status(401).json({ ok: false, message: 'Sesi tidak valid atau sudah kedaluwarsa' });
    }
  };
}

export async function requireMerchant(req, res, next) {
  try {
    let merchant = null;
    try {
      const identity = await decodeIdentity(req, true);
      if (identity) {
        if (!identity.decoded.email_verified) {
          return res.status(403).json({ ok: false, code: 'EMAIL_NOT_VERIFIED', message: 'Email belum diverifikasi' });
        }
        req.identity = identity.decoded;
        req.authMode = identity.mode;
        merchant = await db.getMerchantById(identity.decoded.uid);
      }
    } catch (error) {
      securityLog('session_rejected', { ip: req.ip, path: req.path, code: error.code });
      return res.status(401).json({ ok: false, message: 'Sesi tidak valid atau sudah kedaluwarsa' });
    }

    if (!merchant) {
      const apiKey = req.get('x-api-key');
      if (apiKey) {
        merchant = await db.getMerchantByApiKey(apiKey);
        req.authMode = 'api-key';
      }
    }

    if (!merchant) return res.status(401).json({ ok: false, message: 'Autentikasi merchant diperlukan' });
    if (merchant.status === 'SUSPENDED') return res.status(403).json({ ok: false, message: 'Akun merchant ditangguhkan' });
    if (merchant.status !== 'ACTIVE') return res.status(403).json({ ok: false, message: 'Akun merchant belum aktif' });

    req.merchant = merchant;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireSessionMerchant(req, res, next) {
  return requireIdentity()(req, res, async error => {
    if (error) return next(error);
    try {
      const merchant = await db.getMerchantById(req.identity.uid);
      if (!merchant) return res.status(403).json({ ok: false, message: 'Profil merchant tidak ditemukan' });
      if (merchant.status !== 'ACTIVE') return res.status(403).json({ ok: false, message: 'Akun merchant tidak aktif' });
      req.merchant = merchant;
      return next();
    } catch (innerError) {
      return next(innerError);
    }
  });
}

export function requireSuperAdmin(req, res, next) {
  return requireSessionMerchant(req, res, error => {
    if (error) return next(error);
    if (req.merchant?.role !== 'superadmin') {
      securityLog('admin_access_denied', { uid: req.identity?.uid, ip: req.ip, path: req.path });
      return res.status(403).json({ ok: false, message: 'Akses Super Admin diperlukan' });
    }
    return next();
  });
}

export function currentMerchantResponse(merchant) {
  return publicMerchant(merchant, { includeQris: true });
}
