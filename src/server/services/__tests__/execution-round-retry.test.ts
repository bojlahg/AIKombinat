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

  it('10. Retry when quota exhausted -> fails with quota error -> retry on available succeeds', async () => {
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

    await executionRoundRetryService.retryExecutionRound(todo.id, round1.id);

    const failedQuotaRound = queries.getLatestExecutionRound(todo.id)!;
    expect(queries.getTodoById(todo.id)?.status).toBe('failed');
    expect(failedQuotaRound.status).toBe('failed');
    expect(failedQuotaRound.error_message).toContain('provider quota exhausted');

    // Reset quota to available and retry again
    queries.upsertProviderQuotaState({
      tool: 'claude',
      state: 'available',
      source: 'test',
      reason: null,
      observed_at: new Date().toISOString(),
      reset_at: null,
    });
    providerQuotaService.resetForTesting();
    await executionRoundRetryService.retryExecutionRound(todo.id, failedQuotaRound.id);

    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    expect(queries.getActiveExecutionRound(todo.id)?.status).toBe('running');
    nextExitResolvers[0](0);
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
    ).rejects.toThrow('Execution round is not retryable from status completed.');
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
});
