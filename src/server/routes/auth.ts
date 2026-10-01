import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { isIP } from 'node:net';
import { getSetting, setSetting } from '../db/app-settings.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { classifyRequestAccess, isLoopback } from '../security/request-access.js';
import { authStateEvents, isRemotePasswordConfigured, isValidAuthSession } from '../middleware/auth.js';
import { logger } from '../logging/index.js';

const router = Router();
const HASH_KEY = 'auth.password_hash';
const CHANGED_AT_KEY = 'auth.password_changed_at';
const MIN_LENGTH = 8;
const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export function authRateLimitKey(req: Parameters<typeof classifyRequestAccess>[0]): string {
  const peer = req.socket.remoteAddress;
  if (!isLoopback(peer)) return peer && isIP(peer) ? ipKeyGenerator(peer) : 'unknown_peer';
  if (classifyRequestAccess(req).mode === 'direct_loopback') return 'direct_loopback';
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && isIP(cf)) return ipKeyGenerator(cf);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const addresses = xff.split(',').map(value => value.trim());
    if (addresses.length && addresses.every(value => isIP(value))) {
      return ipKeyGenerator(addresses[addresses.length - 1]);
    }
  }
  return 'loopback_proxy';
}

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: authRateLimitKey,
  message: { error: 'too_many_auth_attempts' },
  standardHeaders: true,
  legacyHeaders: false,
});

function validatePasswordPair(password: unknown, confirmPassword: unknown):
  | { ok: true; password: string }
  | { ok: false; status: number; error: string } {
  if (typeof password !== 'string' || !password) return { ok: false, status: 400, error: 'password_required' };
  if (password.length < MIN_LENGTH) return { ok: false, status: 400, error: 'password_too_short' };
  if (typeof confirmPassword !== 'string' || password !== confirmPassword) {
    return { ok: false, status: 400, error: 'passwords_do_not_match' };
  }
  return { ok: true, password };
}

function markPasswordChanged(): number {
  const changedAt = Math.max(Date.now() + 1, Number(getSetting(CHANGED_AT_KEY) || 0) + 1);
  setSetting(CHANGED_AT_KEY, String(changedAt));
  authStateEvents.emit('password-changed');
  return changedAt;
}

router.post('/login', authLimiter, async (req, res) => {
  const { password } = req.body ?? {};
  const hash = getSetting(HASH_KEY);
  if (!hash) return res.status(503).json({ error: 'remote_access_not_configured' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'password_required' });
  const ok = await verifyPassword(password, hash).catch(() => false);
  if (!ok || getSetting(HASH_KEY) !== hash) {
    logger.warn('auth.login.failed', { scope: '[auth]', msg: 'remote login rejected' });
    return res.status(401).json({ error: 'invalid_password' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'unauthorized' });
    if (getSetting(HASH_KEY) !== hash) return res.status(401).json({ error: 'invalid_password' });
    req.session.authenticated = true;
    req.session.createdAt = Math.max(Date.now(), Number(getSetting(CHANGED_AT_KEY) || 0));
    if (req.body?.remember === true) req.session.cookie.maxAge = REMEMBER_ME_MAX_AGE;
    res.json({ success: true });
  });
});

router.post('/setup', authLimiter, async (req, res) => {
  if (classifyRequestAccess(req).mode !== 'direct_loopback') return res.status(403).json({ error: 'local_only' });
  if (isRemotePasswordConfigured()) return res.status(409).json({ error: 'already_initialized' });
  const { password, confirmPassword } = req.body ?? {};
  const validation = validatePasswordPair(password, confirmPassword);
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });
  const hash = await hashPassword(validation.password);
  if (isRemotePasswordConfigured()) return res.status(409).json({ error: 'already_initialized' });
  setSetting(HASH_KEY, hash);
  markPasswordChanged();
  res.json({ success: true });
});

router.put('/password', authLimiter, async (req, res) => {
  const local = classifyRequestAccess(req).mode === 'direct_loopback';
  if (!local && !isValidAuthSession(req.session)) return res.status(401).json({ error: 'unauthorized' });
  const { oldPassword, newPassword, confirmPassword } = req.body ?? {};
  const hash = getSetting(HASH_KEY);
  if (!local) {
    if (typeof oldPassword !== 'string' || !oldPassword) return res.status(400).json({ error: 'current_password_required' });
    if (!hash || !await verifyPassword(oldPassword, hash).catch(() => false)) {
      return res.status(401).json({ error: 'current_password_incorrect' });
    }
  }
  const validation = validatePasswordPair(newPassword, confirmPassword);
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });
  const newHash = await hashPassword(validation.password);
  if (!local && (getSetting(HASH_KEY) !== hash || !isValidAuthSession(req.session))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  setSetting(HASH_KEY, newHash);
  const changedAt = markPasswordChanged();
  if (!local) req.session.createdAt = changedAt;
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'logout_failed' });
    res.json({ success: true });
  });
});

router.get('/status', (req, res) => {
  const local = classifyRequestAccess(req).mode === 'direct_loopback';
  const disabled = process.env.DISABLE_AUTH === 'true';
  const passwordConfigured = isRemotePasswordConfigured();
  res.json({
    authenticated: disabled || local || isValidAuthSession(req.session),
    authRequired: !disabled && !local,
    accessMode: local ? 'local' : 'remote',
    setupRequired: false,
    passwordConfigured,
    remoteAccessReady: !disabled && passwordConfigured,
    remoteAccessBlocked: !disabled && !local && !passwordConfigured,
    passwordSetupAllowed: local,
  });
});

export default router;
