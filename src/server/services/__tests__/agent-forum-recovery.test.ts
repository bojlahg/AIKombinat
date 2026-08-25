import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

const queries = await import('../../db/queries.js');
const processTree = await import('../../utils/process-tree.js');
const {
  recoverInterruptedAgentForums,
  FORUM_TURN_RESTART_INTERRUPT_MESSAGE,
  FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGE,
  FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGES,
} = await import('../agent-forum-orchestrator.js');

/**
 * PIDs used here are never signalled: `terminateProcessTree` is stubbed in every
 * test that reaches it, and the helper itself is fail-closed in test mode. The
 * process-identity probe is stubbed too, so no test inspects a real process.
 */
const ORPHAN_PID = 424242;

/** The fingerprint a turn would have persisted when it spawned its process. */
const ORPHAN_IDENTITY = { pid: ORPHAN_PID, startedAt: '1699999999', command: 'claude' };

function persistedIdentity(pid = ORPHAN_PID) {
  return JSON.stringify({ ...ORPHAN_IDENTITY, pid });
}

/** Stubs identity verification with a fixed verdict for every PID. */
function stubIdentityVerdict(verdict: 'match' | 'mismatch' | 'unverifiable') {
  return vi.spyOn(processTree, 'verifyProcessIdentity').mockResolvedValue(verdict);
}

describe('AgentForum startup recovery', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.close();
  });

  function seedInterruptedForum() {
    const forum = queries.createAgentForum('Interrupted Forum', undefined, 1024);
    const a = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude', sortOrder: 0 });
    const b = queries.createAgentForumMember(forum.id, 'AgentB', 'participant', '', { cliTool: 'claude', sortOrder: 1 });
    const c = queries.createAgentForumMember(forum.id, 'AgentC', 'participant', '', { cliTool: 'claude', sortOrder: 2 });

    const userMsg = queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Root question');

    // Turn 1: finished cleanly before the restart.
    const completed = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
    queries.updateAgentForumTurn(completed.id, {
      status: 'completed',
      execution_snapshot: '{"agent":"claude"}',
      raw_output: '{"replies":[]}',
      started_at: '2026-08-25T10:00:00Z',
      completed_at: '2026-08-25T10:01:00Z',
    });
    const agentMsg = queries.createAgentForumMessage(
      forum.id, 'agent', a.id, 'AgentA', 'participant', 'A answered', userMsg.id, completed.id,
    );

    // Turn 2: was mid-flight when the server died.
    const running = queries.createAgentForumTurn(forum.id, b.id, 1, 1);
    queries.updateAgentForumTurn(running.id, {
      status: 'running',
      execution_snapshot: '{"agent":"claude"}',
      started_at: '2026-08-25T10:01:00Z',
    });

    // Turn 3: created but never admitted.
    const pending = queries.createAgentForumTurn(forum.id, c.id, 1, 2);

    queries.updateAgentForum(forum.id, {
      status: 'running',
      current_cycle: 1,
      current_member_id: b.id,
    });

    return { forum, a, b, c, userMsg, agentMsg, completed, running, pending };
  }

  it('reconciles unfinished turns and returns the forum to idle', async () => {
    const { forum, completed, running, pending, userMsg, agentMsg } = seedInterruptedForum();

    const report = await recoverInterruptedAgentForums();

    expect(report.forumsRecovered).toBe(1);
    expect(report.turnsReconciled).toBe(2);

    // Forum is idle again with no speaker pinned.
    const recovered = queries.getAgentForumById(forum.id)!;
    expect(recovered.status).toBe('idle');
    expect(recovered.current_member_id).toBeNull();
    expect(recovered.current_cycle).toBe(1);

    // The completed turn is untouched, snapshot and output intact.
    const completedAfter = queries.getAgentForumTurnById(completed.id)!;
    expect(completedAfter.status).toBe('completed');
    expect(completedAfter.execution_snapshot).toBe('{"agent":"claude"}');
    expect(completedAfter.raw_output).toBe('{"replies":[]}');
    expect(completedAfter.completed_at).toBe('2026-08-25T10:01:00Z');
    expect(completedAfter.error_message).toBeNull();

    // Both unfinished turns became `stopped` with an explicit restart reason.
    for (const turnId of [running.id, pending.id]) {
      const turn = queries.getAgentForumTurnById(turnId)!;
      expect(turn.status).toBe('stopped');
      expect(turn.error_message).toBe(FORUM_TURN_RESTART_INTERRUPT_MESSAGE);
      expect(turn.error_message).toMatch(/restart/i);
      expect(turn.completed_at).toBeTruthy();
      expect(turn.process_pid).toBeNull();
    }

    // The interrupted turn keeps the snapshot it had already recorded.
    expect(queries.getAgentForumTurnById(running.id)!.execution_snapshot).toBe('{"agent":"claude"}');

    // History survives: all turns and all messages are still there.
    expect(queries.getAgentForumTurns(forum.id)).toHaveLength(3);
    const messages = queries.getAgentForumMessages(forum.id);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual([userMsg.id, agentMsg.id]);
    expect(queries.getAgentForumMembers(forum.id)).toHaveLength(3);
  });

  it('preserves an already-set completed_at instead of overwriting it', async () => {
    const { running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { completed_at: '2026-08-25T09:59:00Z' });

    await recoverInterruptedAgentForums();

    expect(queries.getAgentForumTurnById(running.id)!.completed_at).toBe('2026-08-25T09:59:00Z');
  });

  it('does nothing when no forum was left running', async () => {
    const forum = queries.createAgentForum('Quiet Forum', undefined, 1024);
    const member = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude' });
    const turn = queries.createAgentForumTurn(forum.id, member.id, 1, 0);
    queries.updateAgentForumTurn(turn.id, { status: 'passed', completed_at: '2026-08-25T10:00:00Z' });

    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree');

    const report = await recoverInterruptedAgentForums();

    expect(report).toEqual({
      forumsRecovered: 0,
      turnsReconciled: 0,
      orphanProcessesTerminated: 0,
      unresolvedOrphanProcesses: 0,
      forumsFailed: 0,
      unresolvedOrphans: [],
      recoveryFailures: [],
    });
    expect(terminateSpy).not.toHaveBeenCalled();
    expect(queries.getAgentForumTurnById(turn.id)!.status).toBe('passed');
  });

  it('terminates the orphan process tree of a live stale PID, then stops the turn', async () => {
    const { running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    const callOrder: string[] = [];
    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('match');
    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(async (pid) => {
      // The turn must still be `running` while we terminate — reconciliation
      // happens only after the orphan is dealt with.
      callOrder.push(`terminate:${pid}:${queries.getAgentForumTurnById(running.id)!.status}`);
      return true;
    });

    const report = await recoverInterruptedAgentForums();

    expect(terminateSpy).toHaveBeenCalledWith(ORPHAN_PID);
    expect(callOrder).toEqual([`terminate:${ORPHAN_PID}:running`]);
    expect(report.orphanProcessesTerminated).toBe(1);

    const turn = queries.getAgentForumTurnById(running.id)!;
    expect(turn.status).toBe('stopped');
    expect(turn.process_pid).toBeNull();
  });

  it('skips termination when the stale PID is already gone', async () => {
    const { running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID });

    vi.spyOn(processTree, 'isProcessAlive').mockReturnValue(false);
    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree');

    const report = await recoverInterruptedAgentForums();

    expect(terminateSpy).not.toHaveBeenCalled();
    expect(report.orphanProcessesTerminated).toBe(0);
    expect(queries.getAgentForumTurnById(running.id)!.status).toBe('stopped');
  });

  it('keeps the PID and fails closed when termination reports failure and the process survives', async () => {
    const { forum, running, pending, completed } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('match');
    vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    // Not counted as a successful recovery.
    expect(report.forumsRecovered).toBe(0);
    expect(report.orphanProcessesTerminated).toBe(0);
    expect(report.unresolvedOrphanProcesses).toBe(1);
    expect(report.unresolvedOrphans).toEqual([
      { forumId: forum.id, turnId: running.id, pid: ORPHAN_PID, reason: 'termination_failed' },
    ]);

    // The forum stays in error and the PID is preserved for a retry.
    expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
    const orphanTurn = queries.getAgentForumTurnById(running.id)!;
    expect(orphanTurn.process_pid).toBe(ORPHAN_PID);
    expect(orphanTurn.status).toBe('running');
    expect(orphanTurn.error_message).toBe(FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGE);

    // Turns without a live PID are still safe to reconcile.
    expect(queries.getAgentForumTurnById(pending.id)!.status).toBe('stopped');
    expect(report.turnsReconciled).toBe(1);

    // History is untouched.
    expect(queries.getAgentForumTurnById(completed.id)!.status).toBe('completed');
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(2);
    expect(queries.getAgentForumTurns(forum.id)).toHaveLength(3);
  });

  it('fails closed when termination throws and the process is still alive', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('match');
    vi.spyOn(processTree, 'terminateProcessTree').mockRejectedValue(new Error('EPERM'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    expect(report.forumsRecovered).toBe(0);
    expect(report.unresolvedOrphanProcesses).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
    const orphanTurn = queries.getAgentForumTurnById(running.id)!;
    expect(orphanTurn.process_pid).toBe(ORPHAN_PID);
    expect(orphanTurn.status).toBe('running');
  });

  it('reconciles safely when termination throws but the process is verifiably gone', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });
    stubIdentityVerdict('match');

    // Alive on the first probe, gone on the confirmation probe after the throw.
    let probes = 0;
    vi.spyOn(processTree, 'isProcessAlive').mockImplementation(() => {
      probes++;
      return probes === 1;
    });
    vi.spyOn(processTree, 'terminateProcessTree').mockRejectedValue(new Error('ESRCH'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    expect(report.unresolvedOrphanProcesses).toBe(0);
    expect(report.orphanProcessesTerminated).toBe(1);
    expect(report.forumsRecovered).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    const turn = queries.getAgentForumTurnById(running.id)!;
    expect(turn.status).toBe('stopped');
    expect(turn.process_pid).toBeNull();
  });

  it('retrying recovery after the orphan exits completes the cleanup', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    const aliveSpy = vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('match');
    vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = await recoverInterruptedAgentForums();
    expect(first.unresolvedOrphanProcesses).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('error');

    // The orphan finally exits; a second pass finds the forum again (error +
    // an unfinished turn with a PID) and completes cleanly.
    aliveSpy.mockReturnValue(false);
    const second = await recoverInterruptedAgentForums();

    expect(second.unresolvedOrphanProcesses).toBe(0);
    expect(second.forumsRecovered).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    const turn = queries.getAgentForumTurnById(running.id)!;
    expect(turn.status).toBe('stopped');
    expect(turn.process_pid).toBeNull();
    expect(turn.error_message).toBe(FORUM_TURN_RESTART_INTERRUPT_MESSAGE);
  });

  it('recovers a forum parked in error that still has a running turn with a PID', async () => {
    const { forum, running, completed } = seedInterruptedForum();
    // A Stop that timed out before the restart leaves the forum in `error`.
    queries.updateAgentForum(forum.id, { status: 'error', current_member_id: null });
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    // The forum is picked up by the recovery query, not skipped as historical.
    expect(queries.getAgentForumsNeedingRecovery().map((f) => f.id)).toContain(forum.id);

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('match');
    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(true);

    const report = await recoverInterruptedAgentForums();

    expect(terminateSpy).toHaveBeenCalledWith(ORPHAN_PID);
    expect(report.forumsRecovered).toBe(1);
    expect(report.orphanProcessesTerminated).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    expect(queries.getAgentForumTurnById(running.id)!.status).toBe('stopped');
    expect(queries.getAgentForumTurnById(completed.id)!.status).toBe('completed');
  });

  it('recovers an error forum whose only leftover is an unfinished turn without a PID', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForum(forum.id, { status: 'error', current_member_id: null });

    expect(queries.getAgentForumsNeedingRecovery().map((f) => f.id)).toContain(forum.id);

    const report = await recoverInterruptedAgentForums();

    expect(report.forumsRecovered).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    expect(queries.getAgentForumTurnById(running.id)!.status).toBe('stopped');
  });

  it('leaves a historical error forum with nothing to reconcile alone', async () => {
    const forum = queries.createAgentForum('Old Error Forum', undefined, 1024);
    const member = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude' });
    const turn = queries.createAgentForumTurn(forum.id, member.id, 1, 0);
    queries.updateAgentForumTurn(turn.id, {
      status: 'failed',
      error_message: 'old failure',
      completed_at: '2026-08-20T10:00:00Z',
    });
    queries.updateAgentForum(forum.id, { status: 'error', current_member_id: null });

    expect(queries.getAgentForumsNeedingRecovery()).toHaveLength(0);

    const report = await recoverInterruptedAgentForums();

    expect(report.forumsRecovered).toBe(0);
    // Its status and history are not silently rewritten.
    expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
    const untouched = queries.getAgentForumTurnById(turn.id)!;
    expect(untouched.status).toBe('failed');
    expect(untouched.error_message).toBe('old failure');
  });

  it('picks up an error forum whose only leftover is a stray PID on a terminal turn', async () => {
    const forum = queries.createAgentForum('Stray PID Forum', undefined, 1024);
    const member = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude' });
    const turn = queries.createAgentForumTurn(forum.id, member.id, 1, 0);
    queries.updateAgentForumTurn(turn.id, {
      status: 'failed',
      error_message: 'crashed mid-write',
      completed_at: '2026-08-20T10:00:00Z',
      process_pid: ORPHAN_PID,
      process_identity: persistedIdentity(),
    });
    queries.updateAgentForum(forum.id, { status: 'error', current_member_id: null });

    expect(queries.getAgentForumsNeedingRecovery().map((f) => f.id)).toContain(forum.id);

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('match');
    vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(true);

    const report = await recoverInterruptedAgentForums();

    expect(report.orphanProcessesTerminated).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    // The terminal outcome stands; only the stray PID was cleared.
    const after = queries.getAgentForumTurnById(turn.id)!;
    expect(after.status).toBe('failed');
    expect(after.error_message).toBe('crashed mid-write');
    expect(after.process_pid).toBeNull();
  });

  // ── PID reuse safety: never signal on the strength of a number ────────────

  it('terminates the orphan only when the recorded process identity still matches', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    const verifySpy = stubIdentityVerdict('match');
    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(true);

    const report = await recoverInterruptedAgentForums();

    // Identity is checked BEFORE anything is signalled.
    expect(verifySpy).toHaveBeenCalledWith(ORPHAN_PID, expect.objectContaining({
      pid: ORPHAN_PID,
      startedAt: ORPHAN_IDENTITY.startedAt,
    }));
    expect(terminateSpy).toHaveBeenCalledWith(ORPHAN_PID);
    expect(report.orphanProcessesTerminated).toBe(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    const turn = queries.getAgentForumTurnById(running.id)!;
    expect(turn.status).toBe('stopped');
    expect(turn.process_pid).toBeNull();
    expect(turn.process_identity).toBeNull();
  });

  it('never signals a live PID whose identity no longer matches (PID reuse)', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('mismatch');
    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    // The unrelated process that inherited the PID is left completely alone.
    expect(terminateSpy).not.toHaveBeenCalled();
    expect(report.forumsRecovered).toBe(0);
    expect(report.orphanProcessesTerminated).toBe(0);
    expect(report.unresolvedOrphanProcesses).toBe(1);
    expect(report.unresolvedOrphans).toEqual([
      { forumId: forum.id, turnId: running.id, pid: ORPHAN_PID, reason: 'identity_mismatch' },
    ]);

    // Fail closed with a recoverable diagnostic state.
    expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
    const turn = queries.getAgentForumTurnById(running.id)!;
    expect(turn.process_pid).toBe(ORPHAN_PID);
    expect(turn.process_identity).toBe(persistedIdentity());
    expect(turn.status).toBe('running');
    expect(turn.error_message).toBe(FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGES.identity_mismatch);
  });

  it('never signals a live PID whose identity cannot be verified', async () => {
    const { forum, running } = seedInterruptedForum();
    // No persisted fingerprint at all — e.g. the server died before the probe
    // landed. Unverifiable must behave exactly like a mismatch.
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID });

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    stubIdentityVerdict('unverifiable');
    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    expect(terminateSpy).not.toHaveBeenCalled();
    expect(report.forumsRecovered).toBe(0);
    expect(report.unresolvedOrphans).toEqual([
      { forumId: forum.id, turnId: running.id, pid: ORPHAN_PID, reason: 'identity_unverifiable' },
    ]);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
    const turn = queries.getAgentForumTurnById(running.id)!;
    expect(turn.process_pid).toBe(ORPHAN_PID);
    expect(turn.status).toBe('running');
    expect(turn.error_message).toBe(FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGES.identity_unverifiable);
  });

  it('treats a throwing identity probe as unverifiable and does not signal', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID, process_identity: persistedIdentity() });

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    vi.spyOn(processTree, 'verifyProcessIdentity').mockRejectedValue(new Error('probe exploded'));
    const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    expect(terminateSpy).not.toHaveBeenCalled();
    expect(report.unresolvedOrphans[0].reason).toBe('identity_unverifiable');
    expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
    expect(queries.getAgentForumTurnById(running.id)!.process_pid).toBe(ORPHAN_PID);
  });

  // ── Per-forum isolation ───────────────────────────────────────────────────

  it('keeps recovering later forums when one forum recovery throws', async () => {
    const broken = seedInterruptedForum();
    const healthy = seedInterruptedForum();

    // Make the FIRST forum blow up inside recovery, without touching the second.
    const realGetTurns = queries.getAgentForumTurnsNeedingRecovery;
    vi.spyOn(queries, 'getAgentForumTurnsNeedingRecovery').mockImplementation((forumId: string) => {
      if (forumId === broken.forum.id) throw new Error('database went sideways');
      return realGetTurns(forumId);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    // The broken forum is recorded and left closed — never silently idle.
    expect(report.forumsFailed).toBe(1);
    expect(report.recoveryFailures).toEqual([
      { forumId: broken.forum.id, error: 'database went sideways' },
    ]);
    expect(queries.getAgentForumById(broken.forum.id)!.status).toBe('error');
    expect(queries.getAgentForumTurnById(broken.running.id)!.status).toBe('running');
    expect(queries.getAgentForumTurnById(broken.pending.id)!.status).toBe('pending');

    // The healthy forum behind it was still reconciled.
    expect(report.forumsRecovered).toBe(1);
    expect(queries.getAgentForumById(healthy.forum.id)!.status).toBe('idle');
    expect(queries.getAgentForumTurnById(healthy.running.id)!.status).toBe('stopped');
    expect(queries.getAgentForumTurnById(healthy.pending.id)!.status).toBe('stopped');
  });

  it('recovers several stale forums independently', async () => {
    const first = seedInterruptedForum();
    const second = seedInterruptedForum();

    const report = await recoverInterruptedAgentForums();

    expect(report.forumsRecovered).toBe(2);
    expect(report.turnsReconciled).toBe(4);
    for (const { forum } of [first, second]) {
      expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
      expect(queries.getAgentForumTurns(forum.id).filter((t) => t.status === 'stopped')).toHaveLength(2);
    }
  });

  it('leaves terminal turn states of every kind untouched', async () => {
    const forum = queries.createAgentForum('Mixed Forum', undefined, 1024);
    const member = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude' });
    const terminal = ['completed', 'passed', 'failed', 'skipped', 'stopped'] as const;
    const turnIds = terminal.map((status, index) => {
      const turn = queries.createAgentForumTurn(forum.id, member.id, 1, index);
      queries.updateAgentForumTurn(turn.id, { status, error_message: `original-${status}` });
      return { id: turn.id, status };
    });
    queries.updateAgentForum(forum.id, { status: 'running', current_cycle: 1 });

    const report = await recoverInterruptedAgentForums();

    expect(report.turnsReconciled).toBe(0);
    for (const { id, status } of turnIds) {
      const turn = queries.getAgentForumTurnById(id)!;
      expect(turn.status).toBe(status);
      expect(turn.error_message).toBe(`original-${status}`);
    }
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
  });
});
