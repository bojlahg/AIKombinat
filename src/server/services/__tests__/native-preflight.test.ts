import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logger } from '../../logging/logger.js';
import { normalizeError } from '../../logging/normalize-error.js';
import type { LogRecord, LogSink } from '../../logging/types.js';
import {
  runNativePreflight,
  logNativePreflight,
  classifyNativeFailure,
  formatNativeFailure,
  CRITICAL_NATIVE_MODULES,
  type NativeModuleLoader,
} from '../native-preflight.js';
import { getRuntimeInfo, formatRuntimeLine } from '../runtime-info.js';

/**
 * Every check here runs against an injected loader. Nothing in this file loads,
 * rebuilds or otherwise disturbs the real native dependencies.
 */
const okLoader: NativeModuleLoader = () => ({ ok: true });

function failingLoader(errors: Record<string, Error>): NativeModuleLoader {
  return (name) => {
    const err = errors[name];
    if (err) throw err;
    return { ok: true };
  };
}

function capturingSink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (record) => { records.push(record); } };
}

describe('native module preflight', () => {
  it('passes when every critical module loads', () => {
    const result = runNativePreflight(CRITICAL_NATIVE_MODULES, okLoader);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.map(c => c.name)).toEqual(['better-sqlite3', 'node-pty']);
  });

  it('reports a module that cannot be loaded without stopping the other checks', () => {
    const result = runNativePreflight(
      CRITICAL_NATIVE_MODULES,
      failingLoader({ 'better-sqlite3': new Error('something went wrong') }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.failures.map(f => f.name)).toEqual(['better-sqlite3']);
    expect(result.checks[1].ok).toBe(true);
  });

  describe('failure classification', () => {
    it('recognizes an ABI mismatch from the NODE_MODULE_VERSION message', () => {
      const err = new Error(
        'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. '
        + 'This version of Node.js requires NODE_MODULE_VERSION 127.',
      );
      expect(classifyNativeFailure(normalizeError(err))).toBe('abi_mismatch');
    });

    it('recognizes the platform-specific dlopen variants', () => {
      expect(classifyNativeFailure(normalizeError(new Error('ERR_DLOPEN_FAILED')))).toBe('abi_mismatch');
      expect(classifyNativeFailure(normalizeError(new Error('%1 is not a valid Win32 application.')))).toBe('abi_mismatch');
      expect(classifyNativeFailure(normalizeError(new Error('invalid ELF header')))).toBe('abi_mismatch');
    });

    it('separates a missing build from a missing package', () => {
      expect(classifyNativeFailure(normalizeError(new Error('Could not locate the bindings file.')))).toBe('not_built');
      expect(classifyNativeFailure(normalizeError(new Error("Cannot find module 'node-pty'")))).toBe('missing');
      expect(classifyNativeFailure(normalizeError(
        Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }),
      ))).toBe('missing');
    });

    it('falls back to a generic load error', () => {
      expect(classifyNativeFailure(normalizeError(new Error('unexpected')))).toBe('load_error');
    });
  });

  describe('failure message', () => {
    it('replaces the opaque trace with runtime facts and a recovery step', () => {
      const result = runNativePreflight(
        ['better-sqlite3'],
        failingLoader({
          'better-sqlite3': new Error('NODE_MODULE_VERSION 115 ... requires NODE_MODULE_VERSION 127'),
        }),
      );
      const text = formatNativeFailure(result.failures[0], result.runtime);

      expect(text).toContain('better-sqlite3 could not be loaded.');
      expect(text).toContain('Current runtime:');
      expect(text).toContain(`Node v${process.versions.node}`);
      expect(text).toContain(`ABI ${process.versions.modules}`);
      expect(text).toContain('Likely cause:');
      expect(text).toContain('built for a different runtime');
      expect(text).toContain('Recovery:');
      expect(text).toContain('npm rebuild better-sqlite3 node-pty');
    });

    it('suggests npm install when the package is simply absent', () => {
      const result = runNativePreflight(
        ['node-pty'],
        failingLoader({ 'node-pty': new Error("Cannot find module 'node-pty'") }),
      );
      expect(formatNativeFailure(result.failures[0], result.runtime)).toContain('npm install');
    });
  });

  describe('logging', () => {
    let sink: ReturnType<typeof capturingSink>;

    beforeEach(() => {
      sink = capturingSink();
      logger.configure({ level: 'debug', sinks: [sink] });
    });

    afterEach(() => {
      logger.configure({ level: 'info', dir: null });
    });

    it('logs one INFO line when the preflight passes', () => {
      const result = logNativePreflight(CRITICAL_NATIVE_MODULES, okLoader);
      expect(result.ok).toBe(true);
      const summary = sink.records.find(r => r.event === 'startup.native.preflight');
      expect(summary?.level).toBe('info');
      expect(summary?.fields.modules).toBe('better-sqlite3,node-pty');
    });

    it('logs an ERROR carrying the readable diagnosis when it fails', () => {
      const result = logNativePreflight(
        ['better-sqlite3'],
        failingLoader({ 'better-sqlite3': new Error('NODE_MODULE_VERSION 115 vs 127') }),
      );
      expect(result.ok).toBe(false);

      const failure = sink.records.find(r => r.event === 'startup.native.failed');
      expect(failure?.level).toBe('error');
      expect(failure?.scope).toBe('[startup/native]');
      expect(failure?.fields.kind).toBe('abi_mismatch');
      expect(failure?.detail).toContain('Recovery:');
      expect(sink.records.some(r => r.event === 'startup.native.preflight')).toBe(false);
    });
  });
});

describe('runtime info', () => {
  it('reports the runtime, node version and ABI of the current process', () => {
    const info = getRuntimeInfo();
    expect(info.runtime).toBe(process.versions.electron ? 'electron' : 'node');
    expect(info.nodeVersion).toBe(process.versions.node);
    expect(info.abi).toBe(process.versions.modules);
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('formats a single startup line', () => {
    const line = formatRuntimeLine();
    expect(line).toContain('runtime=');
    expect(line).toContain(`node=v${process.versions.node}`);
    expect(line).toContain(`abi=${process.versions.modules}`);
  });
});
