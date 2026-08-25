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
} = await import('../agent-forum-orchestrator.js');

/**
 * PIDs used here are never signalled: `terminateProcessTree` is stubbed in every
 * test that reaches it, and the helper itself is fail-closed in test mode.
 */
const ORPHAN_PID = 424242;

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

    expect(report).toEqual({ forumsRecovered: 0, turnsReconciled: 0, orphanProcessesTerminated: 0 });
    expect(terminateSpy).not.toHaveBeenCalled();
    expect(queries.getAgentForumTurnById(turn.id)!.status).toBe('passed');
  });

  it('terminates the orphan process tree of a live stale PID, then stops the turn', async () => {
    const { running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID });

    const callOrder: string[] = [];
    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
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

  it('still reconciles when the orphan process cannot be terminated', async () => {
    const { forum, running } = seedInterruptedForum();
    queries.updateAgentForumTurn(running.id, { process_pid: ORPHAN_PID });

    vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
    vi.spyOn(processTree, 'terminateProcessTree').mockRejectedValue(new Error('EPERM'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await recoverInterruptedAgentForums();

    expect(report.orphanProcessesTerminated).toBe(0);
    expect(report.turnsReconciled).toBe(2);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    expect(queries.getAgentForumTurnById(running.id)!.status).toBe('stopped');
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
