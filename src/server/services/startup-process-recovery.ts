import * as queries from '../db/queries.js';
import { logger } from '../logging/logger.js';
import { resourceManager } from './resource-manager.js';
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
  process_pid: number | null;
  process_identity: string | null;
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
): Promise<void> {
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
    return;
  }

  const identity = parseProcessIdentity(owner.process_identity);
  const verdict = await probe.verify(pid, identity);
  if (verdict === 'match') {
    logger.warn('startup.process-recovery.live-match', {
      scope: '[startup]', msg: `${ownerType} still owns a live process; preserving fail-closed state`,
      ownerType, ownerId: owner.id, pid, reason: 'process_identity_match',
    });
    return;
  }

  // A live PID without a positive identity match is never signalled. Mark the
  // owner as failed while retaining PID/identity and resource ownership so an
  // operator can inspect and retry Stop without risking a reused PID.
  const reason = verdict === 'mismatch'
    ? `live PID ${pid} does not match the persisted process identity; no signal was sent and ownership was retained`
    : `live PID ${pid} identity is unverifiable; no signal was sent and ownership was retained`;
  if (ownerType === 'todo') {
    queries.updateTodoStatus(owner.id, 'failed');
    const activeRound = queries.getActiveExecutionRound(owner.id);
    if (activeRound) {
      queries.updateExecutionRound(activeRound.id, {
        status: 'failed',
        error_message: reason,
        finished_at: new Date().toISOString(),
      });
    }
  } else if (ownerType === 'session') queries.updateSessionStatus(owner.id, 'failed');
  else queries.updateDiscussionStatus(owner.id, 'failed');
  recordReason(ownerType, owner.id, reason);
  logger.error('startup.process-recovery.requires-attention', {
    scope: '[startup]', msg: reason, ownerType, ownerId: owner.id, pid,
    reason: `process_identity_${verdict}`,
  });
}

export async function recoverPersistedProcesses(probe: StartupProcessProbe = defaultProbe): Promise<void> {
  for (const todo of queries.getTodosByStatus('running')) await recoverOwner('todo', todo, probe);
  for (const session of queries.getSessionsByStatus('running')) await recoverOwner('session', session, probe);
  for (const discussion of queries.getDiscussionsByStatus('running')) await recoverOwner('discussion', discussion, probe);
}
