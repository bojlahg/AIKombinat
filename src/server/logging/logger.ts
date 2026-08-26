import { ConsoleSink } from './console-sink.js';
import { RotatingFileSink } from './file-sink.js';
import { getLogContext, joinScopes } from './context.js';
import { normalizeError } from './normalize-error.js';
import { resolveLogDir } from './paths.js';
import { redactFields, redactString } from './redact.js';
import { sanitizeLogLine, sanitizeLogScope } from './scope.js';
import { clampLine } from './truncate.js';
import { levelRank, parseLogLevel, type LogFields, type LogLevel, type LogRecord, type LogSink } from './types.js';

export interface LoggerConfigureOptions {
  level?: LogLevel;
  /** `null` disables the file sink; omitted keeps the resolved default. */
  dir?: string | null;
  /** Replaces every sink — tests use this to capture records. */
  sinks?: LogSink[];
}

export interface LoggerLike {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(scope: string | undefined, fields?: LogFields): LoggerLike;
}

const DEFAULT_LEVEL: LogLevel = 'info';

class Logger implements LoggerLike {
  private sinks: LogSink[] | null = null;
  private fileSink: RotatingFileSink | null = null;
  private level: LogLevel = DEFAULT_LEVEL;

  /**
   * Explicit configuration. Called by the server entrypoint before anything
   * else logs, and by tests to redirect output.
   */
  configure(options: LoggerConfigureOptions = {}): void {
    this.closeSinks();
    this.level = options.level ?? parseLogLevel(process.env.AIKOMBINAT_LOG_LEVEL, DEFAULT_LEVEL);

    if (options.sinks) {
      this.fileSink = null;
      this.sinks = options.sinks;
      return;
    }

    const sinks: LogSink[] = [new ConsoleSink()];
    const dir = options.dir === undefined ? resolveLogDir() : options.dir;
    if (dir) {
      this.fileSink = new RotatingFileSink({ dir });
      sinks.push(this.fileSink);
    } else {
      this.fileSink = null;
    }
    this.sinks = sinks;
  }

  /** Path of the active log file, or `null` when file logging is off. */
  get logFilePath(): string | null {
    this.ensureConfigured();
    return this.fileSink && !this.fileSink.isDisabled ? this.fileSink.path : null;
  }

  getLevel(): LogLevel {
    this.ensureConfigured();
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.ensureConfigured();
    this.level = level;
  }

  isLevelEnabled(level: LogLevel): boolean {
    this.ensureConfigured();
    return levelRank(level) >= levelRank(this.level);
  }

  debug(event: string, fields?: LogFields): void { this.emit('debug', event, fields); }
  info(event: string, fields?: LogFields): void { this.emit('info', event, fields); }
  warn(event: string, fields?: LogFields): void { this.emit('warn', event, fields); }
  error(event: string, fields?: LogFields): void { this.emit('error', event, fields); }

  child(scope: string | undefined, fields: LogFields = {}): LoggerLike {
    return new ChildLogger(this, scope, fields);
  }

  /** Drains buffered records to their sinks. */
  flush(): void {
    if (!this.sinks) return;
    for (const sink of this.sinks) {
      try { sink.flush?.(); } catch { /* a broken sink must not block shutdown */ }
    }
  }

  close(): void {
    this.closeSinks();
    this.sinks = null;
  }

  private closeSinks(): void {
    if (!this.sinks) return;
    for (const sink of this.sinks) {
      try { sink.close?.(); } catch { /* shutting down anyway */ }
    }
  }

  private ensureConfigured(): void {
    if (this.sinks) return;
    this.configure();
  }

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    this.ensureConfigured();
    if (levelRank(level) < levelRank(this.level)) return;

    const context = getLogContext();
    const merged: LogFields = { ...(context?.fields ?? {}), ...(fields ?? {}) };

    const { msg, scope, detail, err, ...rest } = merged;
    // Scope is assembled from user-controlled titles and agent names, so it is
    // redacted and flattened to one line here rather than at any call site.
    const scopeTag = sanitizeLogScope(
      joinScopes(context?.scope, typeof scope === 'string' ? scope : undefined),
    );

    const extra: Record<string, unknown> = { ...rest };
    let detailBlock = typeof detail === 'string' && detail ? redactString(detail) : undefined;

    if (err !== undefined && err !== null) {
      const normalized = normalizeError(err);
      if (extra.message === undefined) extra.message = clampLine(normalized.message);
      if (normalized.code !== undefined && extra.errorCode === undefined) extra.errorCode = normalized.code;
      if (normalized.name && extra.errorName === undefined) extra.errorName = normalized.name;
      if (normalized.cause && extra.errorCause === undefined) extra.errorCause = clampLine(normalized.cause.message);
      // A stack is noise in a terminal at INFO+; it stays available under DEBUG.
      if (normalized.stack && this.level === 'debug' && !detailBlock) {
        detailBlock = normalized.stack;
      }
    }

    const record: LogRecord = {
      time: new Date(),
      level,
      event,
      scope: scopeTag,
      msg: typeof msg === 'string' && msg ? sanitizeLogLine(redactString(msg)) : event,
      detail: detailBlock,
      fields: redactFields(extra),
    };

    for (const sink of this.sinks!) {
      try {
        sink.write(record);
      } catch { /* a broken sink must never break execution */ }
    }

    // Errors are exactly the records that must survive a crash landing next,
    // so they never wait in a buffer.
    if (level === 'error') this.flush();
  }
}

class ChildLogger implements LoggerLike {
  constructor(
    private readonly parent: Logger,
    private readonly scope: string | undefined,
    private readonly fields: LogFields,
  ) {}

  private merge(fields?: LogFields): LogFields {
    const merged: LogFields = { ...this.fields, ...(fields ?? {}) };
    const childScope = typeof merged.scope === 'string' ? merged.scope : undefined;
    const scope = joinScopes(this.scope, childScope);
    if (scope) merged.scope = scope;
    return merged;
  }

  debug(event: string, fields?: LogFields): void { this.parent.debug(event, this.merge(fields)); }
  info(event: string, fields?: LogFields): void { this.parent.info(event, this.merge(fields)); }
  warn(event: string, fields?: LogFields): void { this.parent.warn(event, this.merge(fields)); }
  error(event: string, fields?: LogFields): void { this.parent.error(event, this.merge(fields)); }

  child(scope: string | undefined, fields: LogFields = {}): LoggerLike {
    return new ChildLogger(this.parent, joinScopes(this.scope, scope), { ...this.fields, ...fields });
  }
}

export const logger = new Logger();
export type { Logger };
