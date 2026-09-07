import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export class DelegationFileError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface DelegationFileIdentity {
  canonicalPath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  chars: number;
  lines: number;
  content: string;
}

const SENSITIVE_PARTS = new Set(['.git', '.ssh']);
const SENSITIVE_NAMES = /^(?:\.env(?:\..+)?|credentials?(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?|.*\.(?:pem|p12|pfx|key)|auth\.json)$/i;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNotSensitive(relativePath: string): void {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const base = parts.at(-1) ?? '';
  if (parts.some((part) => SENSITIVE_PARTS.has(part.toLowerCase())) || SENSITIVE_NAMES.test(base)) {
    throw new DelegationFileError('delegation_sensitive_path', 'Sensitive files cannot be sent to a Delegation Worker.');
  }
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('.aikombinat/') && /(?:auth|token|secret|config)/.test(base.toLowerCase())) {
    throw new DelegationFileError('delegation_sensitive_path', 'AIKombinat authentication and configuration secrets cannot be delegated.');
  }
}

export function resolveDelegationFile(workDir: string, requestedPath: string): { canonicalPath: string; relativePath: string; stat: fs.Stats } {
  if (!requestedPath || typeof requestedPath !== 'string') throw new DelegationFileError('delegation_invalid_path', 'A file path is required.');
  let root: string;
  let candidate: string;
  try {
    root = fs.realpathSync.native(path.resolve(workDir));
    candidate = fs.realpathSync.native(path.resolve(root, requestedPath));
  } catch {
    throw new DelegationFileError('delegation_file_not_found', 'The requested file does not exist.');
  }
  if (!isWithin(root, candidate)) throw new DelegationFileError('delegation_outside_workspace', 'The requested file resolves outside the parent workspace.');
  const relativePath = path.relative(root, candidate).replace(/\\/g, '/');
  assertNotSensitive(relativePath);
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) throw new DelegationFileError('delegation_not_regular_file', 'The requested path is not a regular file.');
  return { canonicalPath: candidate, relativePath, stat };
}

export function readDelegationFile(workDir: string, requestedPath: string, maxBytes: number, maxLines: number): DelegationFileIdentity {
  const resolved = resolveDelegationFile(workDir, requestedPath);
  if (resolved.stat.size > maxBytes) throw new DelegationFileError('delegation_input_too_large', `The file exceeds the ${maxBytes}-byte delegation limit.`);
  const bytes = fs.readFileSync(resolved.canonicalPath);
  if (bytes.includes(0)) throw new DelegationFileError('delegation_binary_file', 'Binary files are not supported by bulk_read V1.');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new DelegationFileError('delegation_binary_file', 'The file is not valid UTF-8 text.'); }
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  if (lines > maxLines) throw new DelegationFileError('delegation_input_too_large', `The file exceeds the ${maxLines}-line delegation limit.`);
  return {
    canonicalPath: resolved.canonicalPath,
    relativePath: resolved.relativePath,
    size: bytes.length,
    mtimeMs: resolved.stat.mtimeMs,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    chars: content.length,
    lines,
    content,
  };
}

export function recheckDelegationFile(identity: DelegationFileIdentity): boolean {
  try {
    const stat = fs.statSync(identity.canonicalPath);
    if (!stat.isFile() || stat.size !== identity.size || stat.mtimeMs !== identity.mtimeMs) return false;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(identity.canonicalPath)).digest('hex');
    return hash === identity.sha256;
  } catch { return false; }
}

interface CachedMetadata { size: number; mtimeMs: number; lines: number; threshold: number; maxBytes: number; expiresAt: number }
const metadataCache = new Map<string, CachedMetadata>();

export function getCachedFileMetadata(workDir: string, requestedPath: string, threshold: number, maxBytes: number): { canonicalPath: string; relativePath: string; size: number; lines: number } {
  const resolved = resolveDelegationFile(workDir, requestedPath);
  const cached = metadataCache.get(resolved.canonicalPath);
  if (cached && cached.size === resolved.stat.size && cached.mtimeMs === resolved.stat.mtimeMs && cached.threshold === threshold && cached.maxBytes === maxBytes && cached.expiresAt > Date.now()) {
    return { canonicalPath: resolved.canonicalPath, relativePath: resolved.relativePath, size: cached.size, lines: cached.lines };
  }
  let lines = resolved.stat.size === 0 ? 0 : 1;
  if (resolved.stat.size >= threshold - 1 && resolved.stat.size <= maxBytes) {
    const fd = fs.openSync(resolved.canonicalPath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        for (let i = 0; i < bytesRead && lines < threshold; i++) if (buffer[i] === 10) lines++;
      } while (bytesRead > 0 && lines < threshold);
    } finally { fs.closeSync(fd); }
  } else if (resolved.stat.size > maxBytes) {
    // The worker route will reject this file by its exact byte limit. Marking it
    // as a large candidate avoids synchronously scanning an arbitrarily large
    // file in the hook path; enforcement subsequently fails open.
    lines = threshold;
  }
  metadataCache.set(resolved.canonicalPath, { size: resolved.stat.size, mtimeMs: resolved.stat.mtimeMs, lines, threshold, maxBytes, expiresAt: Date.now() + 30_000 });
  return { canonicalPath: resolved.canonicalPath, relativePath: resolved.relativePath, size: resolved.stat.size, lines };
}

export function clearDelegationMetadataCache(): void { metadataCache.clear(); }
