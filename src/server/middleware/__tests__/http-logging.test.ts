import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { logger } from '../../logging/logger.js';
import type { LogRecord, LogSink } from '../../logging/types.js';
import { levelForStatus, routePattern, httpStatusLogger, httpErrorLogger } from '../http-logging.js';

function capturingSink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (record) => { records.push(record); } };
}

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    originalUrl: '/api/agent-forums/forum-1/messages?token=abc',
    url: '/api/agent-forums/forum-1/messages',
    baseUrl: '',
    ...overrides,
  } as Request;
}

function fakeResponse(statusCode: number) {
  const emitter = new EventEmitter();
  const res = emitter as unknown as Response & { finish: () => void };
  Object.assign(res, {
    statusCode,
    locals: {} as Record<string, unknown>,
    headersSent: false,
    status(code: number) { (res as unknown as { statusCode: number }).statusCode = code; return res; },
    json(body: unknown) { (res as unknown as { body: unknown }).body = body; return res; },
    finish() { emitter.emit('finish'); },
  });
  return res;
}

describe('http logging policy', () => {
  it('does not log successful responses at all', () => {
    expect(levelForStatus(200)).toBeNull();
    expect(levelForStatus(304)).toBeNull();
  });

  it('treats ordinary client rejections as DEBUG, not failures', () => {
    expect(levelForStatus(400)).toBe('debug');
    expect(levelForStatus(401)).toBe('debug');
    expect(levelForStatus(404)).toBe('debug');
  });

  it('raises conflicts and incomplete-stop responses to WARN', () => {
    expect(levelForStatus(409)).toBe('warn');
    expect(levelForStatus(503)).toBe('warn');
  });

  it('treats unexpected server failures as ERROR', () => {
    expect(levelForStatus(500)).toBe('error');
    expect(levelForStatus(502)).toBe('error');
  });

  it('prefers the mounted route pattern and never keeps the query string', () => {
    expect(routePattern(fakeRequest())).toBe('/api/agent-forums/forum-1/messages');
    const withRoute = fakeRequest({ baseUrl: '/api' });
    (withRoute as Request & { route?: { path: string } }).route = { path: '/todos/:id' };
    expect(routePattern(withRoute)).toBe('/api/todos/:id');
  });
});

describe('http logging middleware', () => {
  let sink: ReturnType<typeof capturingSink>;

  beforeEach(() => {
    sink = capturingSink();
    logger.configure({ level: 'debug', sinks: [sink] });
  });

  afterEach(() => {
    logger.configure({ level: 'info', dir: null });
  });

  it('logs a failed response with method, route and status', () => {
    const req = fakeRequest();
    const res = fakeResponse(409);
    let nextCalled = false;
    httpStatusLogger(req, res, () => { nextCalled = true; });
    res.finish();

    expect(nextCalled).toBe(true);
    const record = sink.records.find(r => r.event === 'http.response');
    expect(record?.level).toBe('warn');
    expect(record?.fields).toMatchObject({ method: 'POST', status: 409 });
    expect(record?.msg).toContain('/api/agent-forums/forum-1/messages -> 409');
    expect(record?.msg).not.toContain('token=abc');
  });

  it('stays silent for successful responses', () => {
    const res = fakeResponse(200);
    httpStatusLogger(fakeRequest(), res, () => {});
    res.finish();
    expect(sink.records).toHaveLength(0);
  });

  it('logs a thrown error as ERROR with the stack in the detail block', () => {
    const req = fakeRequest();
    const res = fakeResponse(200);
    httpErrorLogger(new Error('database is locked'), req, res, () => {});

    const record = sink.records.find(r => r.event === 'http.error');
    expect(record?.level).toBe('error');
    expect(record?.fields).toMatchObject({ status: 500, method: 'POST', errorName: 'Error' });
    expect(record?.detail).toContain('database is locked');
    expect((res as unknown as { statusCode: number }).statusCode).toBe(500);
    expect((res as unknown as { body: { error: string } }).body).toEqual({ error: 'Internal server error' });
  });

  it('does not double-log a response the error handler already reported', () => {
    const req = fakeRequest();
    const res = fakeResponse(200);
    httpStatusLogger(req, res, () => {});
    httpErrorLogger(new Error('boom'), req, res, () => {});
    res.finish();

    expect(sink.records.filter(r => r.event === 'http.response')).toHaveLength(0);
    expect(sink.records.filter(r => r.event === 'http.error')).toHaveLength(1);
  });

  it('passes an explicit error status through instead of forcing 500', () => {
    const req = fakeRequest();
    const res = fakeResponse(200);
    httpErrorLogger(Object.assign(new Error('conflict'), { status: 409 }), req, res, () => {});

    const record = sink.records.find(r => r.event === 'http.error');
    expect(record?.level).toBe('warn');
    expect((res as unknown as { body: { error: string } }).body).toEqual({ error: 'conflict' });
  });
});
