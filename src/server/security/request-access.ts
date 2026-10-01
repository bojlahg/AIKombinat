import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export type RequestAccess =
  | { mode: 'direct_loopback'; reason: string }
  | { mode: 'remote_or_proxied'; reason: string };

const proxyHeaders = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'cf-visitor'];

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && ipv4.split('.')[0] === '127';
}

function localAuthority(authority: string): boolean {
  const match = /^(localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])(?::([0-9]{1,5}))?$/i.exec(authority);
  if (!match) return false;
  if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
  return /^localhost\.?$/i.test(match[1]) || match[1] === '[::1]' || isLoopback(match[1]);
}

export function classifyRequestAccess(req: Pick<IncomingMessage, 'socket' | 'headers'>): RequestAccess {
  const remote = (reason: string): RequestAccess => ({ mode: 'remote_or_proxied', reason });
  if (!isLoopback(req.socket.remoteAddress)) return remote('non_loopback_peer');
  if (proxyHeaders.some(header => req.headers[header] !== undefined)) return remote('proxy_header');
  if (typeof req.headers.host !== 'string' || !localAuthority(req.headers.host)) return remote('non_loopback_host');
  if (req.headers.origin !== undefined) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return remote('invalid_origin');
    const match = /^https?:\/\/([^/]+)$/i.exec(origin);
    if (!match || !localAuthority(match[1])) return remote('non_loopback_origin');
  }
  return { mode: 'direct_loopback', reason: 'loopback_peer_host_origin' };
}
