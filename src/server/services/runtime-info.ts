import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findRepoRoot } from '../logging/paths.js';

/**
 * AIKombinat runs both as a plain Node process and inside Electron, and the two
 * embed different V8/Node ABIs. Native modules built for one refuse to load in
 * the other, so the runtime identity has to be visible at startup rather than
 * inferred from a stack trace after the fact.
 */
export interface RuntimeInfo {
  appVersion: string;
  runtime: 'node' | 'electron';
  nodeVersion: string;
  electronVersion?: string;
  /** `process.versions.modules` — the NODE_MODULE_VERSION native addons target. */
  abi: string;
  platform: string;
  arch: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedVersion: string | null = null;

export function readAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.join(findRepoRoot(__dirname), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export function getRuntimeInfo(): RuntimeInfo {
  const electronVersion = process.versions.electron;
  return {
    appVersion: readAppVersion(),
    runtime: electronVersion ? 'electron' : 'node',
    nodeVersion: process.versions.node,
    ...(electronVersion ? { electronVersion } : {}),
    abi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
  };
}

/** `runtime=electron electron=43.1.0 node=v22.16.0 abi=127 platform=win32 x64`. */
export function formatRuntimeLine(info: RuntimeInfo = getRuntimeInfo()): string {
  const parts = [`runtime=${info.runtime}`];
  if (info.electronVersion) parts.push(`electron=${info.electronVersion}`);
  parts.push(`node=v${info.nodeVersion}`, `abi=${info.abi}`, `platform=${info.platform}`, info.arch);
  return parts.join(' ');
}

/** Test hook — the package.json read is cached for the process lifetime. */
export function resetRuntimeInfoCache(): void {
  cachedVersion = null;
}
