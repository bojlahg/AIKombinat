import { claudeManager } from '../services/claude-manager.js';
import { isProcessAlive, verifyProcessIdentity, type ProcessIdentity } from '../utils/process-tree.js';
import { logger } from '../logging/logger.js';
import { executorPool } from '../services/executor-pool.js';
import {
  getRecoveryRequiredDelegationRuns, getUnresolvedDelegationRuns, updateOwnedDelegationRun,
  type DelegationProcessOwnership,
} from './store.js';

export async function recoverDelegationRuns(
  options: { passive?: boolean } = {},
): Promise<{ reconciled: number; recoveryRequired: number }> {
  let reconciled = 0;
  let recoveryRequired = 0;
  const rows = options.passive ? getRecoveryRequiredDelegationRuns() : getUnresolvedDelegationRuns();
  for (const row of rows) {
    const pid = row.process_pid!;
    const ownership: DelegationProcessOwnership = { pid, processIdentity: row.process_identity };
    const release = (errorCode: string) => {
      const changed = updateOwnedDelegationRun(row.id, ownership, ['running', 'recovery_required'], {
        status: 'failed', finished: true, processPid: null, processIdentity: null, errorCode,
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
    const retained = updateOwnedDelegationRun(row.id, ownership, ['running', 'recovery_required'], {
      status: 'recovery_required', errorCode: `process_identity_${verdict}`,
    });
    if (retained) recoveryRequired++;
  }
  if (reconciled || recoveryRequired) {
    logger.info('delegation.recovery', { msg: 'delegation worker recovery completed', reconciled, recoveryRequired });
  }
  return { reconciled, recoveryRequired };
}
