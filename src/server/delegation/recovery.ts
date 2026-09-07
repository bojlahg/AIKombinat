import { claudeManager } from '../services/claude-manager.js';
import { isProcessAlive, verifyProcessIdentity, type ProcessIdentity } from '../utils/process-tree.js';
import { logger } from '../logging/logger.js';
import { getDelegationRun, getUnresolvedDelegationRuns, updateDelegationRun } from './store.js';

export async function recoverDelegationRuns(): Promise<{ reconciled: number; recoveryRequired: number }> {
  let reconciled = 0;
  let recoveryRequired = 0;
  for (const row of getUnresolvedDelegationRuns()) {
    const pid = row.process_pid!;
    const stillCurrent = () => {
      const current = getDelegationRun(row.id);
      return current?.process_pid === pid && (current.status === 'running' || current.status === 'recovery_required');
    };
    if (!isProcessAlive(pid)) {
      if (stillCurrent()) updateDelegationRun(row.id, { status: 'failed', finished: true, processPid: null, processIdentity: null, errorCode: 'interrupted' });
      reconciled++;
      continue;
    }
    let identity: ProcessIdentity | null = null;
    try { identity = row.process_identity ? JSON.parse(row.process_identity) : null; } catch { identity = null; }
    const verdict = await verifyProcessIdentity(pid, identity);
    if (verdict === 'mismatch') {
      if (stillCurrent()) updateDelegationRun(row.id, { status: 'failed', finished: true, processPid: null, processIdentity: null, errorCode: 'process_identity_mismatch' });
      reconciled++;
      continue;
    }
    if (verdict === 'match') {
      const stopped = await claudeManager.stopClaude(pid, identity);
      if (stopped.status !== 'unresolved') {
        if (stillCurrent()) updateDelegationRun(row.id, { status: 'failed', finished: true, processPid: null, processIdentity: null, errorCode: 'interrupted' });
        reconciled++;
        continue;
      }
    }
    if (stillCurrent()) updateDelegationRun(row.id, { status: 'recovery_required', errorCode: `process_identity_${verdict}` });
    recoveryRequired++;
  }
  if (reconciled || recoveryRequired) {
    logger.info('delegation.recovery', { msg: 'delegation worker recovery completed', reconciled, recoveryRequired });
  }
  return { reconciled, recoveryRequired };
}
