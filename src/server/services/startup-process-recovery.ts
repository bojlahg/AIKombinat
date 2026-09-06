import * as queries from '../db/queries.js';
import { logger } from '../logging/logger.js';
import { resourceManager } from './resource-manager.js';
import { hasUnresolvedProcess } from './process-ownership.js';
import {
  isProcessAlive,
  parseProcessIdentity,
  verifyProcessIdentity,
  type ProcessIdentity,
  type ProcessIdentityVerdict,
} from '../utils/process-tree.js';

export interface StartupProcessProbe {
  isAlive(pid: number): boolean;
  verify(pid: number, identity: ProcessIdentity | null): Promise<ProcessIdentityVerdict>;
}

const defaultProbe: StartupProcessProbe = {
  isAlive: isProcessAlive,
  verify: verifyProcessIdentity,
};

type RecoveryOwner = 'todo' | 'session' | 'discussion';

interface PersistedProcessOwner {
  id: string;
  title: string;
  status: string;
  process_pid: number | null;
  process_identity: string | null;
}

export interface ProcessRecoveryReport {
  released: number;
  retained: number;
}

function recordReason(ownerType: RecoveryOwner, ownerId: string, reason: string): void {
  const message = `Startup process recovery: ${reason}.`;
  if (ownerType === 'todo') queries.createTaskLog(ownerId, 'error', message);
  else if (ownerType === 'session') queries.createSessionLog(ownerId, 'error', message);
  else queries.createDiscussionLog(ownerId, null, 'error', message);
}

async function recoverOwner(
  ownerType: RecoveryOwner,
  owner: PersistedProcessOwner,
  probe: StartupProcessProbe,
): Promise<'released' | 'retained'> {
  const pid = owner.process_pid ?? 0;
  const dead = pid <= 0 || !probe.isAlive(pid);
  if (dead) {
    if (ownerType === 'todo') {
      queries.updateTodoStatus(owner.id, 'failed');
      queries.updateTodo(owner.id, { process_pid: 0, process_identity: null });
      resourceManager.releaseOwner('todo', owner.id);
    } else if (ownerType === 'session') {
      queries.updateSessionStatus(owner.id, 'failed');
      queries.updateSession(owner.id, { process_pid: 0, process_identity: null });
      resourceManager.releaseOwner('session', owner.id);
    } else {
      queries.updateDiscussionStatus(owner.id, 'paused');
      queries.updateDiscussion(owner.id, { process_pid: 0, process_identity: null });
    }
    recordReason(ownerType, owner.id, pid > 0 ? `persisted PID ${pid} is no longer alive` : 'no persisted PID was present');
    logger.warn('startup.process-recovery.dead', {
      scope: '[startup]', msg: `${ownerType} process is dead; persisted state reconciled`,
      ownerType, ownerId: owner.id, pid: pid || undefined,
    });
    return 'released';
  }

  const identity = parseProcessIdentity(owner.process_identity);
  let verdict: ProcessIdentityVerdict;
  try {
    verdict = await probe.verify(pid, identity);
  } catch {
    verdict = 'unverifiable';
  }
  if (verdict === 'match') {
    if (owner.status === 'running') {
      const reason = `live PID ${pid} matches the persisted identity, but its streams and exit lifecycle were lost during restart; ownership was retained for explicit recovery`;
      markRecoveryRequired(ownerType, owner, reason);
      logger.error('startup.process-recovery.live-match', {
        scope: '[startup]', msg: reason, ownerType, ownerId: owner.id, pid,
        reason: 'process_identity_match_lifecycle_detached',
      });
    }
    return 'retained';
  }

  if (verdict === 'mismatch') {
    const reason = `live PID ${pid} belongs to a different process instance; reused PID was not signalled and stale ownership was released`;
    if (ownerType === 'todo') {
      queries.updateTodoStatus(owner.id, 'failed');
      queries.updateTodo(owner.id, { process_pid: 0, process_identity: null });
      resourceManager.releaseOwner('todo', owner.id);
      const activeRound = queries.getActiveExecutionRound(owner.id);
      if (activeRound) {
        queries.updateExecutionRound(activeRound.id, {
          status: 'failed', error_message: reason, finished_at: new Date().toISOString(),
        });
      }
    } else if (ownerType === 'session') {
      queries.updateSessionStatus(owner.id, 'failed');
      queries.updateSession(owner.id, { process_pid: 0, process_identity: null });
      resourceManager.releaseOwner('session', owner.id);
    } else {
      queries.updateDiscussionStatus(owner.id, 'paused');
      queries.updateDiscussion(owner.id, { process_pid: 0, process_identity: null });
    }
    recordReason(ownerType, owner.id, reason);
    logger.warn('startup.process-recovery.identity-mismatch', {
      scope: '[startup]', msg: reason, ownerType, ownerId: owner.id, pid,
      reason: 'process_identity_mismatch',
    });
    return 'released';
  }

  // An unverifiable live PID is never signalled or forgotten. Mark the owner
  // failed while retaining PID/identity and ownership for an explicit Stop.
  const reason = `live PID ${pid} identity is unverifiable; no signal was sent and ownership was retained`;
  if (owner.status === 'running') {
    markRecoveryRequired(ownerType, owner, reason);
    logger.error('startup.process-recovery.requires-attention', {
      scope: '[startup]', msg: reason, ownerType, ownerId: owner.id, pid,
      reason: `process_identity_${verdict}`,
    });
  }
  return 'retained';
}

function markRecoveryRequired(ownerType: RecoveryOwner, owner: PersistedProcessOwner, reason: string): void {
  if (ownerType === 'todo') {
    queries.updateTodoStatus(owner.id, 'failed');
    const activeRound = queries.getActiveExecutionRound(owner.id);
    if (activeRound) {
      queries.updateExecutionRound(activeRound.id, {
        status: 'failed', error_message: reason, finished_at: new Date().toISOString(),
      });
    }
  } else if (ownerType === 'session') queries.updateSessionStatus(owner.id, 'failed');
  else queries.updateDiscussionStatus(owner.id, 'failed');
  recordReason(ownerType, owner.id, reason);
}

async function recoverOwners(
  probe: StartupProcessProbe,
  onlyRecoveryRequired: boolean,
): Promise<ProcessRecoveryReport> {
  const report: ProcessRecoveryReport = { released: 0, retained: 0 };
  const groups: Array<[RecoveryOwner, PersistedProcessOwner[]]> = [
    ['todo', queries.getTodosWithPersistedProcess()],
    ['session', queries.getSessionsWithPersistedProcess()],
    ['discussion', queries.getDiscussionsWithPersistedProcess()],
  ];
  for (const [ownerType, owners] of groups) {
    for (const owner of owners) {
      if (onlyRecoveryRequired && !hasUnresolvedProcess(owner)) continue;
      report[await recoverOwner(ownerType, owner, probe)]++;
    }
  }
  return report;
}

export function recoverPersistedProcesses(probe: StartupProcessProbe = defaultProbe): Promise<ProcessRecoveryReport> {
  return recoverOwners(probe, false);
}

export function reconcileRetainedProcesses(probe: StartupProcessProbe = defaultProbe): Promise<ProcessRecoveryReport> {
  return recoverOwners(probe, true);
}
