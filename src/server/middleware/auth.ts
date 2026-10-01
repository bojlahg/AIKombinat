import crypto from 'crypto';
import { EventEmitter } from 'node:events';
import session from 'express-session';
import type { RequestHandler, Express } from 'express';
import { getSetting, setSetting } from '../db/app-settings.js';
import { getDatabase } from '../db/connection.js';
import { classifyRequestAccess } from '../security/request-access.js';

// Session-based password authentication middleware.
// Secret and sessions are persisted in SQLite so "remember me" survives
// server restarts (default MemoryStore + per-process random secret both
// invalidated every session on restart).

const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
export const authStateEvents = new EventEmitter();

// Minimal express-session store backed by the existing better-sqlite3 DB.
export class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    const db = getDatabase();
    db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now());
  }

  private expiresAt(sess: session.SessionData): number {
    const exp = sess.cookie?.expires;
    return exp ? new Date(exp).getTime() : Date.now() + DEFAULT_MAX_AGE;
  }

  get(sid: string, cb: (err: unknown, sess?: session.SessionData | null) => void): void {
    try {
      const row = getDatabase()
        .prepare('SELECT data, expires_at FROM auth_sessions WHERE sid = ?')
        .get(sid) as { data: string; expires_at: number } | undefined;
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      getDatabase()
        .prepare('INSERT OR REPLACE INTO auth_sessions (sid, data, expires_at) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), this.expiresAt(sess));
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    try {
      getDatabase().prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid);
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      getDatabase()
        .prepare('UPDATE auth_sessions SET expires_at = ? WHERE sid = ?')
        .run(this.expiresAt(sess), sid);
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }
}

function getPersistedSecret(): string {
  let secret = getSetting('auth.session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('auth.session_secret', secret);
  }
  return secret;
}

// Built lazily on first request so DB init (DB_PATH, dotenv) happens first.
let realSessionMiddleware: RequestHandler | null = null;

export const sessionMiddleware: RequestHandler = (req, res, next) => {
  if (!realSessionMiddleware) {
    realSessionMiddleware = session({
      secret: process.env.SESSION_SECRET || getPersistedSecret(),
      store: new SqliteSessionStore(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: 'auto',
        sameSite: 'strict',
        maxAge: DEFAULT_MAX_AGE,
      },
    });
  }
  realSessionMiddleware(req, res, next);
};

// Validate an `Authorization: Bearer <token>` header against the locally
// generated MCP token. Used both by the /mcp endpoint guard and by the MCP
// tools' loopback calls into /api/*.
export function matchesMcpToken(req: { headers: Record<string, unknown> }): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = header.slice(7).trim();
  const expected = getSetting('mcp.token');
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isRemotePasswordConfigured(): boolean {
  return Boolean(getSetting('auth.password_hash'));
}

export function isValidAuthSession(sess: { authenticated?: boolean; createdAt?: number } | undefined): boolean {
  if (!isRemotePasswordConfigured() || sess?.authenticated !== true) return false;
  const changedAt = Number(getSetting('auth.password_changed_at') || 0);
  return (sess.createdAt ?? 0) >= changedAt;
}

// Auth check middleware - skip for /api/auth/* routes
export const authMiddleware: RequestHandler = (req, res, next) => {
  // Skip auth for login/status endpoints
  if (req.path.startsWith('/api/auth/') || req.path.startsWith('/auth/')) {
    return next();
  }
  // Skip auth for health check
  if (req.path === '/api/health' || req.path === '/health') {
    return next();
  }

  // MCP clients and the MCP tools' loopback calls authenticate via bearer token.
  if (matchesMcpToken(req)) {
    return next();
  }

  if (classifyRequestAccess(req).mode === 'direct_loopback') return next();

  if (!isRemotePasswordConfigured()) {
    res.status(401).json({ error: 'remote_access_not_configured' });
    return;
  }

  if (req.session && req.session.authenticated) {
    // Invalidate sessions issued before the most recent password change.
    if (!isValidAuthSession(req.session)) {
      req.session.destroy(() => {
        res.status(401).json({ error: 'unauthorized' });
      });
      return;
    }
    return next();
  }

  res.status(401).json({ error: 'unauthorized' });
};

export function initAuth(app: Express): void {
  app.use(sessionMiddleware);
  if (process.env.DISABLE_AUTH !== 'true') {
    app.use('/api', authMiddleware);
  }
}
