import path from 'path';
import { logger } from '../logging/logger.js';
import { normalizeError } from '../logging/normalize-error.js';
import { formatRuntimeLine, getRuntimeInfo } from './runtime-info.js';

/**
 * Everything the operator needs before the server accepts a request: which
 * build is running, on which runtime, against which database, and where the
 * persistent log will be. Emitted before any other startup work so a crash a
 * moment later still leaves this in the terminal and in the file.
 */
export function logStartupDiagnostics(): void {
  const runtime = getRuntimeInfo();
  // The message already carries every value; repeating them as fields would
  // print each fact twice on the console line.
  logger.info('startup.version', {
    scope: '[startup]',
    msg: `AIKombinat ${runtime.appVersion}`,
  });
  logger.info('startup.runtime', {
    scope: '[startup]',
    msg: formatRuntimeLine(runtime),
  });

  const logPath = logger.logFilePath;
  logger.info('startup.paths', {
    scope: '[startup]',
    msg: 'paths resolved',
    database: resolveDatabasePathForDisplay(),
    log: logPath ?? '(file logging disabled)',
    logLevel: logger.getLevel(),
  });
}

/**
 * Mirrors the resolution in `db/connection.ts` for display purposes only — it
 * must not open or create anything.
 */
function resolveDatabasePathForDisplay(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return path.resolve(configured);
  return '(default: <repo>/aikombinat.db)';
}

export interface StartupBannerInfo {
  port: number;
  requestedPort: number;
  tunnelEnabled: boolean;
}

/**
 * The "server is running" banner.
 *
 * Printed raw rather than through a sink: it is a UI element, not a log record,
 * and it must stay readable in a plain terminal. The same facts are logged as a
 * record right after so the file keeps them too.
 */
export function printStartupBanner(info: StartupBannerInfo): void {
  const logPath = logger.logFilePath ?? '(file logging disabled)';
  const lines = [
    '',
    '========================================',
    ' AIKombinat server is running',
    ` URL:  http://localhost:${info.port}`,
    ...(info.port !== info.requestedPort
      ? [`       (port ${info.requestedPort} was in use)`]
      : []),
    ...(info.tunnelEnabled ? ['       Share link: (tunnel starting...)'] : []),
    ` Logs: ${logPath}`,
    '========================================',
    '',
    '    Login with the password you set on first run.',
    '    Press Ctrl+C to stop.',
    '',
  ];
  console.log(lines.join('\n'));

  logger.info('server.listening', {
    scope: '[server]',
    msg: `listening on http://localhost:${info.port}`,
    port: info.port,
    requestedPort: info.requestedPort,
    tunnelEnabled: info.tunnelEnabled,
    log: logPath,
  });
}

/**
 * Global safety net.
 *
 * A fatal error must be visible and durable: logged, flushed, and followed by a
 * non-zero exit. Swallowing it and "continuing somehow" is exactly the failure
 * mode this whole feature exists to remove.
 */
export function installCrashHandlers(options: { exit?: (code: number) => void } = {}): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let handling = false;

  const fatal = (event: string, err: unknown, extra: Record<string, unknown> = {}): void => {
    if (handling) return; // a throw inside the handler must not recurse
    handling = true;
    const normalized = normalizeError(err);
    logger.error(event, {
      scope: '[fatal]',
      msg: normalized.message,
      errorName: normalized.name,
      errorCode: normalized.code,
      ...extra,
      detail: normalized.stack,
    });
    logger.flush();
    exit(1);
  };

  process.on('uncaughtException', (err) => fatal('process.uncaught-exception', err));
  process.on('unhandledRejection', (reason) => fatal('process.unhandled-rejection', reason));
}

/** Flushes buffered records so a shutdown never loses the last lines. */
export function logShutdown(reason: string, extra: Record<string, unknown> = {}): void {
  logger.info('server.shutdown.requested', {
    scope: '[server]',
    msg: `shutdown requested (${reason})`,
    reason,
    ...extra,
  });
  logger.flush();
}
