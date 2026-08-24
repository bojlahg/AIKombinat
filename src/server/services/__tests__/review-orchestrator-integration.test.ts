import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

vi.mock('../../websocket/broadcaster.js', () => ({
  broadcaster: {
    broadcast: vi.fn(),
  },
}));

let mockClaudeStarts: Array<{
  workDir: string;
  prompt: string;
  model?: string;
  options?: string;
  mode: string;
  cliTool: string;
  maxTurns?: number;
  projectPath: string;
  sandboxMode: string;
  isContinue: boolean;
  effort?: string;
}> = [];

let nextExitResolvers: Array<(code: number) => void> = [];

vi.mock('../claude-manager.js', () => ({
  claudeManager: {
    startClaude: vi.fn((workDir, prompt, model, options, mode, cliTool, maxTurns, projectPath, sandboxMode, isContinue, _onChunk, _onExit, effort) => {
      mockClaudeStarts.push({
        workDir, prompt, model, options, mode, cliTool, maxTurns, projectPath, sandboxMode, isContinue, effort,
      });

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      let exitResolve: (code: number) => void;
      const exitPromise = new Promise<number>((resolve) => {
        exitResolve = (code: number) => {
          stdout.end();
          stderr.end();
          resolve(code);
        };
      });
      nextExitResolvers.push(exitResolve!);

      return Promise.resolve({
        pid: 1000 + mockClaudeStarts.length,
        exitPromise,
        stdout,
        stderr,
        command: cliTool,
        args: [],
      });
    }),
    stopClaude: vi.fn().mockResolvedValue(true),
    killAll: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../worktree-manager.js', () => ({
  worktreeManager: {
    createWorktree: vi.fn().mockResolvedValue({
      worktreePath: '/tmp/worktree-1',
      branchName: 'task-feature-1',
    }),
    isValidWorktree: vi.fn().mockResolvedValue(true),
    sanitizeBranchName: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/git.js', () => ({
  createGit: () => ({
    diff: vi.fn().mockResolvedValue('diff --git a/index.ts b/index.ts\n+ console.log("reviewed");'),
    status: vi.fn().mockResolvedValue({
      modified: ['index.ts'],
      not_added: [],
      created: [],
      deleted: [],
    }),
    raw: vi.fn().mockResolvedValue('index.ts\n'),
  }),
  resolveLocalBaseBranch: vi.fn().mockResolvedValue('main'),
}));

vi.mock('../cli-status.js', () => ({
  getToolStatus: vi.fn().mockResolvedValue({
    tool: 'claude',
    installed: true,
    version: '1.0.0',
  }),
  checkAllTools: vi.fn().mockResolvedValue([]),
  clearCache: vi.fn(),
}));

const queries = await import('../../db/queries.js');
const { orchestrator } = await import('../orchestrator.js');
const { reviewPipeline, InvalidTransitionError } = await import('../review-pipeline.js');
const { executorPool } = await import('../executor-pool.js');
const { resourceManager } = await import('../resource-manager.js');
const { providerQuotaService } = await import('../provider-quota.js');

describe('Review / Rework Orchestrator Integration', () => {
  let project: queries.Project;
  let claudeModel: queries.CliModel;
  let claudeHaiku: queries.CliModel;
  let reviewProfile: queries.ExecutionProfile;
  let reworkProfile: queries.ExecutionProfile;

  beforeEach(() => {
    mockClaudeStarts = [];
    nextExitResolvers = [];

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);

    resourceManager.shutdown();
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetReservations();
    executorPool.resetLimits();
    providerQuotaService.resetForTesting();

    claudeModel = queries.addModel('claude', 'claude-3-7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    claudeHaiku = queries.addModel('claude', 'claude-3-5-haiku', 'Claude 3.5 Haiku', ['low']);

    project = queries.createProject('Integration Test Project', '/tmp/int-proj');
    reviewProfile = queries.createExecutionProfile({
      slug: 'review-prof',
      name: 'Review Profile',
      description: 'Reviewer profile',
      isEnabled: true,
      sortOrder: 0,
      executors: [
        {
          cli_model_id: claudeModel.id,
          priority: 1,
        },
      ],
    });

    reworkProfile = queries.createExecutionProfile({
      slug: 'rework-prof',
      name: 'Rework Profile',
      description: 'Reworker profile',
      isEnabled: true,
      sortOrder: 1,
      executors: [
        {
          cli_model_id: claudeModel.id,
          priority: 1,
        },
      ],
    });
  });

  afterEach(() => {
    resourceManager.shutdown();
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetLimits();
    executorPool.resetReservations();
    providerQuotaService.resetForTesting();
    testDb.close();
  });

  it('1. Automatic approved flow: Implementation -> Review (approved) -> Completed', async () => {
    const todo = queries.createTodo(
      project.id,
      'Build Auth Module',
      'Implement JWT token handling',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1, // review_enabled
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    // Start Todo
    await orchestrator.startTodo(todo.id);

    // Launch 1: Implementation
    expect(mockClaudeStarts).toHaveLength(1);
    expect(mockClaudeStarts[0].prompt).toContain('Implement JWT token handling');

    let rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].phase).toBe('implementation');
    expect(rounds[0].status).toBe('running');

    // Implementation finishes successfully
    nextExitResolvers[0](0);

    // Allow microtasks to resolve
    await new Promise((r) => setTimeout(r, 60));

    // Launch 2: Review should have started automatically!
    expect(mockClaudeStarts).toHaveLength(2);
    expect(mockClaudeStarts[1].prompt).toContain('# Automated Code Review Request');
    expect(mockClaudeStarts[1].prompt).toContain('Build Auth Module');
    expect(mockClaudeStarts[1].prompt).toContain('"verdict": "approved" | "needs_changes"');

    rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].status).toBe('completed');
    expect(rounds[1].phase).toBe('review');
    expect(rounds[1].status).toBe('running');

    let currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.status).toBe('running');
    expect(currentTodo.pipeline_phase).toBe('review');

    // Reviewer logs structured output and exits 0
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({
        verdict: 'approved',
        summary: 'Excellent authentication implementation. Clean structure.',
        issues: [],
      })
    );

    nextExitResolvers[1](0);

    await new Promise((r) => setTimeout(r, 60));

    // Todo is now completed! No third launch.
    expect(mockClaudeStarts).toHaveLength(2);
    rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(2);
    expect(rounds[1].status).toBe('completed');
    expect(rounds[1].result_payload).toContain('approved');

    currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.status).toBe('completed');
  });

  it('2. Automatic needs_changes flow: Implementation -> Review 1 (needs_changes) -> Rework 1 -> Review 2 (approved)', async () => {
    const todo = queries.createTodo(
      project.id,
      'Add User Profile',
      'Create profile page with avatar upload',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);

    // 1. Implementation
    expect(mockClaudeStarts).toHaveLength(1);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 2. Review 1
    expect(mockClaudeStarts).toHaveLength(2);
    expect(mockClaudeStarts[1].prompt).toContain('Review Round 1 of 3');

    // Reviewer returns needs_changes
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({
        verdict: 'needs_changes',
        summary: 'Avatar image size is not validated.',
        issues: [
          {
            severity: 'blocking',
            description: 'Validate avatar file size <= 5MB before upload.',
            files: ['src/avatar.ts'],
          },
        ],
      })
    );

    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    // 3. Rework 1 starts automatically!
    expect(mockClaudeStarts).toHaveLength(3);
    expect(mockClaudeStarts[2].prompt).toContain('# Rework Request — Code Review Feedback');
    expect(mockClaudeStarts[2].prompt).toContain('Avatar image size is not validated.');
    expect(mockClaudeStarts[2].prompt).toContain('Validate avatar file size <= 5MB before upload.');

    let rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(3);
    expect(rounds[2].phase).toBe('rework');
    expect(rounds[2].status).toBe('running');

    // Rework completes
    nextExitResolvers[2](0);
    await new Promise((r) => setTimeout(r, 60));

    // 4. Review 2 starts automatically with previous issues in prompt!
    expect(mockClaudeStarts).toHaveLength(4);
    expect(mockClaudeStarts[3].prompt).toContain('Review Round 2 of 3');
    expect(mockClaudeStarts[3].prompt).toContain('Validate avatar file size <= 5MB before upload.');

    rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(4);
    expect(rounds[3].phase).toBe('review');
    expect(rounds[3].round_index).toBe(4);

    // Review 2 passes
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({
        verdict: 'approved',
        summary: 'All issues resolved.',
        issues: [],
      })
    );

    nextExitResolvers[3](0);
    await new Promise((r) => setTimeout(r, 60));

    const finalTodo = queries.getTodoById(todo.id)!;
    expect(finalTodo.status).toBe('completed');
  });

  it('3. Round runtime state captures running, started_at, execution_snapshot, finished_at', async () => {
    const todo = queries.createTodo(
      project.id,
      'Runtime State Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);

    let round = queries.getActiveExecutionRound(todo.id)!;
    expect(round.status).toBe('running');
    expect(round.started_at).toBeTruthy();
    expect(round.execution_snapshot).toBeTruthy();
    expect(round.finished_at).toBeNull();

    // Finish
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    const completedRound = queries.getExecutionRoundById(round.id)!;
    expect(completedRound.status).toBe('completed');
    expect(completedRound.finished_at).toBeTruthy();
  });

  it('4. waiting_executor state during Review updates round and capacity wake starts it', async () => {
    const todo = queries.createTodo(
      project.id,
      'Waiting Executor Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);
    expect(mockClaudeStarts).toHaveLength(1);

    // Mock executor pool to return waiting_executor on next select
    const origSelect = executorPool.selectExecutor;
    vi.spyOn(executorPool, 'selectExecutor').mockResolvedValueOnce({
      status: 'waiting_executor',
      profileName: 'Review Profile',
      rejectionSummary: 'No executor capacity available',
    });

    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // Todo and review round should both be waiting_executor
    const currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.status).toBe('waiting_executor');

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    expect(reviewRound.phase).toBe('review');
    expect(reviewRound.status).toBe('waiting_executor');

    // Restore and wake
    vi.restoreAllMocks();
    await orchestrator.wakeWaitingExecutors();
    await new Promise((r) => setTimeout(r, 60));

    const runningRound = queries.getExecutionRoundById(reviewRound.id)!;
    expect(runningRound.status).toBe('running');
  });

  it('5. waiting_resource during Rework updates round and resource wake resumes it', async () => {
    const todo = queries.createTodo(
      project.id,
      'Resource Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '["unity.editor"]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    // Lock unity.editor by another run
    resourceManager.acquireAtomic({
      ownerType: 'todo',
      ownerId: 'other-todo',
      runToken: 'other-token',
      resources: ['unity.editor'],
    });

    await orchestrator.startTodo(todo.id);

    // Todo is waiting_resource
    const currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.status).toBe('waiting_resource');

    const round = queries.getActiveExecutionRound(todo.id)!;
    expect(round.status).toBe('waiting_resource');

    // Release resource
    resourceManager.releaseRun('other-token');
    await orchestrator.wakeWaitingResources();
    await new Promise((r) => setTimeout(r, 60));

    const runningRound = queries.getExecutionRoundById(round.id)!;
    expect(runningRound.status).toBe('running');
  });

  it('6. Runtime quota rejection in Review profile switches to next candidate', async () => {
    const codexModel = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    // Multi-candidate review profile
    const multiProfile = queries.createExecutionProfile({
      slug: 'multi-review',
      name: 'Multi Candidate Profile',
      description: 'Multi Candidate Profile for test',
      isEnabled: true,
      sortOrder: 2,
      executors: [
        { cli_model_id: claudeModel.id, priority: 1 },
        { cli_model_id: codexModel.id, priority: 2 },
      ],
    });

    const todo = queries.createTodo(
      project.id,
      'Quota Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      multiProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);
    // Implementation finishes
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // Review launch 1 starts
    expect(mockClaudeStarts).toHaveLength(2);

    // Review returns quota error (rate_limit)
    queries.createTaskLog(todo.id, 'output', '429 Rate limit exceeded for claude-3-7-sonnet');
    nextExitResolvers[1](1);
    await new Promise((r) => setTimeout(r, 80));

    // Review launch 2 retried with candidate in profile
    expect(mockClaudeStarts).toHaveLength(3);
    const round = queries.getActiveExecutionRound(todo.id)!;
    expect(round.phase).toBe('review');
  });

  it('7. Stop running Review kills process, stops round, and releases resources', async () => {
    const todo = queries.createTodo(
      project.id,
      'Stop Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // Now in review
    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    expect(reviewRound.phase).toBe('review');

    // Stop todo
    await orchestrator.stopTodo(todo.id);

    const stoppedRound = queries.getExecutionRoundById(reviewRound.id)!;
    expect(stoppedRound.status).toBe('stopped');

    const stoppedTodo = queries.getTodoById(todo.id)!;
    expect(stoppedTodo.status).toBe('stopped');
  });

  it('8. Stop waiting Review keeps it stopped after wake event', async () => {
    const todo = queries.createTodo(
      project.id,
      'Stop Waiting Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '["unity.editor"]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    // Hold resource
    resourceManager.acquireAtomic({
      ownerType: 'todo', ownerId: 'other', runToken: 'tok1', resources: ['unity.editor'],
    });

    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)!.status).toBe('waiting_resource');

    // Stop while waiting
    await orchestrator.stopTodo(todo.id);
    expect(queries.getTodoById(todo.id)!.status).toBe('stopped');

    // Release resource and wake
    resourceManager.releaseRun('tok1');
    await orchestrator.wakeWaitingResources();

    // Must remain stopped!
    expect(queries.getTodoById(todo.id)!.status).toBe('stopped');
  });

  it('9. Late exit isolation ignores late callback from superseded round', async () => {
    const todo = queries.createTodo(
      project.id,
      'Late Callback Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    const oldResolver = nextExitResolvers[0];

    // Simulate stopping / superseding round 1 and starting round 2
    queries.updateExecutionRound(round1.id, { status: 'stopped' });
    queries.createExecutionRound(todo.id, 'rework', 2, 'new-run-token', { status: 'running' });

    // Now late callback from round 1 fires
    oldResolver(0);
    await new Promise((r) => setTimeout(r, 60));

    // Round 2 must not be modified by round 1's callback
    const round2 = queries.getExecutionRoundByRunToken('new-run-token')!;
    expect(round2.status).toBe('running');
  });

  it('10. Atomic transition & database idempotency prevents duplicate active rounds', () => {
    const todo = queries.createTodo(
      project.id,
      'Idempotency Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    expect(round1).toBeTruthy();

    // Second call is idempotent
    const sameRound = reviewPipeline.ensureInitialRound(todo.id);
    expect(sameRound?.id).toBe(round1.id);

    // Attempting to create duplicate active round via raw query throws UNIQUE constraint
    expect(() => {
      queries.createExecutionRound(todo.id, 'review', 2, 'dup-token', { status: 'pending' });
    }).toThrow();
  });

  it('11. Startup reconciliation preserves live running PID', () => {
    const todo = queries.createTodo(
      project.id,
      'Live PID Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const round = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round.id, { status: 'running' });
    queries.updateTodoStatus(todo.id, 'running');
    // Set PID to current active Node process PID (which is live!)
    queries.updateTodo(todo.id, { process_pid: process.pid });

    reviewPipeline.reconcileOnStartup();

    const stillRunningRound = queries.getExecutionRoundById(round.id)!;
    expect(stillRunningRound.status).toBe('running');

    const stillRunningTodo = queries.getTodoById(todo.id)!;
    expect(stillRunningTodo.status).toBe('running');
  });

  it('12. Startup reconciliation fails dead running PID and clears process info', () => {
    const todo = queries.createTodo(
      project.id,
      'Dead PID Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const round = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round.id, { status: 'running' });
    queries.updateTodoStatus(todo.id, 'running');
    // Set PID to non-existent PID
    queries.updateTodo(todo.id, { process_pid: 99999999 });

    reviewPipeline.reconcileOnStartup();

    const failedRound = queries.getExecutionRoundById(round.id)!;
    expect(failedRound.status).toBe('failed');
    expect(failedRound.error_message).toContain('Process terminated unexpectedly');

    const failedTodo = queries.getTodoById(todo.id)!;
    expect(failedTodo.status).toBe('failed');
    expect(failedTodo.process_pid).toBe(0);
  });

  it('13. Manual Approve validation & 409 rejection for invalid states', () => {
    const todo = queries.createTodo(
      project.id,
      'Manual Approve Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);

    // 1. Pending implementation cannot be approved
    expect(() => reviewPipeline.manualApprove(todo.id)).toThrowError(InvalidTransitionError);

    // 2. Setup completed review with needs_changes
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'completed' });
    queries.createExecutionRound(todo.id, 'review', 2, 'rev-token', {
      status: 'completed',
      result_payload: JSON.stringify({ verdict: 'needs_changes', summary: 'Please fix', issues: [] }),
    });
    queries.updateTodo(todo.id, { pipeline_phase: 'review' });
    queries.updateTodoStatus(todo.id, 'stopped');

    // 3. Now manual approve succeeds
    const approved = reviewPipeline.manualApprove(todo.id);
    expect(approved.status).toBe('completed');

    // 4. Duplicate manual approve throws (already completed)
    expect(() => reviewPipeline.manualApprove(todo.id)).toThrowError(InvalidTransitionError);
  });

  it('14. Manual Rework duplicate request deduplication / 409 rejection', () => {
    const todo = queries.createTodo(
      project.id,
      'Manual Rework Task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    // Setup completed review with needs_changes
    queries.createExecutionRound(todo.id, 'review', 1, 'rev-token', {
      status: 'completed',
      result_payload: JSON.stringify({ verdict: 'needs_changes', summary: 'Need changes', issues: [] }),
    });
    queries.updateTodo(todo.id, { pipeline_phase: 'review' });
    queries.updateTodoStatus(todo.id, 'stopped');

    // Call 1: succeeds
    const { round } = reviewPipeline.manualRework(todo.id);
    expect(round.phase).toBe('rework');
    expect(round.status).toBe('pending');

    // Call 2: throws InvalidTransitionError because a round is already active
    expect(() => reviewPipeline.manualRework(todo.id)).toThrowError(InvalidTransitionError);
  });

  it('15. No-review regression: review_enabled=0 follows standard non-pipeline lifecycle', async () => {
    const todo = queries.createTodo(
      project.id,
      'Standard Non-Review Task',
      'Simple fix',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      0 // review_enabled = 0
    );

    await orchestrator.startTodo(todo.id);

    expect(mockClaudeStarts).toHaveLength(1);
    expect(mockClaudeStarts[0].prompt).toContain('Simple fix');

    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(0);

    // Finish process
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    const completed = queries.getTodoById(todo.id)!;
    expect(completed.status).toBe('completed');
  });
});
