/**
 * First module evaluated by the server entrypoint.
 *
 * Everything here runs *before* the rest of the import graph is pulled in,
 * which is the whole point: `better-sqlite3` and `node-pty` are static imports
 * deeper down, so a runtime/ABI mismatch would otherwise blow up during module
 * loading with an opaque dlopen trace and no log file to show for it.
 *
 * Keep this file free of any import that reaches a native addon.
 */
import { logger } from './logging/logger.js';
import { logNativePreflight } from './services/native-preflight.js';
import { installCrashHandlers, logStartupDiagnostics } from './services/startup-diagnostics.js';

logger.configure();
installCrashHandlers();
logStartupDiagnostics();

const preflight = logNativePreflight();
if (!preflight.ok) {
  logger.error('startup.aborted', {
    scope: '[startup]',
    msg: 'startup aborted: critical native modules are not usable with this runtime',
    failed: preflight.failures.map(f => f.name).join(','),
  });
  logger.flush();
  process.exit(1);
}

export {};
