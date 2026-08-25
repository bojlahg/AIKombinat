import { redactString } from './redact.js';

/**
 * Every subsystem used to do its own `err instanceof Error ? err.message :
 * String(err)` and lose the code / cause / stack in the process. This is the
 * one place that turns an unknown throw into something loggable.
 */
export interface NormalizedError {
  message: string;
  name?: string;
  code?: string | number;
  stack?: string;
  cause?: NormalizedError;
}

const MAX_CAUSE_DEPTH = 4;

export function normalizeError(err: unknown, depth = 0): NormalizedError {
  if (err instanceof Error) {
    const withExtras = err as Error & { code?: string | number; cause?: unknown };
    const normalized: NormalizedError = {
      message: redactString(err.message || err.name || 'Error'),
      name: err.name,
    };
    if (withExtras.code !== undefined && (typeof withExtras.code === 'string' || typeof withExtras.code === 'number')) {
      normalized.code = withExtras.code;
    }
    if (err.stack) normalized.stack = redactString(err.stack);
    if (withExtras.cause !== undefined && withExtras.cause !== null && depth < MAX_CAUSE_DEPTH) {
      normalized.cause = normalizeError(withExtras.cause, depth + 1);
    }
    return normalized;
  }

  if (err === null || err === undefined) {
    return { message: String(err) };
  }

  if (typeof err === 'object') {
    const record = err as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : safeStringify(record);
    const normalized: NormalizedError = { message: redactString(message) };
    if (typeof record.name === 'string') normalized.name = record.name;
    if (typeof record.code === 'string' || typeof record.code === 'number') normalized.code = record.code;
    if (typeof record.stack === 'string') normalized.stack = redactString(record.stack);
    if (record.cause !== undefined && record.cause !== null && depth < MAX_CAUSE_DEPTH) {
      normalized.cause = normalizeError(record.cause, depth + 1);
    }
    return normalized;
  }

  return { message: redactString(String(err)) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Short single-line form: `message (ENOENT)` — used in console output. */
export function formatErrorSummary(err: unknown): string {
  const normalized = normalizeError(err);
  const parts = [normalized.message];
  if (normalized.code !== undefined) parts.push(`(${normalized.code})`);
  if (normalized.cause) parts.push(`<- ${normalized.cause.message}`);
  return parts.join(' ');
}
