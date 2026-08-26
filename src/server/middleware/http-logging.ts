import type { ErrorRequestHandler, RequestHandler, Request, Response } from 'express';
import { logger } from '../logging/logger.js';
import { normalizeError } from '../logging/normalize-error.js';
import { redactString } from '../logging/redact.js';
import { clampLine } from '../logging/truncate.js';
import type { LogLevel } from '../logging/types.js';

/**
 * HTTP diagnostics.
 *
 * A 4xx is usually the client being told "no", not a fault worth an ERROR line,
 * so the level follows the status class rather than the mere fact of failure.
 * Request bodies are never logged — they carry prompts, project content and
 * credentials.
 */
export function levelForStatus(status: number): LogLevel | null {
  if (status < 400) return null;
  if (status === 401 || status === 403 || status === 404) return 'debug';
  if (status === 409) return 'warn';
  if (status < 500) return 'debug';
  if (status === 503) return 'warn';
  return 'error';
}

/**
 * Route pattern when Express resolved one (`/api/todos/:id`), otherwise the
 * path with the query string dropped — query strings must never reach a log.
 */
export function routePattern(req: Request): string {
  const mounted = (req as Request & { route?: { path?: string } }).route?.path;
  if (mounted) return `${req.baseUrl || ''}${mounted}`;
  return (req.originalUrl || req.url || '').split('?')[0];
}

/** Cap for the extracted reason — a diagnostic hint, never a payload dump. */
export const MAX_FAILURE_REASON_CHARS = 300;

/**
 * Pulls a safe, human-readable reason out of a failure response body.
 *
 * Deliberately narrow: only a top-level string `error` or `message`, which is
 * the shape every route in this codebase uses for its failure payloads. Nothing
 * else is read, so a route that happens to return records, tokens or file
 * contents alongside its error cannot leak them into the log.
 */
export function extractFailureReason(body: unknown): string | undefined {
  if (typeof body === 'string') return clampReason(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const candidate = typeof record.error === 'string'
    ? record.error
    : typeof record.message === 'string'
      ? record.message
      : undefined;
  return candidate === undefined ? undefined : clampReason(candidate);
}

function clampReason(value: string): string | undefined {
  const reason = clampLine(redactString(value), MAX_FAILURE_REASON_CHARS);
  return reason.length > 0 ? reason : undefined;
}

/**
 * Logs failed responses, including the ones routes produce directly with
 * `res.status(409).json(...)` — those never reach an error handler, so without
 * this their reason would exist only inside the HTTP response.
 */
export const httpStatusLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();

  // Intercept only to read a failure reason back out; the body itself is passed
  // through untouched and is never logged.
  const originalJson = res.json.bind(res) as Response['json'];
  res.json = function loggedJson(this: Response, body?: unknown) {
    if (res.statusCode >= 400 && res.locals.failureReason === undefined) {
      res.locals.failureReason = extractFailureReason(body);
    }
    return originalJson(body);
  } as Response['json'];

  res.on('finish', () => {
    const level = levelForStatus(res.statusCode);
    if (!level) return;
    // A thrown error is reported in full by `httpErrorLogger`; don't double-log.
    if (res.locals.loggedByErrorHandler) return;
    const reason = res.locals.failureReason as string | undefined;
    const route = routePattern(req);
    logger[level]('http.response', {
      scope: '[http]',
      msg: `${req.method} ${route} -> ${res.statusCode}`,
      method: req.method,
      route,
      status: res.statusCode,
      ...(reason ? { message: reason } : {}),
      durationMs: Date.now() - startedAt,
    });
  });

  next();
};

/**
 * Terminal error handler. Anything reaching here is an unexpected backend
 * failure, so it is always an ERROR with the execution context attached.
 */
export const httpErrorLogger: ErrorRequestHandler = (err, req, res, next) => {
  const normalized = normalizeError(err);
  const status = typeof (err as { status?: number })?.status === 'number'
    ? (err as { status: number }).status
    : 500;

  res.locals.loggedByErrorHandler = true;
  const route = routePattern(req);
  const level = levelForStatus(status) ?? 'error';
  logger[level]('http.error', {
    scope: '[http]',
    msg: `${req.method} ${route} -> ${status} ${normalized.message}`,
    method: req.method,
    route,
    status,
    message: clampLine(normalized.message, MAX_FAILURE_REASON_CHARS),
    errorName: normalized.name,
    errorCode: normalized.code,
    detail: normalized.stack,
  });

  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : normalized.message });
};
