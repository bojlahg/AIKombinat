import fs from 'fs';
import { spawn } from 'child_process';
import treeKill from 'tree-kill';
import { isTestEnvironment } from './cli-guard.js';

export const UNEXPECTED_PROCESS_KILL_MESSAGE =
  'Unexpected real process termination from test. Install an explicit mock for this test.';

/**
 * Liveness probe. Signal 0 performs permission/existence checks without
 * delivering a signal, so this never affects the target process.
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail-closed guard: a test must never terminate a real OS process tree.
 * Mirrors `assertExternalAiCliAllowed` — tests that exercise a termination path
 * are expected to stub `terminateProcessTree` (or the caller) explicitly.
 */
export function assertTestProcessKillAllowed(): void {
  if (isTestEnvironment()) {
    throw new Error(UNEXPECTED_PROCESS_KILL_MESSAGE);
  }
}

export interface TerminateProcessTreeOptions {
  /** Grace period before escalating from SIGTERM to SIGKILL. */
  escalateAfterMs?: number;
  /** Hard deadline after which we stop waiting and report failure. */
  timeoutMs?: number;
  /** Liveness poll interval. */
  pollIntervalMs?: number;
}

/**
 * Terminates a whole process tree by PID, without requiring the process to be
 * registered in any in-memory bookkeeping.
 *
 * This is the orphan-recovery counterpart to `ClaudeManager.stopClaude`, which
 * returns immediately for a PID it does not own — after an application restart
 * that map is empty, so every previously-spawned CLI would be left running.
 * Killing the tree (not just the PID) matters on Windows, where CLIs are
 * wrapped in a `cmd.exe` shim.
 *
 * Best-effort: returns true when the process is confirmed gone, false when it
 * survived the deadline or could not be signalled.
 */
export async function terminateProcessTree(
  pid: number,
  options: TerminateProcessTreeOptions = {},
): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  assertTestProcessKillAllowed();

  const escalateAfterMs = options.escalateAfterMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;

  if (!isProcessAlive(pid)) return true;

  try { treeKill(pid, 'SIGTERM'); } catch { /* already gone or not permitted */ }

  const startedAt = Date.now();
  let escalated = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true;

    if (!escalated && Date.now() - startedAt >= escalateAfterMs) {
      escalated = true;
      try { treeKill(pid, 'SIGKILL'); } catch { /* already gone or not permitted */ }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return !isProcessAlive(pid);
}

// ── Process instance identity ──────────────────────────────────────────────
//
// A PID alone is not a safe target. The OS reuses PIDs, so a numeric id
// persisted before a restart may belong to a completely unrelated process by
// the time recovery runs. Signalling it would kill a bystander.
//
// The discriminator is the OS-reported process creation time, which is unique
// per process instance for a given PID. We read it once at spawn, persist it,
// and compare it against a fresh read before ever signalling. The values are
// only ever compared against each other, so their format never has to be
// parsed — which keeps this free of locale and platform date quirks.

/** Instance-specific fingerprint of one OS process. */
export interface ProcessIdentity {
  pid: number;
  /**
   * OS-reported creation time, in whatever native representation the platform
   * gives us. Opaque: only ever compared with another reading from the same
   * machine, never parsed.
   */
  startedAt: string;
  /** Executable / command name as reported by the OS, when available. */
  command?: string | null;
}

export type ProcessIdentityVerdict = 'match' | 'mismatch' | 'unverifiable';

function runIdentityProbe(command: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }

    let out = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { out += chunk; });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** Linux: /proc gives creation time with no subprocess and tick resolution. */
function readProcIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces or ')',
    // so fields are counted from after the LAST ')'. starttime is field 22,
    // i.e. index 19 of what follows.
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const startTicks = tail[19];
    if (!startTicks) return null;
    let command: string | null = null;
    try { command = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null; } catch { command = null; }
    return { pid, startedAt: startTicks, command };
  } catch {
    return null;
  }
}

/**
 * Reads the instance fingerprint of a live process, or null when it cannot be
 * determined (process gone, tooling unavailable, probe failed).
 *
 * Returns null in test environments without inspecting anything, so tests never
 * spawn probe processes; a null identity is unverifiable and therefore
 * fail-closed at the call site.
 */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!pid || pid <= 0) return null;
  if (isTestEnvironment()) return null;

  if (process.platform === 'linux') {
    return readProcIdentity(pid);
  }

  if (process.platform === 'win32') {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; `
      + 'if ($p) { "{0}`t{1}" -f $p.CreationDate.ToUniversalTime().ToString("o"), $p.Name }';
    const out = await runIdentityProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (!out) return null;
    const [startedAt, command] = out.split('\t');
    if (!startedAt) return null;
    return { pid, startedAt: startedAt.trim(), command: command?.trim() || null };
  }

  // macOS and other POSIX: `ps` reports the absolute start time of the process.
  const out = await runIdentityProbe('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (!out) return null;
  return { pid, startedAt: out.replace(/\s+/g, ' ').trim(), command: null };
}

/**
 * Decides whether the process currently at `pid` is the same instance that
 * `expected` describes.
 *
 * Deliberately asymmetric: only a positive, confirmed match authorises a
 * signal. A missing expectation, an unreadable current identity or any probe
 * failure yields `unverifiable`, and callers must treat that exactly like a
 * mismatch. Leaving a genuine orphan alive is recoverable; killing an unrelated
 * process that inherited the PID is not.
 */
export async function verifyProcessIdentity(
  pid: number,
  expected: ProcessIdentity | null | undefined,
): Promise<ProcessIdentityVerdict> {
  if (!pid || pid <= 0) return 'unverifiable';
  if (!expected || typeof expected.startedAt !== 'string' || !expected.startedAt) return 'unverifiable';
  if (typeof expected.pid === 'number' && expected.pid !== pid) return 'mismatch';

  let current: ProcessIdentity | null;
  try {
    current = await readProcessIdentity(pid);
  } catch {
    return 'unverifiable';
  }
  if (!current || !current.startedAt) return 'unverifiable';

  if (current.startedAt !== expected.startedAt) return 'mismatch';
  // Command is a secondary check only: absent on some platforms, and never
  // sufficient on its own.
  if (expected.command && current.command && expected.command !== current.command) return 'mismatch';

  return 'match';
}

/** Parses a persisted identity blob. Malformed input is unverifiable, not fatal. */
export function parseProcessIdentity(serialized: string | null | undefined): ProcessIdentity | null {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as Partial<ProcessIdentity>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.startedAt !== 'string' || !parsed.startedAt) return null;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      command: typeof parsed.command === 'string' ? parsed.command : null,
    };
  } catch {
    return null;
  }
}
