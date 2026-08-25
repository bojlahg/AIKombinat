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
