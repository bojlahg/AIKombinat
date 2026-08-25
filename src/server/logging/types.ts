/**
 * Shared vocabulary for the unified diagnostics/logging layer.
 *
 * The logger observes existing behaviour — it never becomes a state machine of
 * its own — so everything here is deliberately data-only.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function levelRank(level: LogLevel): number {
  return LEVEL_RANK[level];
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'warning') return 'warn';
  if (normalized === 'verbose' || normalized === 'trace') return 'debug';
  return isLogLevel(normalized) ? normalized : fallback;
}

/**
 * Structured metadata for one log call.
 *
 * Reserved keys shape the rendered output; everything else is emitted as
 * `key=value` pairs after redaction.
 */
export interface LogFields {
  /** Human-readable console line. Defaults to the event name. */
  msg?: string;
  /** Console context tag, e.g. `forum:test` or `todo:Fix login`. */
  scope?: string;
  /** Extra block rendered indented under the main line (stderr tails, hints). */
  detail?: string;
  /** Any error-ish value; normalized before rendering. */
  err?: unknown;
  [key: string]: unknown;
}

export interface LogRecord {
  time: Date;
  level: LogLevel;
  /** Stable machine-readable event name, e.g. `forum.turn.failed`. */
  event: string;
  /** Console context tag; empty string when the caller supplied none. */
  scope: string;
  msg: string;
  detail?: string;
  /** Already redacted, already flattened. */
  fields: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): void;
  close?(): void;
}
