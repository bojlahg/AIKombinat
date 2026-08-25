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

const mockGitDiff = vi.fn().mockResolvedValue('diff --git a/index.ts b/index.ts\n+ console.log("reviewed");');

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
        pid: 2000 + mockClaudeStarts.length,
        exitPromise,
        stdout,
        stderr,
        command: cliTool,
        args: [],
      });
    }),
    stopClaude: vi.fn().mockImplementation(() => Promise.resolve(true)),
    killAll: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../worktree-manager.js', () => ({
  worktreeManager: {
    createWorktree: vi.fn().mockResolvedValue({
      worktreePath: '/tmp/worktree-retry-1',
      branchName: 'task-retry-1',
    }),
    isValidWorktree: vi.fn().mockResolvedValue(true),
    sanitizeBranchName: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/git.js', () => ({
  createGit: () => ({
    diff: (...args: any[]) => mockGitDiff(...args),
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
const { reviewPipeline } = await import('../review-pipeline.js');
const { executorPool } = await import('../executor-pool.js');
const { resourceManager } = await import('../resource-manager.js');
const { providerQuotaService } = await import('../provider-quota.js');
const { claudeManager } = await import('../claude-manager.js');
const { worktreeManager } = await import('../worktree-manager.js');
const { executionRoundRetryService, RetryConflictError } = await import('../execution-round-retry.js');

describe('Execution Round Retry & Recovery V1', () => {
  let project: queries.Project;
  let claudeModel: queries.CliModel;
  let reviewProfile: queries.ExecutionProfile;
  let reworkProfile: queries.ExecutionProfile;

  beforeEach(() => {
    mockClaudeStarts = [];
    nextExitResolvers = [];
    mockGitDiff.mockReset().mockResolvedValue('diff --git a/index.ts b/index.ts\n+ console.log("reviewed");');

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);

    resourceManager.shutdown();
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetReservations();
    executorPool.resetLimits();
    providerQuotaService.resetForTesting();

    claudeModel = queries.addModel('claude', 'claude-3-7-sonnet', 'Claude 3.7 Sonnet', ['high']);

    project = queries.createProject('Retry Test Project', '/tmp/retry-proj');
    reviewProfile = queries.createExecutionProfile({
      slug: 'review-prof',
      name: 'Review Profile',
      description: 'Reviewer profile',
      isEnabled: true,
      sortOrder: 0,
      executors: [{ cli_model_id: claudeModel.id, priority: 1 }],
    });

    reworkProfile = queries.createExecutionProfile({
      slug: 'rework-prof',
      name: 'Rework Profile',
      description: 'Reworker profile',
      isEnabled: true,
      sortOrder: 1,
      executors: [{ cli_model_id: claudeModel.id, priority: 1 }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resourceManager.shutdown();
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetLimits();
    executorPool.resetReservations();
    providerQuotaService.resetForTesting();
    testDb.close();
  });

  it('1. Failed Implementation retry -> Review starts upon completion', async () => {
    const todo = queries.createTodo(
      project.id,
      'Implement authentication',
      'Add login and auth tokens',
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

    // Initial start
    await orchestrator.startTodo(todo.id);
    expect(mockClaudeStarts).toHaveLength(1);

    // Process fails with non-zero exit code
    nextExitResolvers[0](1);
    await new Promise((r) => setTimeout(r, 60));

    const failedTodo = queries.getTodoById(todo.id)!;
    expect(failedTodo.status).toBe('failed');

    const roundsAfterFail = queries.getExecutionRoundsByTodoId(todo.id);
    expect(roundsAfterFail).toHaveLength(1);
    expect(roundsAfterFail[0].status).toBe('failed');
    expect(roundsAfterFail[0].phase).toBe('implementation');
    expect(roundsAfterFail[0].attempt_index).toBe(1);

    // Trigger retry
    await executionRoundRetryService.retryExecutionRound(todo.id, roundsAfterFail[0].id);
    expect(mockClaudeStarts).toHaveLength(2);

    const roundsDuringRetry = queries.getExecutionRoundsByTodoId(todo.id);
    expect(roundsDuringRetry).toHaveLength(2);
    expect(roundsDuringRetry[0].status).toBe('failed');
    expect(roundsDuringRetry[1].status).toBe('running');
    expect(roundsDuringRetry[1].round_index).toBe(2);
    expect(roundsDuringRetry[1].attempt_index).toBe(2);
    expect(roundsDuringRetry[1].retry_of_round_id).toBe(roundsAfterFail[0].id);
    expect(roundsDuringRetry[1].input_payload).toBe(roundsAfterFail[0].input_payload);

    // Implementation retry succeeds -> auto-chains to Review
    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(3);
    const roundsAfterSuccess = queries.getExecutionRoundsByTodoId(todo.id);
    expect(roundsAfterSuccess).toHaveLength(3);
    expect(roundsAfterSuccess[1].status).toBe('completed');
    expect(roundsAfterSuccess[2].phase).toBe('review');
    expect(roundsAfterSuccess[2].status).toBe('running');
  });

  it('2. Failed Review retry -> approved -> Todo completed', async () => {
    const todo = queries.createTodo(
      project.id,
      'Build feature',
      'Description',
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

    // 1. Implementation completes -> auto-chains Review
    await orchestrator.startTodo(todo.id);
    expect(mockClaudeStarts).toHaveLength(1);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(2);
    expect(queries.getActiveExecutionRound(todo.id)?.phase).toBe('review');

    // 2. Review crashes
    nextExitResolvers[1](1);
    await new Promise((r) => setTimeout(r, 60));

    const failedReviewRound = queries.getLatestExecutionRound(todo.id)!;
    expect(failedReviewRound.phase).toBe('review');
    expect(failedReviewRound.status).toBe('failed');
    expect(failedReviewRound.attempt_index).toBe(1);

    // 3. Retry Review
    await executionRoundRetryService.retryExecutionRound(todo.id, failedReviewRound.id);
    expect(mockClaudeStarts).toHaveLength(3);

    const retryReviewRound = queries.getActiveExecutionRound(todo.id)!;
    expect(retryReviewRound.phase).toBe('review');
    expect(retryReviewRound.attempt_index).toBe(2);
    expect(retryReviewRound.retry_of_round_id).toBe(failedReviewRound.id);

    // 4. Review returns approved JSON
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({ verdict: 'approved', summary: 'Looks great', issues: [] }),
      retryReviewRound.round_index
    );
    nextExitResolvers[2](0);
    await new Promise((r) => setTimeout(r, 60));

    const completedTodo = queries.getTodoById(todo.id)!;
    expect(completedTodo.status).toBe('completed');
  });

  it('3. Failed Review retry -> needs_changes -> Rework starts', async () => {
    const todo = queries.createTodo(
      project.id,
      'Build feature',
      'Description',
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

    // 1. Implementation succeeds -> auto-chains Review
    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 2. Review #1 crashes
    expect(mockClaudeStarts).toHaveLength(2);
    nextExitResolvers[1](1);
    await new Promise((r) => setTimeout(r, 60));

    // 3. Retry Review
    const failedReview = queries.getLatestExecutionRound(todo.id)!;
    await executionRoundRetryService.retryExecutionRound(todo.id, failedReview.id);
    expect(mockClaudeStarts).toHaveLength(3);

    const retryReviewRound = queries.getActiveExecutionRound(todo.id)!;

    // Review retry returns needs_changes -> auto-chains Rework
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({
        verdict: 'needs_changes',
        summary: 'Found bugs',
        issues: [{ severity: 'blocking', description: 'Fix SQL injection', files: ['db.ts'] }],
      }),
      retryReviewRound.round_index
    );
    nextExitResolvers[2](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(4);
    const allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    const reworkRound = allRounds.find((r) => r.phase === 'rework')!;
    expect(reworkRound).toBeDefined();
    expect(reworkRound.status).toBe('running');
    expect(reworkRound.input_payload).toContain('Fix SQL injection');
  });

  it('4. Failed Rework retry -> next Review starts', async () => {
    const todo = queries.createTodo(
      project.id,
      'Build feature',
      'Description',
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

    // 1. Implementation -> Review #1
    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 2. Review #1 -> needs_changes -> Rework #1
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({
        verdict: 'needs_changes',
        summary: 'Needs rework',
        issues: [{ severity: 'major', description: 'Fix typo' }],
      }),
      2
    );
    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(3);
    const reworkRound1 = queries.getActiveExecutionRound(todo.id)!;
    expect(reworkRound1.phase).toBe('rework');

    // 3. Rework #1 crashes
    nextExitResolvers[2](1);
    await new Promise((r) => setTimeout(r, 60));

    const failedRework = queries.getLatestExecutionRound(todo.id)!;
    expect(failedRework.phase).toBe('rework');
    expect(failedRework.status).toBe('failed');

    // 4. Retry Rework
    await executionRoundRetryService.retryExecutionRound(todo.id, failedRework.id);
    expect(mockClaudeStarts).toHaveLength(4);

    const retryRework = queries.getActiveExecutionRound(todo.id)!;
    expect(retryRework.phase).toBe('rework');
    expect(retryRework.attempt_index).toBe(2);

    // Rework retry succeeds -> auto-chains next Review
    nextExitResolvers[3](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(5);
    const allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    const latestRound = allRounds[allRounds.length - 1];
    expect(latestRound.phase).toBe('review');
    expect(latestRound.status).toBe('running');
  });

  it('5. Stopped round retry', async () => {
    const todo = queries.createTodo(
      project.id,
      'Build feature',
      'Description',
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

    const p1 = orchestrator.startTodo(todo.id);
    await vi.waitFor(() => expect(mockClaudeStarts.length).toBe(1));

    // User stops the task
    await orchestrator.stopTodo(todo.id);
    nextExitResolvers[0](0);
    await p1.catch(() => {});

    const stoppedRound = queries.getLatestExecutionRound(todo.id)!;
    expect(stoppedRound.status).toBe('stopped');

    // User clicks Retry
    await executionRoundRetryService.retryExecutionRound(todo.id, stoppedRound.id);
    expect(mockClaudeStarts).toHaveLength(2);

    const newActiveRound = queries.getActiveExecutionRound(todo.id)!;
    expect(newActiveRound.status).toBe('running');
    expect(newActiveRound.attempt_index).toBe(2);

    nextExitResolvers[1](0);
  });

  it('6 & 7 & 8: Source history immutable, new run_token, new snapshot', async () => {
    const todo = queries.createTodo(
      project.id,
      'Build feature',
      'Description',
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
    nextExitResolvers[0](1);
    await new Promise((r) => setTimeout(r, 60));

    const sourceRound = queries.getExecutionRoundById(queries.getExecutionRoundsByTodoId(todo.id)[0].id)!;
    const oldRunToken = sourceRound.run_token;
    const oldSnapshot = sourceRound.execution_snapshot;

    // Retry
    await executionRoundRetryService.retryExecutionRound(todo.id, sourceRound.id);

    const sourceAfterRetry = queries.getExecutionRoundById(sourceRound.id)!;
    expect(sourceAfterRetry.status).toBe('failed');
    expect(sourceAfterRetry.run_token).toBe(oldRunToken);
    expect(sourceAfterRetry.execution_snapshot).toBe(oldSnapshot);

    const newRound = queries.getActiveExecutionRound(todo.id)!;
    expect(newRound.id).not.toBe(sourceRound.id);
    expect(newRound.run_token).not.toBe(oldRunToken);
    expect(newRound.attempt_index).toBe(2);

    nextExitResolvers[1](0);
  });

  it('9. Retry waiting_executor -> wake -> running', async () => {
    executorPool.setLimit('claude', 1);

    // Saturated by Todo A (no review to avoid auto-chaining keeping capacity held)
    const todoA = queries.createTodo(project.id, 'Task A', 'Desc A', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 0);
    await orchestrator.startTodo(todoA.id);

    // Todo B had failed previously
    const todoB = queries.createTodo(project.id, 'Task B', 'Desc B', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    reviewPipeline.ensureInitialRound(todoB.id);
    const rB = queries.getActiveExecutionRound(todoB.id)!;
    queries.updateExecutionRound(rB.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todoB.id, 'failed');

    // Retry Todo B
    await executionRoundRetryService.retryExecutionRound(todoB.id, rB.id);

    const freshB = queries.getTodoById(todoB.id)!;
    const freshRoundB = queries.getActiveExecutionRound(todoB.id)!;
    expect(freshB.status).toBe('waiting_executor');
    expect(freshRoundB.status).toBe('waiting_executor');

    // Free capacity by completing Todo A
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // Wake up waiting executors
    await orchestrator.wakeWaitingExecutors();
    await new Promise((r) => setTimeout(r, 60));

    expect(queries.getTodoById(todoB.id)?.status).toBe('running');
    expect(queries.getActiveExecutionRound(todoB.id)?.status).toBe('running');

    nextExitResolvers[1](0);
  });

  it('10. Retry when quota exhausted -> waiting_quota -> wake -> running on same round and run token', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task',
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
    queries.updateExecutionRound(round1.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'failed');

    // Set quota exhausted
    providerQuotaService.markExhausted('claude', {
      source: 'test',
      reason: 'Rate limited',
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });

    const initialStarts = mockClaudeStarts.length;

    // Retry round 1 -> creates round 2 and attempts start
    const { round: retryRound } = await executionRoundRetryService.retryExecutionRound(todo.id, round1.id);

    // Should transition to waiting_quota without spawning a CLI process
    expect(mockClaudeStarts.length).toBe(initialStarts);
    const waitingTodo = queries.getTodoById(todo.id)!;
    expect(waitingTodo.status).toBe('waiting_quota');
    const waitingRound = queries.getExecutionRoundById(retryRound.id)!;
    expect(waitingRound.status).toBe('waiting_quota');
    expect(waitingRound.run_token).toBe(retryRound.run_token);

    // Reset quota to unknown / available
    providerQuotaService.markUnknown('claude', { source: 'admin_reset' });

    // Wake waiting quota tasks
    await orchestrator.wakeWaitingQuota();

    // Now round 2 starts running with the SAME round id and SAME run token (no extra retry round)
    expect(mockClaudeStarts.length).toBe(initialStarts + 1);
    const runningTodo = queries.getTodoById(todo.id)!;
    expect(runningTodo.status).toBe('running');
    const runningRound = queries.getExecutionRoundById(retryRound.id)!;
    expect(runningRound.status).toBe('running');
    expect(runningRound.run_token).toBe(retryRound.run_token);
    expect(queries.getExecutionRoundsByTodoId(todo.id)).toHaveLength(2);

    nextExitResolvers[initialStarts](0);
  });

  it('11. Retry waiting_resource -> wake -> running', async () => {
    resourceManager.acquireAtomic({
      ownerType: 'todo',
      ownerId: 'other-todo',
      runToken: 'other-token',
      resources: ['unity.editor'],
    });

    const todoB = queries.createTodo(
      project.id,
      'Task B',
      'Desc B',
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
    reviewPipeline.ensureInitialRound(todoB.id);
    const rB = queries.getActiveExecutionRound(todoB.id)!;
    queries.updateExecutionRound(rB.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todoB.id, 'failed');

    // Retry Todo B while resource is held
    await executionRoundRetryService.retryExecutionRound(todoB.id, rB.id);

    expect(queries.getTodoById(todoB.id)?.status).toBe('waiting_resource');
    expect(queries.getActiveExecutionRound(todoB.id)?.status).toBe('waiting_resource');

    // Release resource
    resourceManager.releaseRun('other-token');

    // Wake and start Todo B
    await orchestrator.startTodo(todoB.id);
    await new Promise((r) => setTimeout(r, 60));

    expect(queries.getTodoById(todoB.id)?.status).toBe('running');
    expect(queries.getActiveExecutionRound(todoB.id)?.status).toBe('running');
    nextExitResolvers[0](0);
  });

  it('12 & 13: Restart reconciliation with dead running retry round', () => {
    const todo = queries.createTodo(project.id, 'Task', 'Desc', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'failed', finished_at: new Date().toISOString() });

    const retryRound = queries.createExecutionRound(todo.id, 'implementation', 2, 'tok-retry-2', {
      status: 'running',
      inputPayload: 'Desc',
      retryOfRoundId: round1.id,
      attemptIndex: 2,
    });
    queries.updateTodo(todo.id, { process_pid: 999999 }); // Dead PID
    queries.updateTodoStatus(todo.id, 'running');

    // Reconcile on startup
    reviewPipeline.reconcileOnStartup();

    const reconciledRound = queries.getExecutionRoundById(retryRound.id)!;
    expect(reconciledRound.status).toBe('failed');
    expect(reconciledRound.error_message).toContain('Process terminated unexpectedly');

    expect(queries.getTodoById(todo.id)?.status).toBe('failed');
  });

  it('14. Concurrent Retry -> 1 success, 1 conflict (409)', async () => {
    const todo = queries.createTodo(project.id, 'Task', 'Desc', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'failed');

    const results = await Promise.allSettled([
      executionRoundRetryService.retryExecutionRound(todo.id, round1.id),
      executionRoundRetryService.retryExecutionRound(todo.id, round1.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RetryConflictError);

    nextExitResolvers[0](0);
  });

  it('15. Retry when active round exists -> rejected (409)', async () => {
    const todo = queries.createTodo(project.id, 'Task', 'Desc', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'running' });
    queries.updateTodoStatus(todo.id, 'running');

    await expect(
      executionRoundRetryService.retryExecutionRound(todo.id, round1.id)
    ).rejects.toThrow(RetryConflictError);
  });

  it('16. Retry completed round -> rejected (409)', async () => {
    const todo = queries.createTodo(project.id, 'Task', 'Desc', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'completed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'completed');

    await expect(
      executionRoundRetryService.retryExecutionRound(todo.id, round1.id)
    ).rejects.toThrow('Task is not retryable from status completed');
  });

  it('17. Retry missing input_payload -> rejected without mutation', async () => {
    const todo = queries.createTodo(project.id, 'Task', 'Desc', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    const round1 = queries.createExecutionRound(todo.id, 'implementation', 1, 'tok-1', {
      status: 'failed',
      inputPayload: null,
      finishedAt: new Date().toISOString(),
    });
    queries.updateTodoStatus(todo.id, 'failed');

    await expect(
      executionRoundRetryService.retryExecutionRound(todo.id, round1.id)
    ).rejects.toThrow('Cannot retry this execution round because its persisted input payload is missing.');

    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(1);
  });

  it('18. Retry round belonging to different Todo -> rejected', async () => {
    const todoA = queries.createTodo(project.id, 'Task A', 'Desc A', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    const todoB = queries.createTodo(project.id, 'Task B', 'Desc B', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);

    reviewPipeline.ensureInitialRound(todoA.id);
    const rA = queries.getActiveExecutionRound(todoA.id)!;
    queries.updateExecutionRound(rA.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todoA.id, 'failed');
    queries.updateTodoStatus(todoB.id, 'failed');

    await expect(
      executionRoundRetryService.retryExecutionRound(todoB.id, rA.id)
    ).rejects.toThrow('Execution round does not belong to this task.');
  });

  it('19. Retry -> immediate Stop race handling', async () => {
    const todo = queries.createTodo(project.id, 'Task', 'Desc', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    reviewPipeline.ensureInitialRound(todo.id);
    const r1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(r1.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'failed');

    const retryPromise = executionRoundRetryService.retryExecutionRound(todo.id, r1.id);
    await vi.waitFor(() => expect(mockClaudeStarts.length).toBe(1));

    // Immediate stop
    await orchestrator.stopTodo(todo.id);
    nextExitResolvers[0](0);
    await retryPromise.catch(() => {});

    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
    const retryRound = queries.getLatestExecutionRound(todo.id)!;
    expect(retryRound.status).toBe('stopped');
  });

  it('20. Retry waiting -> Stop vs wake race', async () => {
    executorPool.setLimit('claude', 1);

    // Holder
    const todoA = queries.createTodo(project.id, 'Task A', 'Desc A', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 0);
    await orchestrator.startTodo(todoA.id);

    // Waiting retry
    const todoB = queries.createTodo(project.id, 'Task B', 'Desc B', 1, 'claude', undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, undefined, null, null, '[]', 1, reviewProfile.id, reworkProfile.id, 3);
    reviewPipeline.ensureInitialRound(todoB.id);
    const rB = queries.getActiveExecutionRound(todoB.id)!;
    queries.updateExecutionRound(rB.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todoB.id, 'failed');

    await executionRoundRetryService.retryExecutionRound(todoB.id, rB.id);
    expect(queries.getTodoById(todoB.id)?.status).toBe('waiting_executor');

    // Stop while waiting
    await orchestrator.stopTodo(todoB.id);
    expect(queries.getTodoById(todoB.id)?.status).toBe('stopped');

    // Complete holder -> wake shouldn't resurrect stopped todo
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    await orchestrator.wakeWaitingExecutors();
    expect(queries.getTodoById(todoB.id)?.status).toBe('stopped');
  });

  it('21. Review max-round semantics: process failure does not consume logical review attempt', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task with Max 2 Reviews',
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
      2 // max_review_rounds = 2
    );

    // 1. Implementation completes -> auto-chains Review #1
    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 2. Review #1 crashes (attempt 1) -> does NOT count toward max_review_rounds
    expect(mockClaudeStarts).toHaveLength(2);
    nextExitResolvers[1](1);
    await new Promise((r) => setTimeout(r, 60));

    const failedReview1 = queries.getLatestExecutionRound(todo.id)!;

    // 3. Retry Review #1 (attempt 2) -> returns needs_changes (logical review #1) -> auto-chains Rework
    await executionRoundRetryService.retryExecutionRound(todo.id, failedReview1.id);
    expect(mockClaudeStarts).toHaveLength(3);

    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({ verdict: 'needs_changes', summary: 'Bug 1', issues: [] }),
      3
    );
    nextExitResolvers[2](0);
    await new Promise((r) => setTimeout(r, 60));

    // 4. Rework #1 completes -> auto-chains Review #2
    expect(mockClaudeStarts).toHaveLength(4);
    nextExitResolvers[3](0);
    await new Promise((r) => setTimeout(r, 60));

    // 5. Review #2 runs (logical review #2) -> returns needs_changes
    expect(mockClaudeStarts).toHaveLength(5);
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({ verdict: 'needs_changes', summary: 'Bug 2', issues: [] }),
      5
    );
    nextExitResolvers[4](0);
    await new Promise((r) => setTimeout(r, 60));

    // Reached max_review_rounds = 2 on logical review 2
    const finalTodo = queries.getTodoById(todo.id)!;
    expect(finalTodo.status).toBe('failed');
    const logs = queries.getTaskLogsByTodoId(todo.id);
    expect(logs.some((l) => l.message.includes('Maximum review rounds reached (2)'))).toBe(true);
  });

  it('22. Invalid Review JSON -> Retry -> valid approved', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task Invalid JSON',
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

    // 1. Implementation completes -> auto-chains Review
    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 2. Review outputs non-JSON text
    expect(mockClaudeStarts).toHaveLength(2);
    queries.createTaskLog(todo.id, 'output', 'This is plain text without any JSON verdict.', 2);
    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    const failedReview = queries.getLatestExecutionRound(todo.id)!;
    expect(failedReview.status).toBe('failed');
    expect(failedReview.error_message).toContain('Failed to parse reviewer output as JSON');

    // 3. Retry Review
    await executionRoundRetryService.retryExecutionRound(todo.id, failedReview.id);
    expect(mockClaudeStarts).toHaveLength(3);

    // Outputs valid approved JSON
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({ verdict: 'approved', summary: 'Code verified successfully', issues: [] }),
      3
    );
    nextExitResolvers[2](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(queries.getTodoById(todo.id)?.status).toBe('completed');
  });

  it('23. Generic Start cannot resurrect or mutate terminal reviewed round (failed, stopped, completed)', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task Terminal Start',
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
    queries.updateExecutionRound(round1.id, {
      status: 'failed',
      error_message: 'Original failure',
      finished_at: new Date().toISOString(),
    });
    queries.updateTodoStatus(todo.id, 'failed');

    // Attempting generic startTodo must throw and NOT resurrect/mutate round1
    await expect(orchestrator.startTodo(todo.id)).rejects.toThrow(
      'Reviewed pipeline has a terminal execution round. Use Retry Phase instead of Start.'
    );

    const roundAfterStart = queries.getExecutionRoundById(round1.id)!;
    expect(roundAfterStart.status).toBe('failed');
    expect(roundAfterStart.error_message).toBe('Original failure');

    // Explicit phase retry must succeed normally
    await executionRoundRetryService.retryExecutionRound(todo.id, round1.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    expect(queries.getActiveExecutionRound(todo.id)?.status).toBe('running');
    nextExitResolvers[0](0);
  });

  it('24. Historical failed round cannot be retried after newer rounds exist (409)', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task Historical Retry',
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

    // 1. Implementation round 1 fails
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'failed');

    // 2. Retry Implementation (round 2) -> succeeds -> auto-chains Review (round 3)
    await executionRoundRetryService.retryExecutionRound(todo.id, round1.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 3. Review (round 3) fails
    expect(mockClaudeStarts).toHaveLength(2);
    nextExitResolvers[1](1);
    await new Promise((r) => setTimeout(r, 60));

    expect(queries.getTodoById(todo.id)?.status).toBe('failed');
    const latestRound = queries.getLatestExecutionRound(todo.id)!;
    expect(latestRound.round_index).toBe(3);

    // 4. Attempting to retry obsolete round 1 must fail with 409
    await expect(
      executionRoundRetryService.retryExecutionRound(todo.id, round1.id)
    ).rejects.toThrow('Only the latest failed/stopped execution round can be retried.');

    // 5. Retrying latest round (round 3) succeeds normally
    await executionRoundRetryService.retryExecutionRound(todo.id, latestRound.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    expect(queries.getActiveExecutionRound(todo.id)?.round_index).toBe(4);
    nextExitResolvers[2](0);
  });

  it('25. Completed Todo cannot retry old failed attempt (409)', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task Completed with Old Attempt',
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

    // Round 1 failed
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'failed');

    // Round 2 (retry) succeeds -> auto-chains Review (round 3)
    await executionRoundRetryService.retryExecutionRound(todo.id, round1.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // Round 3 (review) approves -> completed
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({ verdict: 'approved', summary: 'Approved', issues: [] }),
      3
    );
    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(queries.getTodoById(todo.id)?.status).toBe('completed');

    // Retrying old round 1 on completed todo must be rejected with 409
    await expect(
      executionRoundRetryService.retryExecutionRound(todo.id, round1.id)
    ).rejects.toThrow();
  });

  it('26. Stop while waiting_quota -> remains stopped after quota wake', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task Stop Quota',
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
    queries.updateExecutionRound(round1.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'failed');

    // Set quota exhausted
    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'quota' });

    // Retry -> becomes waiting_quota
    await executionRoundRetryService.retryExecutionRound(todo.id, round1.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('waiting_quota');

    // Stop todo
    await orchestrator.stopTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');

    // Quota becomes available -> wake
    providerQuotaService.markUnknown('claude');
    await orchestrator.wakeWaitingQuota();

    // Must remain stopped (not resurrected!)
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
  });

  it('27. stopProject stops waiting_quota tasks', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task stopProject Quota',
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
    queries.updateExecutionRound(round1.id, { status: 'failed', finished_at: new Date().toISOString() });
    queries.updateTodoStatus(todo.id, 'failed');

    providerQuotaService.markExhausted('claude', { source: 'test' });
    await executionRoundRetryService.retryExecutionRound(todo.id, round1.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('waiting_quota');

    await orchestrator.stopProject(project.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
  });

  it('28. Startup restart with waiting_quota remains recoverable without failing', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task Startup Quota',
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
    queries.updateExecutionRound(round1.id, { status: 'waiting_quota' });
    queries.updateTodoStatus(todo.id, 'waiting_quota');

    // Reconcile on startup
    reviewPipeline.reconcileOnStartup();

    // Must still be waiting_quota, not failed
    expect(queries.getTodoById(todo.id)?.status).toBe('waiting_quota');
    expect(queries.getExecutionRoundById(round1.id)?.status).toBe('waiting_quota');
  });

  it('29. Profile with candidate A quota-exhausted and candidate B available selects B', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-5-sonnet', 'Claude 3.5 Sonnet');
    const modelCodex = queries.addModel('codex', 'o3-mini', 'o3 Mini');

    const multiProfile = queries.createExecutionProfile({
      name: 'Multi Candidate Profile',
      slug: 'multi-cand-profile',
      description: 'Multi profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
        { cli_model_id: modelCodex.id, priority: 2, is_enabled: 1 },
      ],
    });

    // Claude is exhausted, Codex is available
    providerQuotaService.markExhausted('claude', { source: 'test' });
    providerQuotaService.markUnknown('codex');

    const selection = await executorPool.selectExecutor({
      executionProfileId: multiProfile.id,
    });

    expect(selection.status).toBe('selected');
    expect(selection.selectedConfig?.cliTool).toBe('codex');
    expect(selection.selectedConfig?.model).toBe('o3-mini');
  });

  it('30. Profile with all candidates quota-exhausted transitions to waiting_quota', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-5-sonnet-q', 'Claude 3.5 Sonnet Q');
    const modelCodex = queries.addModel('codex', 'o3-mini-q', 'o3 Mini Q');

    const multiProfile = queries.createExecutionProfile({
      name: 'All Quota Exhausted Profile',
      slug: 'all-quota-profile',
      description: 'All quota profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
        { cli_model_id: modelCodex.id, priority: 2, is_enabled: 1 },
      ],
    });

    providerQuotaService.markExhausted('claude', { source: 'test' });
    providerQuotaService.markExhausted('codex', { source: 'test' });

    const selection = await executorPool.selectExecutor({
      executionProfileId: multiProfile.id,
    });

    expect(selection.status).toBe('waiting_quota');
  });

  it('31. Unknown quota state does not block admission', async () => {
    providerQuotaService.markUnknown('claude');
    const state = providerQuotaService.getQuotaState('claude');
    expect(state.state).toBe('unknown');

    const todo = queries.createTodo(
      project.id,
      'Task Unknown Quota',
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
    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    nextExitResolvers[0](0);
  });

  it('32. Stop Project race with explicit phase Retry and generic Start', async () => {
    // 1. Todo A is running
    const todoA = queries.createTodo(
      project.id,
      'Task A Running',
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
    await orchestrator.startTodo(todoA.id);
    expect(queries.getTodoById(todoA.id)?.status).toBe('running');
    const initialStartsCount = mockClaudeStarts.length;

    // 2. Todo B is reviewed + failed with retryable latest round
    const todoB = queries.createTodo(
      project.id,
      'Task B Failed',
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
    reviewPipeline.ensureInitialRound(todoB.id);
    const roundB1 = queries.getActiveExecutionRound(todoB.id)!;
    queries.updateExecutionRound(roundB1.id, {
      status: 'failed',
      error_message: 'Failure before stop',
      finished_at: new Date().toISOString(),
    });
    queries.updateTodoStatus(todoB.id, 'failed');

    // 3. Mock stopClaude to hang until we resolve it
    let resolveStopClaude: (value: boolean) => void;
    const stopClaudePromise = new Promise<boolean>((resolve) => {
      resolveStopClaude = resolve;
    });
    const stopSpy = vi.spyOn(claudeManager, 'stopClaude').mockReturnValueOnce(stopClaudePromise);

    // 4. Call stopProject without awaiting
    const stopProjectPromise = orchestrator.stopProject(project.id);
    expect(orchestrator.isStoppingProject(project.id)).toBe(true);

    // 5. Attempt explicit Retry Phase on Todo B while Stop Project is pending
    await expect(
      executionRoundRetryService.retryExecutionRound(todoB.id, roundB1.id)
    ).rejects.toThrow('Task or project is currently stopping.');

    // Verify no new round and no new process started for B
    expect(queries.getExecutionRoundsByTodoId(todoB.id)).toHaveLength(1);
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    // 6. Attempt direct generic Start on Todo B while Stop Project is pending
    await expect(orchestrator.startTodo(todoB.id)).rejects.toThrow('Cannot start task while stopping.');
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    // 7. Resolve stopClaude so stopProject finishes
    resolveStopClaude!(true);
    await stopProjectPromise;

    expect(orchestrator.isStoppingProject(project.id)).toBe(false);
    expect(queries.getTodoById(todoA.id)?.status).toBe('stopped');
    expect(queries.getTodoById(todoB.id)?.status).toBe('failed');

    // 8. Now that Stop Project is completed, explicit retry succeeds normally
    await executionRoundRetryService.retryExecutionRound(todoB.id, roundB1.id);
    expect(queries.getTodoById(todoB.id)?.status).toBe('running');
    expect(queries.getExecutionRoundsByTodoId(todoB.id)).toHaveLength(2);
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);

    nextExitResolvers[initialStartsCount](0);
    stopSpy.mockRestore();
  });

  it('33. Mixed busy + quota-blocked profile wakes when quota becomes available', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-mb', 'Claude 3.7 Sonnet MB');
    const modelCodex = queries.addModel('codex', 'gpt-5-mb', 'GPT-5 MB');

    const profile = queries.createExecutionProfile({
      name: 'Mixed Busy Quota Profile',
      slug: 'mixed-busy-quota',
      description: 'Mixed profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
        { cli_model_id: modelCodex.id, priority: 2, is_enabled: 1 },
      ],
    });

    // Claude is busy (limit = 0), Codex is quota-exhausted
    executorPool.setLimit('claude', 0);
    providerQuotaService.markExhausted('codex', { source: 'test', reason: 'codex rate limit' });

    const todo = queries.createTodo(
      project.id,
      'Task Mixed Wake on Quota',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
    );

    const initialStartsCount = mockClaudeStarts.length;

    // Start todo -> admission wait (no process launched)
    await orchestrator.startTodo(todo.id);
    const waitingTodo = queries.getTodoById(todo.id)!;
    expect(waitingTodo.status === 'waiting_executor' || waitingTodo.status === 'waiting_quota').toBe(true);
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    // Make Codex quota available while Claude remains busy
    providerQuotaService.markUnknown('codex');

    // Trigger normal quota wake
    await orchestrator.wakeWaitingQuota();

    // Todo automatically starts running with Codex (Candidate B) without manual start or executor-capacity event
    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);
    expect(mockClaudeStarts[initialStartsCount].cliTool).toBe('codex');

    nextExitResolvers[initialStartsCount](0);
    executorPool.resetLimits();
  });

  it('34. Mixed busy + quota-blocked profile wakes when executor capacity frees', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-cap', 'Claude 3.7 Sonnet Cap');
    const modelCodex = queries.addModel('codex', 'gpt-5-cap', 'GPT-5 Cap');

    const profile = queries.createExecutionProfile({
      name: 'Mixed Capacity Profile',
      slug: 'mixed-cap-profile',
      description: 'Mixed profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
        { cli_model_id: modelCodex.id, priority: 2, is_enabled: 1 },
      ],
    });

    // Claude is busy (limit = 0), Codex is quota-exhausted
    executorPool.setLimit('claude', 0);
    providerQuotaService.markExhausted('codex', { source: 'test', reason: 'codex quota exhausted' });

    const todo = queries.createTodo(
      project.id,
      'Task Mixed Wake on Capacity',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
    );

    const initialStartsCount = mockClaudeStarts.length;

    // Start todo -> admission wait
    await orchestrator.startTodo(todo.id);
    const waitingTodo = queries.getTodoById(todo.id)!;
    expect(waitingTodo.status === 'waiting_executor' || waitingTodo.status === 'waiting_quota').toBe(true);
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    // Free Claude capacity while Codex remains quota-exhausted
    executorPool.setLimit('claude', 5);

    // Trigger executor capacity wake
    await orchestrator.wakeWaitingExecutors();

    // Todo automatically starts running with Claude (Candidate A)
    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);
    expect(mockClaudeStarts[initialStartsCount].cliTool).toBe('claude');

    nextExitResolvers[initialStartsCount](0);
    executorPool.resetLimits();
  });

  it('35. Concurrent wakeWaitingExecutors() and wakeWaitingQuota() process waiting todo exactly once', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-race', 'Claude 3.7 Sonnet Race');
    const profile = queries.createExecutionProfile({
      name: 'Concurrent Wake Race Profile',
      slug: 'concurrent-wake-race',
      description: 'Concurrent wake profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
      ],
    });

    // 1. Quota is exhausted initially -> todo goes to waiting_quota
    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'temporary exhaustion' });

    const todo = queries.createTodo(
      project.id,
      'Task Concurrent Wake Race',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
      'high',
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    const initialStartsCount = mockClaudeStarts.length;

    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('waiting_quota');
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    // 2. Provider quota becomes available
    providerQuotaService.markUnknown('claude');

    // 3. Fire wakeWaitingExecutors and wakeWaitingQuota concurrently
    await Promise.all([
      orchestrator.wakeWaitingExecutors(),
      orchestrator.wakeWaitingQuota(),
    ]);

    // 4. Verify exactly ONE process was launched
    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('running');
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);

    const expectedPid = 2000 + initialStartsCount + 1;
    expect(updatedTodo.process_pid).toBe(expectedPid);

    // Verify execution rounds
    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].status).toBe('running');

    nextExitResolvers[initialStartsCount](0);
  });

  it('36. Startup-style concurrent admission wake requests in the same tick serialize safely', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-tick', 'Claude 3.7 Sonnet Tick');
    const profile = queries.createExecutionProfile({
      name: 'Startup Tick Profile',
      slug: 'startup-tick-profile',
      description: 'Startup tick profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
      ],
    });

    executorPool.setLimit('claude', 0);

    const todo = queries.createTodo(
      project.id,
      'Task Startup Tick Race',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
    );

    const initialStartsCount = mockClaudeStarts.length;

    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('waiting_executor');
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    executorPool.setLimit('claude', 5);

    // Issue multiple admission wakes in the same tick
    const p1 = orchestrator.wakeWaitingExecutors();
    const p2 = orchestrator.wakeWaitingQuota();
    const p3 = orchestrator.wakeWaitingExecutors();

    await Promise.all([p1, p2, p3]);

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('running');
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);

    nextExitResolvers[initialStartsCount](0);
    executorPool.resetLimits();
  });

  it('37. Concurrent manual start and admission wake spawns exactly once', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-manwake', 'Claude 3.7 Sonnet ManWake');
    const profile = queries.createExecutionProfile({
      name: 'ManWake Profile',
      slug: 'manwake-profile',
      description: 'ManWake profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
      ],
    });

    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'exhausted' });

    const todo = queries.createTodo(
      project.id,
      'Task Manual Start and Admission Wake',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
    );

    const initialStartsCount = mockClaudeStarts.length;

    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('waiting_quota');
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    providerQuotaService.markUnknown('claude');

    // Launch manual start and admission wake concurrently
    await Promise.all([
      orchestrator.startTodo(todo.id),
      orchestrator.wakeWaitingQuota(),
    ]);

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('running');
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);

    nextExitResolvers[initialStartsCount](0);
  });

  it('38. Concurrent startProject and admission wake spawns exactly once', async () => {
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-projwake', 'Claude 3.7 Sonnet ProjWake');
    const profile = queries.createExecutionProfile({
      name: 'ProjWake Profile',
      slug: 'projwake-profile',
      description: 'ProjWake profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
      ],
    });

    const testProject = queries.createProject('ProjWake Project', '/tmp/projwake-proj');

    const todo = queries.createTodo(
      testProject.id,
      'Task ProjWake',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
    );

    const initialStartsCount = mockClaudeStarts.length;

    // Concurrently start project and wake admission
    await Promise.all([
      orchestrator.startProject(testProject.id),
      orchestrator.wakeWaitingExecutors(),
    ]);

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('running');
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);

    nextExitResolvers[initialStartsCount](0);
  });

  it('39. Repeated concurrent manual start attempts never spawn twice', async () => {
    const todo = queries.createTodo(
      project.id,
      'Task Concurrent Manual Start',
      'Desc',
      1,
      'claude',
    );

    const initialStartsCount = mockClaudeStarts.length;

    // Concurrent manual start calls
    await Promise.allSettled([
      orchestrator.startTodo(todo.id),
      orchestrator.startTodo(todo.id),
    ]);

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('running');
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);

    nextExitResolvers[initialStartsCount](0);
  });

  it('40. Stop during async executor selection cancels startup and cleans up reservations', async () => {
    const testProject = queries.createProject('StopSel Project', '/tmp/stopsel-proj');
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-stopsel', 'Claude 3.7 Sonnet StopSel');
    const profile = queries.createExecutionProfile({
      name: 'StopSel Profile',
      slug: 'stopsel-profile',
      description: 'StopSel profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
      ],
    });

    const todo = queries.createTodo(
      testProject.id,
      'Task Stop During Selection',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
      'high',
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    // Initial round created
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, {
      status: 'failed',
      error_message: 'Failure 1',
      finished_at: new Date().toISOString(),
    });
    queries.updateTodoStatus(todo.id, 'failed');

    // Create a controllable delay in selectExecutor
    let resolveSelect: () => void;
    const selectPromise = new Promise<void>((resolve) => {
      resolveSelect = resolve;
    });

    const origSelect = executorPool.selectExecutor.bind(executorPool);
    const selectSpy = vi.spyOn(executorPool, 'selectExecutor').mockImplementation(async (opts) => {
      const res = await origSelect(opts);
      await selectPromise;
      return res;
    });

    const initialStartsCount = mockClaudeStarts.length;

    // Begin retry phase (which calls startTodo -> selectExecutor)
    const retryPromise = executionRoundRetryService.retryExecutionRound(todo.id, round1.id);

    // Give time for selectExecutor to be called
    await new Promise((r) => setTimeout(r, 10));

    // While selectExecutor is in-flight, user clicks Stop Todo
    await orchestrator.stopTodo(todo.id);

    // Release the selectExecutor delay
    resolveSelect!();
    await retryPromise.catch(() => {});

    // Assertions:
    // 1. No CLI process spawned
    expect(mockClaudeStarts.length).toBe(initialStartsCount);
    // 2. Todo remains stopped
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
    // 3. Retry round remains stopped
    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(2);
    expect(rounds[1].status).toBe('stopped');
    // 4. No executor reservation remains
    expect(executorPool.getReservations().find((r) => r.ownerId === todo.id)).toBeUndefined();

    // 5. Subsequent wake does not resurrect
    await orchestrator.wakeWaitingExecutors();
    await orchestrator.wakeWaitingQuota();
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    selectSpy.mockRestore();
  });

  it('41. Stop during async worktree setup cancels startup and cleans up resources', async () => {
    const testProject = queries.createProject('StopWT Project', '/tmp/stopwt-proj', undefined, undefined, 1);
    const todo = queries.createTodo(
      testProject.id,
      'Task Stop During Worktree',
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

    let resolveWorktree: () => void;
    const worktreePromise = new Promise<void>((resolve) => {
      resolveWorktree = resolve;
    });

    const createWorktreeSpy = vi.spyOn(worktreeManager, 'createWorktree').mockImplementation(async () => {
      await worktreePromise;
      return {
        worktreePath: '/tmp/worktree-stop-wt',
        branchName: 'task-stop-wt',
      };
    });

    const initialStartsCount = mockClaudeStarts.length;

    const startPromise = orchestrator.startTodo(todo.id);
    await new Promise((r) => setTimeout(r, 10));

    // Stop while worktree creation is pending
    await orchestrator.stopTodo(todo.id);

    // Release worktree creation
    resolveWorktree!();
    await startPromise.catch(() => {});

    // Assertions
    expect(mockClaudeStarts.length).toBe(initialStartsCount);
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
    const round = queries.getExecutionRoundsByTodoId(todo.id)[0];
    expect(round.status).toBe('stopped');

    createWorktreeSpy.mockRestore();
  });

  it('42. Stop while startClaude is pending immediately terminates spawned process and prevents resurrection', async () => {
    const testProject = queries.createProject('StopStartClaude Project', '/tmp/stopsc-proj');
    const todo = queries.createTodo(
      testProject.id,
      'Task Stop During StartClaude',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      0,
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

    let resolveStartClaude: (val: any) => void;
    const startClaudePromise = new Promise<any>((resolve) => {
      resolveStartClaude = resolve;
    });

    const startClaudeSpy = vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      return startClaudePromise;
    });

    const initialStartsCount = mockClaudeStarts.length;

    const startPromise = orchestrator.startTodo(todo.id);
    await new Promise((r) => setTimeout(r, 10));

    // Call stopTodo while startClaude is awaiting process spawn
    await orchestrator.stopTodo(todo.id);

    // Clear stopClaude mock calls before resolving late process
    vi.mocked(claudeManager.stopClaude).mockClear();

    // Now resolve startClaude with a spawned OS PID
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const latePid = 9999;
    resolveStartClaude!({
      pid: latePid,
      exitPromise: Promise.resolve(0),
      stdout,
      stderr,
      command: 'claude',
      args: [],
    });

    await startPromise.catch(() => {});

    // Assertions:
    // 1. claudeManager.stopClaude was immediately called for the late-spawned PID
    expect(claudeManager.stopClaude).toHaveBeenCalledWith(latePid);
    // 2. PID 9999 was NOT saved on the Todo
    const currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.process_pid).toBe(0);
    expect(currentTodo.status).toBe('stopped');
    // 3. Round remains stopped
    const round = queries.getExecutionRoundsByTodoId(todo.id)[0];
    expect(round.status).toBe('stopped');

    startClaudeSpy.mockRestore();
  });

  it('43. Immediate Retry while cancelled startup is draining waits and launches successfully', async () => {
    const testProject = queries.createProject('DrainRetry Project', '/tmp/drainretry-proj', undefined, undefined, 1);
    const modelClaude = queries.addModel('claude', 'claude-3-7-sonnet-drainretry', 'Claude 3.7 Sonnet DrainRetry');
    const profile = queries.createExecutionProfile({
      name: 'DrainRetry Profile',
      slug: 'drainretry-profile',
      description: 'DrainRetry profile',
      executors: [
        { cli_model_id: modelClaude.id, priority: 1, is_enabled: 1 },
      ],
    });

    const todo = queries.createTodo(
      testProject.id,
      'Task Drain Retry',
      'Desc',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      profile.id,
      'high',
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    // Initial round created and failed
    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, {
      status: 'failed',
      error_message: 'Failure 1',
      finished_at: new Date().toISOString(),
    });
    queries.updateTodoStatus(todo.id, 'failed');

    // Create a controllable delay for worktree creation
    let resolveWorktree1: () => void;
    const worktreePromise1 = new Promise<void>((resolve) => {
      resolveWorktree1 = resolve;
    });

    let createCallCount = 0;
    const createWorktreeSpy = vi.spyOn(worktreeManager, 'createWorktree').mockImplementation(async () => {
      createCallCount++;
      if (createCallCount === 1) {
        await worktreePromise1;
      }
      return {
        worktreePath: `/tmp/worktree-drain-${createCallCount}`,
        branchName: `task-drain-${createCallCount}`,
      };
    });

    const initialStartsCount = mockClaudeStarts.length;

    // Retry attempt #1: creates round #2
    const retry1Promise = executionRoundRetryService.retryExecutionRound(todo.id, round1.id);
    await new Promise((r) => setTimeout(r, 10));

    // Confirm round #2 was created
    const roundsAfterRetry1 = queries.getExecutionRoundsByTodoId(todo.id);
    expect(roundsAfterRetry1).toHaveLength(2);
    const round2 = roundsAfterRetry1[1];

    // User calls stopTodo(todo.id) while worktree creation in retry #1 is still delayed
    await orchestrator.stopTodo(todo.id);

    // Confirm Todo and round #2 are stopped
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
    expect(queries.getExecutionRoundById(round2.id)?.status).toBe('stopped');

    // WITHOUT resolving old delayed startup yet, invoke explicit Retry Phase again for round #2!
    const retry2Promise = executionRoundRetryService.retryExecutionRound(todo.id, round2.id);

    // A new retry round #3 should be created with status 'pending'
    const roundsAfterRetry2 = queries.getExecutionRoundsByTodoId(todo.id);
    expect(roundsAfterRetry2).toHaveLength(3);
    const round3 = roundsAfterRetry2[2];
    expect(round3.status).toBe('pending');
    expect(queries.getTodoById(todo.id)?.status).toBe('pending');

    // Now resolve the old delayed startup from retry #1
    resolveWorktree1!();

    // Await retry promises
    await retry1Promise.catch(() => {});
    await retry2Promise;

    // Assertions:
    // 1. Exactly one provider process spawned for retry #3 (overall starts count increases by 1)
    expect(mockClaudeStarts.length).toBe(initialStartsCount + 1);

    // 2. Todo is running
    const finalTodo = queries.getTodoById(todo.id)!;
    expect(finalTodo.status).toBe('running');

    // 3. Round #2 remains stopped forever
    expect(queries.getExecutionRoundById(round2.id)?.status).toBe('stopped');

    // 4. Round #3 is running
    expect(queries.getExecutionRoundById(round3.id)?.status).toBe('running');

    // 5. No stale reservation remains
    expect(executorPool.getReservations().find((r) => r.ownerId === todo.id)).toBeUndefined();

    // Clean up process
    nextExitResolvers[initialStartsCount](0);
    createWorktreeSpy.mockRestore();
  });

  it('44. Stop during isValidWorktree(false) cancels startup and does not call createWorktree', async () => {
    const testProject = queries.createProject('ValidWTCancel Project', '/tmp/validwt-proj', undefined, 1);
    const todo = queries.createTodo(
      testProject.id,
      'Task ValidWT Cancel',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
    );
    queries.updateTodo(todo.id, {
      branch_name: 'branch-existing',
      worktree_path: '/tmp/existing-worktree',
      review_enabled: 1,
      review_profile_id: reviewProfile.id,
      rework_profile_id: reworkProfile.id,
    });
    reviewPipeline.ensureInitialRound(todo.id);

    let resolveIsValid: (val: boolean) => void;
    const isValidPromise = new Promise<boolean>((resolve) => {
      resolveIsValid = resolve;
    });

    vi.mocked(worktreeManager.createWorktree).mockClear();
    const isValidWorktreeSpy = vi.spyOn(worktreeManager, 'isValidWorktree').mockImplementation(async () => {
      return isValidPromise;
    });
    const createWorktreeSpy = vi.spyOn(worktreeManager, 'createWorktree');

    const initialStartsCount = mockClaudeStarts.length;

    const startPromise = orchestrator.startTodo(todo.id);
    await new Promise((r) => setTimeout(r, 10));

    // Call stopTodo while isValidWorktree is pending
    await orchestrator.stopTodo(todo.id);

    // Now resolve isValidWorktree as false (invalid worktree)
    resolveIsValid!(false);

    await startPromise.catch(() => {});

    // Assertions:
    // 1. createWorktree was NEVER called
    expect(createWorktreeSpy).not.toHaveBeenCalled();

    // 2. No CLI process spawned
    expect(mockClaudeStarts.length).toBe(initialStartsCount);

    // 3. Todo and round remain stopped
    expect(queries.getTodoById(todo.id)?.status).toBe('stopped');
    const round = queries.getExecutionRoundsByTodoId(todo.id)[0];
    expect(round.status).toBe('stopped');

    isValidWorktreeSpy.mockRestore();
    createWorktreeSpy.mockRestore();
  });
});

