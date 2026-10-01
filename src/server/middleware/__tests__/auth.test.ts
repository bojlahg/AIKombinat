import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware } from '../auth.js';
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('../../db/app-settings.js', () => ({ getSetting: (key: string) => settings.get(key) ?? null }));

function check(peer: string, headers: Record<string, string> = { host: 'localhost' }, session?: Record<string, unknown>, path = '/projects') {
  const next = vi.fn();
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  authMiddleware({ socket: { remoteAddress: peer }, headers, session, path } as any, res as any, next);
  return { next, res };
}

beforeEach(() => settings.clear());
describe('actual auth middleware', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('allows local %s without creating a session', peer => {
    expect(check(peer).next).toHaveBeenCalledOnce();
  });
  it('keeps local access available with a configured password', () => {
    settings.set('auth.password_hash', 'hash');
    expect(check('127.0.0.1').next).toHaveBeenCalledOnce();
  });
  it.each([
    ['192.168.1.5', { host: 'localhost' }],
    ['127.0.0.1', { host: 'app.example.com' }],
    ['127.0.0.1', { host: 'localhost', 'cf-ray': 'ray' }],
    ['127.0.0.1', { host: 'localhost', 'x-forwarded-for': '127.0.0.1' }],
  ])('denies remote/proxy %s without a password even with authenticated session', (peer, headers) => {
    const { next, res } = check(peer, headers, { authenticated: true, createdAt: Date.now() });
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ error: 'remote_access_not_configured' });
  });
  it('allows only valid remote sessions', () => {
    settings.set('auth.password_hash', 'hash');
    settings.set('auth.password_changed_at', '100');
    expect(check('192.168.1.5', { host: 'localhost' }, { authenticated: true, createdAt: 100 }).next).toHaveBeenCalledOnce();
    const destroy = vi.fn(cb => cb());
    const denied = check('192.168.1.5', { host: 'localhost' }, { authenticated: true, createdAt: 99, destroy });
    expect(denied.res.status).toHaveBeenCalledWith(401);
  });
  it('preserves MCP bearer independently of local/password state', () => {
    settings.set('mcp.token', 'secret');
    expect(check('192.168.1.5', { host: 'public.example', authorization: 'Bearer secret' }).next).toHaveBeenCalledOnce();
    expect(check('192.168.1.5', { host: 'public.example', authorization: 'Bearer wrong' }).next).not.toHaveBeenCalled();
  });
  it.each(['/auth/status', '/auth/login', '/health'])('allows public %s', path => {
    expect(check('192.168.1.5', {}, undefined, path).next).toHaveBeenCalledOnce();
  });
  it('does not exempt similarly named API routes', () => {
    expect(check('192.168.1.5', {}, undefined, '/authentic').next).not.toHaveBeenCalled();
  });
});
