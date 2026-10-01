import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
import { initAuth, SqliteSessionStore } from '../../middleware/auth.js';
import * as auth from '../../middleware/auth.js';
import authRouter, { authRateLimitKey, authLimiter } from '../auth.js';
import tunnelRouter from '../tunnel.js';
import { initWebSocket } from '../../websocket/index.js';
import { getDatabase, closeDatabase } from '../../db/connection.js';
import { getSetting, setSetting } from '../../db/app-settings.js';
import { hashPassword } from '../../utils/password.js';

vi.mock('../../services/tunnel-manager.js', () => ({ tunnelManager: {
  startTunnel: vi.fn().mockResolvedValue('https://fixture.trycloudflare.com'),
  startNamedTunnel: vi.fn().mockResolvedValue('https://app.example.com'),
  getTunnelStatus: vi.fn().mockReturnValue({ status: 'stopped', url: null }),
  stopTunnel: vi.fn().mockResolvedValue(undefined),
} }));
vi.mock('../../services/claude-manager.js', () => ({ claudeManager: {} }));
vi.mock('../../services/session-manager.js', () => ({ sessionManager: {
  hasPendingPrompt: vi.fn().mockReturnValue(false), writeTerminalInput: vi.fn(),
} }));
vi.mock('../../services/vault-watcher.js', () => ({ vaultWatcher: { removeClient: vi.fn() }, gitWatcher: { removeClient: vi.fn() } }));
vi.mock('../../websocket/broadcaster.js', () => ({ encodeSessionFrame: vi.fn(), broadcaster: {
  addClient: vi.fn(), removeClient: vi.fn(), getClientCount: () => 1,
} }));
import { tunnelManager } from '../../services/tunnel-manager.js';
import { sessionManager } from '../../services/session-manager.js';

let server: Server;
let base: string;
const remoteHeaders = { host: 'fixture.trycloudflare.com', 'cf-ray': 'fixture', 'x-forwarded-proto': 'http' };
const localHeaders = { host: 'localhost' };
const sockets = new Set<WebSocket>();
async function openWs(cookie?: string, remote = true) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', {
    headers: { ...(remote ? remoteHeaders : localHeaders), ...(cookie ? { cookie } : {}) },
  });
  sockets.add(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}
function closedUnauthorized(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('WS was not revoked within 1500ms')), 1500);
    ws.once('close', (code, reason) => {
      clearTimeout(deadline);
      try { expect(code).toBe(1008); expect(reason.toString()).toBe('unauthorized'); resolve(); }
      catch (err) { reject(err); }
    });
  });
}
function sidFor(cookie: string) {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).slice(2).split('.')[0];
}
async function api(path: string, method = 'GET', body?: unknown, remote = false, cookie?: string) {
  const headers: Record<string, string> = { ...(remote ? remoteHeaders : localHeaders), 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function login() {
  const response = await api('/api/auth/login', 'POST', { password: 'original123', remember: true }, true);
  expect(response.status).toBe(200);
  expect(response.cookie).toBeTruthy();
  return response.cookie!;
}
async function wsStatus(remote = false, cookie?: string, extraHeaders: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = remote ? { ...remoteHeaders } : { ...localHeaders };
    if (cookie) headers.cookie = cookie;
    Object.assign(headers, extraHeaders);
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
    ws.on('error', err => { if (!String(err).includes('closed before')) reject(err); });
  });
}

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  process.env.DISABLE_AUTH = 'false';
  process.env.NODE_ENV = 'production';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  getDatabase();
  new SqliteSessionStore();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  initAuth(app);
  app.use('/api/auth', authRouter);
  app.use('/api/tunnel', tunnelRouter);
  app.get('/api/protected', (_, res) => res.json({ ok: true }));
  server = createServer(app);
  initWebSocket(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => {
  getDatabase().prepare('DELETE FROM app_settings').run();
  getDatabase().prepare('DELETE FROM auth_sessions').run();
  vi.clearAllMocks();
  authLimiter.resetKey('direct_loopback');
  authLimiter.resetKey('loopback_proxy');
});
afterEach(() => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  closeDatabase();
  delete process.env.DB_PATH;
  delete process.env.DISABLE_AUTH;
  delete process.env.CORS_ORIGIN;
  delete process.env.NODE_ENV;
});

describe('remote access HTTP and WS integration', () => {
  it('logout immediately closes all same-SID sockets while another session stays authorized', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const a = await login(), b = await login();
    const a1 = await openWs(a), a2 = await openWs(a), b1 = await openWs(b);
    const closed = Promise.all([closedUnauthorized(a1), closedUnauthorized(a2)]);
    const revoke = vi.fn();
    auth.authStateEvents.once('session-revoked', revoke);
    expect((await api('/api/auth/logout', 'POST', {}, true, a)).status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(sidFor(a));
    await closed;
    expect((await api('/api/protected', 'GET', undefined, true, a)).status).toBe(401);
    expect(await wsStatus(true, a)).toBe(401);
    expect((await api('/api/protected', 'GET', undefined, true, b)).status).toBe(200);
    expect(b1.readyState).toBe(WebSocket.OPEN);
  });
  it('failed logout does not emit session revocation', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const cookie = await login(), ws = await openWs(cookie);
    const revoke = vi.fn();
    auth.authStateEvents.on('session-revoked', revoke);
    const destroy = vi.spyOn(SqliteSessionStore.prototype, 'destroy').mockImplementation((_, cb) => cb?.(new Error('fixture failure')));
    try {
      expect((await api('/api/auth/logout', 'POST', {}, true, cookie)).data).toEqual({ error: 'logout_failed' });
      expect(revoke).not.toHaveBeenCalled();
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally { destroy.mockRestore(); auth.authStateEvents.off('session-revoked', revoke); }
  });
  it.each([
    ['deleted', 'DELETE FROM auth_sessions WHERE sid = ?'],
    ['expired', 'UPDATE auth_sessions SET expires_at = 0 WHERE sid = ?'],
    ['corrupt', "UPDATE auth_sessions SET data = '{' WHERE sid = ?"],
    ['unauthenticated', `UPDATE auth_sessions SET data = '{"authenticated":false,"createdAt":100}' WHERE sid = ?`],
  ])('timer revokes a %s persisted session', async (_, sql) => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const cookie = await login(), ws = await openWs(cookie);
    const closed = closedUnauthorized(ws);
    getDatabase().prepare(sql).run(sidFor(cookie));
    await closed;
    expect(await wsStatus(true, cookie)).toBe(401);
  });
  it('blocks a handled post-expiry message before terminal input dispatch', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const cookie = await login(), ws = await openWs(cookie);
    const message = JSON.stringify({ type: 'session:terminal-input', sessionId: 'fixture', input: 'x' });
    ws.send(message);
    await vi.waitFor(() => expect(sessionManager.writeTerminalInput).toHaveBeenCalledOnce());
    vi.mocked(sessionManager.writeTerminalInput).mockClear();
    const closed = closedUnauthorized(ws);
    getDatabase().prepare('UPDATE auth_sessions SET expires_at = ? WHERE sid = ?').run(Date.now() - 1, sidFor(cookie));
    ws.send(message);
    await closed;
    expect(sessionManager.hasPendingPrompt).toHaveBeenCalledOnce();
    expect(sessionManager.writeTerminalInput).not.toHaveBeenCalled();
  });
  it('idle WS traffic never touches or extends persisted session expiry', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const cookie = await login(), ws = await openWs(cookie);
    const before = getDatabase().prepare('SELECT expires_at FROM auth_sessions WHERE sid = ?').get(sidFor(cookie));
    const touch = vi.spyOn(SqliteSessionStore.prototype, 'touch');
    ws.send(JSON.stringify({ type: 'session:terminal-input', sessionId: 'fixture', input: 'x' }));
    await vi.waitFor(() => expect(sessionManager.writeTerminalInput).toHaveBeenCalledOnce());
    expect(getDatabase().prepare('SELECT expires_at FROM auth_sessions WHERE sid = ?').get(sidFor(cookie))).toEqual(before);
    expect(touch).not.toHaveBeenCalled();
  });
  it('remote rotation persists the requester before revocation and closes only older sessions', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const a = await login(), b = await login();
    const requester = await openWs(a), other = await openWs(b);
    const closed = closedUnauthorized(other);
    const atEvent = vi.fn(() => expect(auth.validatePersistedAuthSession(sidFor(a)).valid).toBe(true));
    auth.authStateEvents.once('password-changed', atEvent);
    expect((await api('/api/auth/password', 'PUT', { oldPassword: 'original123', newPassword: 'replacement123', confirmPassword: 'replacement123' }, true, a)).status).toBe(200);
    await closed;
    expect(atEvent).toHaveBeenCalledOnce();
    expect(requester.readyState).toBe(WebSocket.OPEN);
    expect((await api('/api/protected', 'GET', undefined, true, a)).status).toBe(200);
    expect((await api('/api/protected', 'GET', undefined, true, b)).status).toBe(401);
  });
  it('local rotation revokes both remote sessions and leaves local WS and HTTP usable', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const a = await login(), b = await login();
    const a1 = await openWs(a), b1 = await openWs(b), local = await openWs(undefined, false);
    const closed = Promise.all([closedUnauthorized(a1), closedUnauthorized(b1)]);
    expect((await api('/api/auth/password', 'PUT', { newPassword: 'replacement123', confirmPassword: 'replacement123' })).status).toBe(200);
    await closed;
    expect((await api('/api/protected', 'GET', undefined, true, a)).status).toBe(401);
    expect((await api('/api/protected', 'GET', undefined, true, b)).status).toBe(401);
    expect((await api('/api/protected')).status).toBe(200);
    expect(local.readyState).toBe(WebSocket.OPEN);
  });
  it('out-of-process hash removal revokes idle remote WS through the timer', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const ws = await openWs(await login());
    const closed = closedUnauthorized(ws);
    setSetting('auth.password_hash', null);
    await closed;
  });
  it('DB read failures close remote sockets before dispatch', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const ws = await openWs(await login());
    const closed = closedUnauthorized(ws);
    const read = vi.spyOn(getDatabase(), 'prepare').mockImplementation(() => { throw new Error('read failed'); });
    try {
      ws.send(JSON.stringify({ type: 'session:terminal-input', sessionId: 'fixture', input: 'x' }));
      await closed;
      expect(sessionManager.writeTerminalInput).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  it('local socket messages perform no persisted auth validation and survive the timer', async () => {
    const ws = await openWs(undefined, false);
    const validate = vi.spyOn(auth, 'validatePersistedAuthSession');
    ws.send(JSON.stringify({ type: 'session:terminal-input', sessionId: 'fixture', input: 'x' }));
    await vi.waitFor(() => expect(sessionManager.writeTerminalInput).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(validate).not.toHaveBeenCalled();
    expect((await api('/api/auth/logout', 'POST', {})).status).toBe(200);
    expect((await api('/api/auth/status')).data.authenticated).toBe(true);
  });
  it('repeated server init/close cleans up auth listeners and revalidation timers', async () => {
    const before = ['password-changed', 'session-revoked'].map(event => auth.authStateEvents.listenerCount(event));
    const timers: ReturnType<typeof setInterval>[] = [];
    const originalInterval = globalThis.setInterval;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const timer = originalInterval(...args); timers.push(timer); return timer;
    }) as typeof setInterval);
    const clear = vi.spyOn(globalThis, 'clearInterval');
    for (let i = 0; i < 3; i++) {
      const fixture = createServer();
      initWebSocket(fixture);
      await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
      await new Promise<void>(resolve => fixture.close(() => resolve()));
    }
    interval.mockRestore();
    for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer);
    expect(['password-changed', 'session-revoked'].map(event => auth.authStateEvents.listenerCount(event))).toEqual(before);
  });
  it('tunnel failures return stable validation and operation codes', async () => {
    expect((await api('/api/tunnel/config', 'PUT', { customHostname: 'localhost' })).data.error).toBe('invalid_tunnel_hostname');
    expect((await api('/api/tunnel/config', 'PUT', { customHostname: 'bad domain' })).data.error).toBe('invalid_tunnel_hostname');
    expect((await api('/api/tunnel/config', 'PUT', { customHostname: 'app.example.com' })).data.error).toBe('tunnel_name_required');
    setSetting('auth.password_hash', await hashPassword('original123'));
    vi.mocked(tunnelManager.startTunnel).mockRejectedValueOnce(new Error('raw operational failure'));
    expect((await api('/api/tunnel/start', 'POST', {})).data.error).toBe('tunnel_start_failed');
    vi.mocked(tunnelManager.stopTunnel).mockRejectedValueOnce(new Error('raw operational failure'));
    expect((await api('/api/tunnel/stop', 'POST', {})).data.error).toBe('tunnel_stop_failed');
  });
  it('supports real IPv6 loopback HTTP and WS without a password', async () => {
    const app = express();
    initAuth(app);
    app.get('/api/protected', (_, res) => res.json({ ok: true }));
    const ipv6 = createServer(app);
    initWebSocket(ipv6);
    await new Promise<void>((resolve, reject) => { ipv6.once('error', reject); ipv6.listen(0, '::1', resolve); });
    const port = (ipv6.address() as { port: number }).port;
    try {
      const res = await fetch(`http://[::1]:${port}/api/protected`);
      expect(res.status).toBe(200);
      const ws = new WebSocket(`ws://[::1]:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => { ws.close(); resolve(); });
        ws.once('error', reject);
      });
    } finally {
      await new Promise<void>(resolve => ipv6.close(() => resolve()));
    }
  });
  it('returns a stable rate-limit code after repeated proxy attempts', async () => {
    for (let i = 0; i < 10; i++) await api('/api/auth/login', 'POST', {}, true);
    const limited = await api('/api/auth/login', 'POST', {}, true);
    expect(limited.status).toBe(429);
    expect(limited.data).toEqual({ error: 'too_many_auth_attempts' });
  });
  it('preserves production WS Origin protection', async () => {
    expect(await wsStatus(false, undefined, { origin: 'https://evil.example.com' })).toBe(403);
    expect(await wsStatus(false, undefined, { origin: 'http://localhost:5173' })).toBe(101);
    expect(await wsStatus(true, undefined, { origin: 'https://fixture.trycloudflare.com' })).toBe(401);
  });
  it('uses secure cookies for HTTPS tunnel login and supports HTTP loopback', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { ...remoteHeaders, 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'original123' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/; Secure/);
    expect(res.headers.get('set-cookie')).toMatch(/; HttpOnly/);
    expect(res.headers.get('set-cookie')).toMatch(/; SameSite=Strict/);
    expect((await api('/api/auth/login', 'POST', { password: 'original123' })).cookie).toBeTruthy();
  });
  it('disconnects an already connected remote WS after local password change', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const cookie = await login();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { ...remoteHeaders, cookie } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
    await api('/api/auth/password', 'PUT', { newPassword: 'replacement123', confirmPassword: 'replacement123' });
    expect(await closed).toBe(1008);
  });
  it('fresh local app opens with no session or password, including WS', async () => {
    const status = await api('/api/auth/status');
    expect(status.data).toMatchObject({ authenticated: true, authRequired: false, setupRequired: false, accessMode: 'local', passwordConfigured: false, passwordSetupAllowed: true });
    expect((await api('/api/protected')).status).toBe(200);
    expect(await wsStatus()).toBe(101);
    expect(getDatabase().prepare('SELECT count(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
  });
  it('proxy client without password is blocked and cannot claim first password', async () => {
    expect((await api('/api/auth/status', 'GET', undefined, true)).data).toMatchObject({ authenticated: false, authRequired: true, accessMode: 'remote', remoteAccessBlocked: true, passwordSetupAllowed: false });
    expect((await api('/api/auth/setup', 'POST', { password: 'attacker123', confirmPassword: 'attacker123' }, true)).data).toEqual({ error: 'local_only' });
    expect(getSetting('auth.password_hash')).toBeNull();
    expect((await api('/api/protected', 'GET', undefined, true)).status).toBe(401);
    expect(await wsStatus(true)).toBe(401);
  });
  it('local setup saves only scrypt hash and creates no authenticated session', async () => {
    const response = await api('/api/auth/setup', 'POST', { password: 'original123', confirmPassword: 'original123' });
    expect(response.status).toBe(200);
    expect(response.cookie).toBeUndefined();
    expect(getSetting('auth.password_hash')).not.toContain('original123');
    expect((await api('/api/auth/setup', 'POST', {})).data).toEqual({ error: 'already_initialized' });
    expect((await api('/api/protected')).status).toBe(200);
    expect((await api('/api/protected', 'GET', undefined, true)).status).toBe(401);
  });
  it('remote login allows API and WS; local rotation invalidates old sessions', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const cookie = await login();
    expect((await api('/api/protected', 'GET', undefined, true, cookie)).status).toBe(200);
    expect(await wsStatus(true, cookie)).toBe(101);
    expect((await api('/api/auth/password', 'PUT', { newPassword: 'replacement123', confirmPassword: 'replacement123' })).status).toBe(200);
    expect((await api('/api/auth/status', 'GET', undefined, true, cookie)).data.authenticated).toBe(false);
    expect(await wsStatus(true, cookie)).toBe(401);
    expect((await api('/api/protected', 'GET', undefined, true, cookie)).status).toBe(401);
    expect((await api('/api/protected')).status).toBe(200);
    expect(await wsStatus()).toBe(101);
  });
  it('remote password change requires valid session and current password', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const body = { newPassword: 'replacement123', confirmPassword: 'replacement123' };
    expect((await api('/api/auth/password', 'PUT', body, true)).data).toEqual({ error: 'unauthorized' });
    const cookie = await login();
    expect((await api('/api/auth/password', 'PUT', body, true, cookie)).data).toEqual({ error: 'current_password_required' });
    expect((await api('/api/auth/password', 'PUT', { ...body, oldPassword: 'wrong' }, true, cookie)).data).toEqual({ error: 'current_password_incorrect' });
    expect((await api('/api/auth/password', 'PUT', { ...body, oldPassword: 'original123' }, true, cookie)).status).toBe(200);
    expect((await api('/api/protected', 'GET', undefined, true, cookie)).status).toBe(200);
  });
  it('password removal blocks old remote sessions independently of tunnel state', async () => {
    setSetting('auth.password_hash', await hashPassword('original123'));
    const cookie = await login();
    setSetting('auth.password_hash', null);
    expect((await api('/api/protected', 'GET', undefined, true, cookie)).status).toBe(401);
    expect(await wsStatus(true, cookie)).toBe(401);
  });
  it('guards both quick and named tunnel starts before calling the manager', async () => {
    expect((await api('/api/tunnel/start', 'POST', {})).data).toEqual({ error: 'remote_password_required' });
    setSetting('tunnel.name', 'fixture');
    expect((await api('/api/tunnel/start', 'POST', {})).status).toBe(409);
    expect(tunnelManager.startTunnel).not.toHaveBeenCalled();
    expect(tunnelManager.startNamedTunnel).not.toHaveBeenCalled();
    setSetting('auth.password_hash', await hashPassword('original123'));
    expect((await api('/api/tunnel/start', 'POST', {})).status).toBe(200);
    expect(tunnelManager.startNamedTunnel).toHaveBeenCalledOnce();
    setSetting('tunnel.name', null);
    expect((await api('/api/tunnel/start', 'POST', {})).status).toBe(200);
    expect(tunnelManager.startTunnel).toHaveBeenCalledOnce();
  });
  it('returns language-neutral validation codes', async () => {
    expect((await api('/api/auth/setup', 'POST', {})).data).toEqual({ error: 'password_required' });
    expect((await api('/api/auth/setup', 'POST', { password: 'short', confirmPassword: 'short' })).data).toEqual({ error: 'password_too_short' });
    expect((await api('/api/auth/setup', 'POST', { password: 'original123', confirmPassword: 'different' })).data).toEqual({ error: 'passwords_do_not_match' });
  });
});

describe('auth limiter trust boundary', () => {
  it('ignores spoofed XFF and CF headers from direct LAN peers', () => {
    const req = (ip: string) => ({ socket: { remoteAddress: '192.168.1.2' }, headers: { host: 'localhost', 'x-forwarded-for': ip, 'cf-connecting-ip': ip } } as any);
    expect(authRateLimitKey(req('1.1.1.1'))).toBe(authRateLimitKey(req('8.8.8.8')));
  });
  it('uses rightmost valid forwarded peer from loopback proxy and a shared fallback', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'public.example', 'x-forwarded-for': '1.1.1.1, 8.8.8.8' } } as any;
    expect(authRateLimitKey(req)).toBe('8.8.8.8');
    req.headers['x-forwarded-for'] = 'malformed';
    expect(authRateLimitKey(req)).toBe('loopback_proxy');
  });
});
