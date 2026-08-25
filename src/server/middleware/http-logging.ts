import type { ErrorRequestHandler, RequestHandler, Request } from 'express';
import { logger } from '../logging/logger.js';
import { normalizeError } from '../logging/normalize-error.js';
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

/**
 * Logs failed responses, including the ones routes produce directly with
 * `res.status(409).json(...)` — those never reach an error handler.
 */
export const httpStatusLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const level = levelForStatus(res.statusCode);
    if (!level) return;
    // A thrown error is reported in full by `httpErrorLogger`; don't double-log.
    if (res.locals.loggedByErrorHandler) return;
    logger[level]('http.response', {
      scope: '[http]',
      msg: `${req.method} ${routePattern(req)} -> ${res.statusCode}`,
      method: req.method,
      route: routePattern(req),
      status: res.statusCode,
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
  const level = levelForStatus(status) ?? 'error';
  logger[level]('http.error', {
    scope: '[http]',
    msg: `${req.method} ${routePattern(req)} -> ${status} ${normalized.message}`,
    method: req.method,
    route: routePattern(req),
    status,
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
