import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { classifyRequestAccess, isLoopback } from './request-access.js';

function request(peer = '127.0.0.1', headers: Record<string, string | string[]> = { host: 'localhost:3000' }) {
  return { socket: { remoteAddress: peer }, headers } as unknown as IncomingMessage;
}

describe('request access boundary', () => {
  it.each(['127.0.0.1', '127.0.0.2', '127.255.255.255', '::1', '::ffff:127.0.0.1'])('recognizes %s', peer => {
    expect(isLoopback(peer)).toBe(true);
    expect(classifyRequestAccess(request(peer)).mode).toBe('direct_loopback');
  });
  it.each(['0.0.0.0', '192.168.1.10', '10.0.0.1', '172.16.1.1', '8.8.8.8', '::', '::ffff:10.0.0.1', '127.999.0.1'])('rejects non-loopback %s even with local Host', peer => {
    expect(classifyRequestAccess(request(peer)).mode).toBe('remote_or_proxied');
  });
  it.each(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'cf-visitor'])('fails closed with %s, including empty values', header => {
    expect(classifyRequestAccess(request('127.0.0.1', { host: 'localhost', [header]: '' })).mode).toBe('remote_or_proxied');
  });
  it.each(['localhost', 'localhost.', 'LOCALHOST:3737', '127.0.0.2:3000', '[::1]:3000'])('accepts local authority %s', host => {
    expect(classifyRequestAccess(request('::1', { host, origin: 'http://localhost:5173' })).mode).toBe('direct_loopback');
  });
  it.each(['evil.example.com', 'abc.trycloudflare.com', 'localhost.evil.com', 'localhost:0', 'localhost:65536', 'localhost:abc', 'localhost/path', 'user@localhost', '127.1', '', 'localhost,localhost'])('rejects authority %s', host => {
    expect(classifyRequestAccess(request('127.0.0.1', { host })).mode).toBe('remote_or_proxied');
  });
  it.each(['https://evil.example.com', 'https://abc.trycloudflare.com', 'null', 'http://localhost/path', 'file://localhost', 'http://user@localhost', 'http://localhost:65536'])('rejects origin %s', origin => {
    expect(classifyRequestAccess(request('127.0.0.1', { host: 'localhost', origin })).mode).toBe('remote_or_proxied');
  });
  it('fails closed with missing Host or missing peer', () => {
    expect(classifyRequestAccess(request('127.0.0.1', {})).mode).toBe('remote_or_proxied');
    expect(classifyRequestAccess({ headers: { host: 'localhost' }, socket: {} } as IncomingMessage).mode).toBe('remote_or_proxied');
  });
});
