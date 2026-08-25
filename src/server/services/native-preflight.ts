import { createRequire } from 'module';
import { logger } from '../logging/logger.js';
import { normalizeError, type NormalizedError } from '../logging/normalize-error.js';
import { getRuntimeInfo, formatRuntimeLine, type RuntimeInfo } from './runtime-info.js';

/**
 * Native dependencies that must load before the server is worth starting. Both
 * are compiled addons: `better-sqlite3` backs every query, `node-pty` backs
 * every interactive CLI session. Both are static imports deeper in the graph,
 * so a broken one would otherwise surface as an opaque dlopen stack trace
 * before any of our code gets to run.
 */
export const CRITICAL_NATIVE_MODULES = ['better-sqlite3', 'node-pty'] as const;

export type NativeModuleName = string;

export type NativeFailureKind = 'abi_mismatch' | 'not_built' | 'missing' | 'load_error';

export interface NativeModuleCheck {
  name: NativeModuleName;
  ok: boolean;
  kind?: NativeFailureKind;
  error?: NormalizedError;
  durationMs: number;
}

export interface NativePreflightResult {
  ok: boolean;
  runtime: RuntimeInfo;
  checks: NativeModuleCheck[];
  failures: NativeModuleCheck[];
}

/** Injectable so tests can simulate a load failure without touching real deps. */
export type NativeModuleLoader = (name: NativeModuleName) => unknown;

/**
 * Synchronous on purpose. The preflight has to finish before the module graph
 * reaches `db/connection.ts`, and an async check cannot guarantee that ordering
 * under ESM top-level await.
 */
const nodeRequire = createRequire(import.meta.url);
const defaultLoader: NativeModuleLoader = (name) => nodeRequire(name);

/**
 * A rebuilt-for-the-other-runtime addon is by far the most common failure here,
 * and its native error text is unreadable. Classify it so the operator gets a
 * recovery step instead of a dlopen dump.
 */
export function classifyNativeFailure(error: NormalizedError): NativeFailureKind {
  const text = `${error.message}\n${error.stack ?? ''}`;
  if (/NODE_MODULE_VERSION/i.test(text)) return 'abi_mismatch';
  if (/was compiled against a different Node\.js version/i.test(text)) return 'abi_mismatch';
  if (/ERR_DLOPEN_FAILED/i.test(text)) return 'abi_mismatch';
  if (/is not a valid Win32 application/i.test(text)) return 'abi_mismatch';
  if (/invalid ELF header/i.test(text)) return 'abi_mismatch';
  if (/(wrong architecture|incompatible architecture|mach-o)/i.test(text)) return 'abi_mismatch';
  if (/Could not locate the bindings file/i.test(text)) return 'not_built';
  if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') return 'missing';
  if (/Cannot find (module|package)/i.test(text)) return 'missing';
  return 'load_error';
}

const KIND_CAUSE: Record<NativeFailureKind, string> = {
  abi_mismatch: 'node_modules appears to have been built for a different runtime (Node vs Electron, or a different Node major).',
  not_built: 'The compiled binary for this module is missing - the install skipped or failed its build step.',
  missing: 'The package is not installed in node_modules.',
  load_error: 'The module is installed but could not be loaded.',
};

const KIND_RECOVERY: Record<NativeFailureKind, string[]> = {
  abi_mismatch: ['npm rebuild better-sqlite3 node-pty', '(for the desktop build instead: npm run electron:rebuild)'],
  not_built: ['npm rebuild better-sqlite3 node-pty'],
  missing: ['npm install'],
  load_error: ['npm rebuild better-sqlite3 node-pty'],
};

/**
 * Human-readable replacement for the opaque stack trace a failed addon load
 * would otherwise print.
 */
export function formatNativeFailure(check: NativeModuleCheck, runtime: RuntimeInfo = getRuntimeInfo()): string {
  const kind = check.kind ?? 'load_error';
  const lines = [
    `${check.name} could not be loaded.`,
    '',
    'Current runtime:',
    ...(runtime.electronVersion ? [`  Electron ${runtime.electronVersion}`] : []),
    `  Node v${runtime.nodeVersion}`,
    `  ABI ${runtime.abi} (${runtime.platform} ${runtime.arch})`,
    '',
    'Likely cause:',
    `  ${KIND_CAUSE[kind]}`,
    '',
    'Recovery:',
    ...KIND_RECOVERY[kind].map(line => `  ${line}`),
  ];
  if (check.error?.message) {
    lines.push('', 'Original error:', `  ${check.error.message.split('\n')[0]}`);
  }
  return lines.join('\n');
}

/**
 * Tries to load each critical native module. Never rebuilds, never deletes
 * anything — diagnosing is the whole job; recovery stays the operator's call.
 */
export function runNativePreflight(
  modules: readonly NativeModuleName[] = CRITICAL_NATIVE_MODULES,
  loader: NativeModuleLoader = defaultLoader,
): NativePreflightResult {
  const runtime = getRuntimeInfo();
  const checks: NativeModuleCheck[] = [];

  for (const name of modules) {
    const startedAt = Date.now();
    try {
      loader(name);
      checks.push({ name, ok: true, durationMs: Date.now() - startedAt });
    } catch (err) {
      const error = normalizeError(err);
      checks.push({
        name,
        ok: false,
        kind: classifyNativeFailure(error),
        error,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const failures = checks.filter(check => !check.ok);
  return { ok: failures.length === 0, runtime, checks, failures };
}

/**
 * Runs the preflight and reports it through the logger.
 *
 * Returns the result rather than exiting: the caller owns process lifetime, so
 * this stays usable from tests without killing the runner.
 */
export function logNativePreflight(
  modules: readonly NativeModuleName[] = CRITICAL_NATIVE_MODULES,
  loader: NativeModuleLoader = defaultLoader,
): NativePreflightResult {
  const result = runNativePreflight(modules, loader);

  for (const check of result.checks) {
    if (check.ok) {
      logger.debug('startup.native.ok', {
        scope: '[startup/native]',
        msg: `${check.name} loaded`,
        module: check.name,
        durationMs: check.durationMs,
      });
    } else {
      logger.error('startup.native.failed', {
        scope: '[startup/native]',
        msg: `${check.name} could not be loaded`,
        module: check.name,
        kind: check.kind,
        message: check.error?.message?.split('\n')[0],
        detail: formatNativeFailure(check, result.runtime),
      });
    }
  }

  if (result.ok) {
    logger.info('startup.native.preflight', {
      scope: '[startup/native]',
      msg: 'native modules OK',
      modules: result.checks.map(c => c.name).join(','),
    });
  }

  return result;
}
