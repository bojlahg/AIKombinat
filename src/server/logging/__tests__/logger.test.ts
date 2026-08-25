import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../logger.js';
import { RotatingFileSink } from '../file-sink.js';
import { ConsoleSink } from '../console-sink.js';
import { renderConsoleLine, renderFileLine } from '../format.js';
import { runWithLogContext, tag } from '../context.js';
import { normalizeError, formatErrorSummary } from '../normalize-error.js';
import { tailOf, clampLine, DEFAULT_OUTPUT_TAIL_BYTES } from '../truncate.js';
import { redactString, redactFields, redactArgs, isSecretKey, resetRedactionCache, REDACTED } from '../redact.js';
import { rotatedFileName, resolveLogDir, LOG_FILE_NAME } from '../paths.js';
import type { LogRecord, LogSink } from '../types.js';

function capturingSink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (record) => { records.push(record); } };
}

describe('logger', () => {
  let sink: ReturnType<typeof capturingSink>;

  beforeEach(() => {
    sink = capturingSink();
    logger.configure({ level: 'debug', sinks: [sink] });
  });

  afterEach(() => {
    logger.configure({ level: 'info', dir: null });
  });

  it('emits structured records with event, level and fields', () => {
    logger.info('forum.turn.started', {
      msg: 'turn started',
      scope: '[forum:test][Claude]',
      provider: 'claude',
      model: 'claude-opus-5',
    });

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    expect(record.level).toBe('info');
    expect(record.event).toBe('forum.turn.started');
    expect(record.msg).toBe('turn started');
    expect(record.scope).toBe('[forum:test][Claude]');
    expect(record.fields).toMatchObject({ provider: 'claude', model: 'claude-opus-5' });
  });

  it('falls back to the event name when no message is supplied', () => {
    logger.warn('provider.quota.exhausted', { provider: 'claude' });
    expect(sink.records[0].msg).toBe('provider.quota.exhausted');
  });

  it('drops records below the configured level', () => {
    logger.configure({ level: 'warn', sinks: [sink] });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(sink.records.map(r => r.event)).toEqual(['c', 'd']);
  });

  it('never lets a broken sink break the caller', () => {
    const broken: LogSink = { write: () => { throw new Error('sink exploded'); } };
    logger.configure({ level: 'info', sinks: [broken, sink] });
    expect(() => logger.info('still.works')).not.toThrow();
    expect(sink.records[0].event).toBe('still.works');
  });

  describe('console formatting', () => {
    it('renders level, scope, message and key=value pairs', () => {
      logger.info('forum.turn.started', {
        msg: 'turn started',
        scope: '[forum:test][Claude]',
        provider: 'claude',
        effort: 'high',
      });
      const line = renderConsoleLine(sink.records[0]);
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO {2}\[forum:test]\[Claude] turn started /);
      expect(line).toContain('provider=claude');
      expect(line).toContain('effort=high');
    });

    it('renders ERROR with an indented detail block', () => {
      logger.error('forum.turn.failed', {
        msg: 'FAILED after 1.42s',
        scope: '[forum:test][Claude]',
        category: 'auth_error',
        exitCode: 1,
        detail: 'Please login...',
      });
      const line = renderConsoleLine(sink.records[0]);
      expect(line).toContain('ERROR [forum:test][Claude] FAILED after 1.42s');
      expect(line).toContain('category=auth_error');
      expect(line).toContain('exitCode=1');
      expect(line).toContain('\n  Please login...');
    });

    it('keeps correlation ids out of the console line but in the file line', () => {
      logger.info('forum.turn.started', {
        msg: 'turn started',
        forumId: 'forum-abc',
        turnId: 'turn-xyz',
        provider: 'claude',
      });
      const record = sink.records[0];
      expect(renderConsoleLine(record)).not.toContain('forum-abc');
      expect(renderConsoleLine(record)).not.toContain('turn-xyz');
      expect(renderFileLine(record)).toContain('forumId=forum-abc');
      expect(renderFileLine(record)).toContain('turnId=turn-xyz');
    });

    it('renders the file line with an ISO timestamp and the event name', () => {
      logger.error('forum.turn.failed', { msg: 'FAILED', durationMs: 1766, exitCode: 1 });
      const line = renderFileLine(sink.records[0]);
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} ERROR forum\.turn\.failed /);
      expect(line).toContain('durationMs=1766');
    });

    it('routes warn and error to stderr, everything else to stdout', () => {
      const out: string[] = [];
      const err: string[] = [];
      const consoleSink = new ConsoleSink({ out: l => out.push(l), err: l => err.push(l) });
      logger.configure({ level: 'debug', sinks: [consoleSink] });
      logger.info('a');
      logger.debug('b');
      logger.warn('c');
      logger.error('d');
      expect(out).toHaveLength(2);
      expect(err).toHaveLength(2);
      expect(err[1]).toContain('ERROR');
    });
  });

  describe('error normalization', () => {
    it('keeps message, name, code and cause', () => {
      const cause = new Error('socket closed');
      const err = Object.assign(new Error('spawn failed'), { code: 'ENOENT', cause });
      const normalized = normalizeError(err);
      expect(normalized.message).toBe('spawn failed');
      expect(normalized.name).toBe('Error');
      expect(normalized.code).toBe('ENOENT');
      expect(normalized.cause?.message).toBe('socket closed');
      expect(normalized.stack).toContain('spawn failed');
    });

    it('handles non-Error throws without losing information', () => {
      expect(normalizeError('boom').message).toBe('boom');
      expect(normalizeError({ message: 'obj boom', code: 42 })).toMatchObject({ message: 'obj boom', code: 42 });
      expect(normalizeError(undefined).message).toBe('undefined');
      expect(normalizeError({ weird: true }).message).toBe('{"weird":true}');
    });

    it('summarizes an error on one line', () => {
      const err = Object.assign(new Error('nope'), { code: 'EPERM' });
      expect(formatErrorSummary(err)).toBe('nope (EPERM)');
    });

    it('lifts an err field into message/errorCode fields', () => {
      logger.error('cli.spawn.failed', { err: Object.assign(new Error('not on PATH'), { code: 'ENOENT' }) });
      expect(sink.records[0].fields).toMatchObject({ message: 'not on PATH', errorCode: 'ENOENT', errorName: 'Error' });
    });
  });

  describe('redaction', () => {
    beforeEach(() => { resetRedactionCache(); });

    it('recognizes secret-looking keys but not token counters', () => {
      expect(isSecretKey('authorization')).toBe(true);
      expect(isSecretKey('x-api-key')).toBe(true);
      expect(isSecretKey('refreshToken')).toBe(true);
      expect(isSecretKey('SESSION_SECRET')).toBe(true);
      expect(isSecretKey('tokenCount')).toBe(false);
      expect(isSecretKey('provider')).toBe(false);
    });

    it('drops secret metadata values, including nested ones', () => {
      const out = redactFields({
        provider: 'claude',
        apiKey: 'super-secret-value',
        nested: { password: 'hunter2', model: 'opus' },
      });
      expect(out.provider).toBe('claude');
      expect(out.apiKey).toBe(REDACTED);
      expect(out.nested).toEqual({ password: REDACTED, model: 'opus' });
    });

    it('scrubs credentials embedded in free-form strings', () => {
      expect(redactString('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890');
      expect(redactString('token=abcdef123456 next')).toContain(REDACTED);
      expect(redactString('use sk-ant-0123456789abcdef now')).not.toContain('sk-ant-0123456789abcdef');
    });

    it('scrubs known secret env values wherever they appear', () => {
      process.env.SESSION_SECRET = 'topsecretvalue123';
      resetRedactionCache();
      try {
        expect(redactString('leaked topsecretvalue123 here')).toBe(`leaked ${REDACTED} here`);
      } finally {
        delete process.env.SESSION_SECRET;
        resetRedactionCache();
      }
    });

    it('redacts both --flag=value and --flag value argv forms', () => {
      expect(redactArgs(['--model', 'opus', '--api-key', 'abc123', '--token=xyz789']))
        .toEqual(['--model', 'opus', '--api-key', REDACTED, `--token=${REDACTED}`]);
    });

    it('applies redaction to records passing through the logger', () => {
      logger.info('cli.spawn.requested', { apiKey: 'leak-me', args: '--api-key sekrit-value' });
      expect(sink.records[0].fields.apiKey).toBe(REDACTED);
      expect(String(sink.records[0].fields.args)).not.toContain('sekrit-value');
    });
  });

  describe('truncation', () => {
    it('returns short text unchanged', () => {
      expect(tailOf('short')).toBe('short');
    });

    it('keeps only the tail of oversized output and says how much was dropped', () => {
      const big = 'x'.repeat(DEFAULT_OUTPUT_TAIL_BYTES + 500);
      const out = tailOf(big);
      expect(out).toContain('truncated, 500 byte(s) omitted');
      expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(Buffer.byteLength(big, 'utf-8'));
    });

    it('never exceeds the absolute cap even when asked to', () => {
      const big = 'y'.repeat(200_000);
      expect(Buffer.byteLength(tailOf(big, 1_000_000), 'utf-8')).toBeLessThan(70_000);
    });

    it('clamps a multi-line reason to a single line', () => {
      expect(clampLine('one\n  two\nthree')).toBe('one two three');
      expect(clampLine('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}...`);
    });
  });

  describe('execution context', () => {
    it('merges ambient scope and correlation ids into records', () => {
      runWithLogContext({ scope: tag('forum', 'test'), fields: { forumId: 'f1' } }, () => {
        runWithLogContext({ scope: '[Claude]', fields: { turnId: 't1' } }, () => {
          logger.info('cli.spawned', { msg: 'started', provider: 'claude' });
        });
      });
      const record = sink.records[0];
      expect(record.scope).toBe('[forum:test][Claude]');
      expect(record.fields).toMatchObject({ forumId: 'f1', turnId: 't1', provider: 'claude' });
    });

    it('lets an explicit field override the ambient one', () => {
      runWithLogContext({ fields: { provider: 'claude' } }, () => {
        logger.info('x', { provider: 'codex' });
      });
      expect(sink.records[0].fields.provider).toBe('codex');
    });

    it('shortens an over-long tag label', () => {
      expect(tag('forum', 'a'.repeat(80))).toBe(`[forum:${'a'.repeat(40)}...]`);
      expect(tag('forum', '')).toBe('[forum]');
    });

    it('scopes a child logger without touching the parent', () => {
      const child = logger.child('[review:round-3]', { roundId: 'r3' });
      child.warn('review.needs-changes', { issues: 2 });
      logger.info('unscoped');
      expect(sink.records[0].scope).toBe('[review:round-3]');
      expect(sink.records[0].fields).toMatchObject({ roundId: 'r3', issues: 2 });
      expect(sink.records[1].scope).toBe('');
    });
  });
});

describe('rotating file sink', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-log-test-'));
  });

  afterEach(() => {
    logger.configure({ level: 'info', dir: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes records to the log file on flush', () => {
    const fileSink = new RotatingFileSink({ dir });
    logger.configure({ level: 'info', sinks: [fileSink] });
    logger.info('server.listening', { msg: 'listening on http://localhost:3000', port: 3000 });
    logger.flush();

    const content = fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf-8');
    expect(content).toContain('server.listening');
    expect(content).toContain('port=3000');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('flushes ERROR records immediately, without waiting for the buffer', () => {
    const fileSink = new RotatingFileSink({ dir });
    logger.configure({ level: 'info', sinks: [fileSink] });
    logger.error('startup.native.failed', { msg: 'better-sqlite3 could not be loaded' });
    // No explicit flush: a fatal record must already be on disk.
    expect(fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf-8')).toContain('startup.native.failed');
  });

  it('rotates once the file exceeds the size cap and retains a bounded history', () => {
    const fileSink = new RotatingFileSink({ dir, maxBytes: 400, maxFiles: 4 });
    for (let i = 0; i < 40; i++) {
      fileSink.write({
        time: new Date(),
        level: 'info',
        event: 'test.rotation',
        scope: '',
        msg: `line ${i} ${'p'.repeat(60)}`,
        fields: {},
      });
      fileSink.flush();
    }

    const files = fs.readdirSync(dir).sort();
    expect(files).toContain(LOG_FILE_NAME);
    expect(files).toContain(rotatedFileName(1));
    // Never more than maxFiles, and the dropped generation is really gone.
    expect(files.length).toBeLessThanOrEqual(4);
    expect(files).not.toContain(rotatedFileName(4));
    for (const file of files) {
      expect(fs.statSync(path.join(dir, file)).size).toBeLessThan(4000);
    }
  });

  it('disables itself instead of throwing when the file cannot be written', () => {
    // A path whose parent is a file, not a directory: mkdir must fail.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const fileSink = new RotatingFileSink({ dir: path.join(blocker, 'logs') });
    expect(() => {
      fileSink.write({ time: new Date(), level: 'info', event: 'e', scope: '', msg: 'm', fields: {} });
      fileSink.flush();
    }).not.toThrow();
    expect(fileSink.isDisabled).toBe(true);
  });

  it('exposes the active log file path for the startup banner', () => {
    logger.configure({ level: 'info', dir });
    expect(logger.logFilePath).toBe(path.join(dir, LOG_FILE_NAME));
  });
});

describe('log directory resolution', () => {
  const savedLogDir = process.env.AIKOMBINAT_LOG_DIR;
  const savedDbPath = process.env.DB_PATH;

  afterEach(() => {
    if (savedLogDir === undefined) delete process.env.AIKOMBINAT_LOG_DIR;
    else process.env.AIKOMBINAT_LOG_DIR = savedLogDir;
    if (savedDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = savedDbPath;
  });

  it('prefers an explicit AIKOMBINAT_LOG_DIR', () => {
    const dir = path.join(os.tmpdir(), 'aikombinat-explicit-logs');
    process.env.AIKOMBINAT_LOG_DIR = dir;
    expect(resolveLogDir()).toBe(path.resolve(dir));
  });

  it('stays disabled under the test runner so no stray file is written', () => {
    delete process.env.AIKOMBINAT_LOG_DIR;
    process.env.DB_PATH = path.join(os.tmpdir(), 'whatever', 'aikombinat.db');
    expect(resolveLogDir()).toBeNull();
  });

  it('names rotated files predictably', () => {
    expect(rotatedFileName(0)).toBe('aikombinat.log');
    expect(rotatedFileName(1)).toBe('aikombinat.1.log');
    expect(rotatedFileName(3)).toBe('aikombinat.3.log');
  });
});
