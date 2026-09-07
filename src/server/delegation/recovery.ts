import { claudeManager } from '../services/claude-manager.js';
import { isProcessAlive, verifyProcessIdentity, type ProcessIdentity } from '../utils/process-tree.js';
import { logger } from '../logging/logger.js';
import { executorPool } from '../services/executor-pool.js';
import {
  getDelegationRunsWithPersistedProcess, updateOwnedDelegationRun,
  type DelegationProcessOwnership,
} from './store.js';

export interface DelegationRecoveryReport { reconciled: number; recoveryRequired: number }

let recoveryFlight: Promise<DelegationRecoveryReport> | null = null;

async function runDelegationRecovery(): Promise<DelegationRecoveryReport> {
  let reconciled = 0;
  let recoveryRequired = 0;
  const rows = getDelegationRunsWithPersistedProcess();
  for (const row of rows) {
    const pid = row.process_pid!;
    const ownership: DelegationProcessOwnership = { pid, processIdentity: row.process_identity };
    const release = (errorCode: string) => {
      const terminal = row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled';
      const changed = updateOwnedDelegationRun(row.id, ownership, [row.status], {
        status: terminal ? row.status : 'failed', finished: true, processPid: null, processIdentity: null,
        ...(!terminal ? { errorCode } : {}),
      });
      if (changed) executorPool.notifyCapacityReleased();
      return changed;
    };
    if (!isProcessAlive(pid)) {
      if (release('interrupted')) reconciled++;
      continue;
    }
    let identity: ProcessIdentity | null = null;
    try { identity = row.process_identity ? JSON.parse(row.process_identity) : null; } catch { identity = null; }
    const verdict = await verifyProcessIdentity(pid, identity);
    if (verdict === 'mismatch') {
      if (release('process_identity_mismatch')) reconciled++;
      continue;
    }
    if (verdict === 'match') {
      let stopped;
      try { stopped = await claudeManager.stopClaude(pid, identity); }
      catch (err) {
        stopped = { status: 'unresolved' as const, pid, reason: err instanceof Error ? err.message : String(err) };
      }
      if (stopped.status !== 'unresolved') {
        if (release(stopped.status === 'not_owned' ? 'process_identity_mismatch' : 'interrupted')) reconciled++;
        continue;
      }
    }
    const retained = updateOwnedDelegationRun(row.id, ownership, [row.status], {
      status: 'recovery_required', errorCode: `process_identity_${verdict}`,
    });
    if (retained) recoveryRequired++;
  }
  if (reconciled || recoveryRequired) {
    logger.info('delegation.recovery', { msg: 'delegation worker recovery completed', reconciled, recoveryRequired });
  }
  return { reconciled, recoveryRequired };
}

export function recoverDelegationRuns(
  _options: { passive?: boolean } = {},
): Promise<DelegationRecoveryReport> {
  if (recoveryFlight) return recoveryFlight;
  recoveryFlight = runDelegationRecovery().finally(() => { recoveryFlight = null; });
  return recoveryFlight;
}
