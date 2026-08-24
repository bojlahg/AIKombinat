import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import Database from 'better-sqlite3';
import { initDatabase, dedupeLegacyExecutionRounds } from '../../db/schema.js';

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
        pid: 1000 + mockClaudeStarts.length,
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
const { reviewPipeline, InvalidTransitionError } = await import('../review-pipeline.js');
const { executorPool } = await import('../executor-pool.js');
const { resourceManager } = await import('../resource-manager.js');
const { providerQuotaService } = await import('../provider-quota.js');
const { claudeManager } = await import('../claude-manager.js');

describe('Review / Rework Orchestrator Integration & Lifecycle Races', () => {
  let project: queries.Project;
  let claudeModel: queries.CliModel;
  let claudeHaiku: queries.CliModel;
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
    vi.restoreAllMocks();
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
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);

    expect(mockClaudeStarts).toHaveLength(1);
    expect(mockClaudeStarts[0].prompt).toContain('Implement JWT token handling');

    let rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].phase).toBe('implementation');
    expect(rounds[0].status).toBe('running');

    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

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
    expect(mockClaudeStarts).toHaveLength(1);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(2);
    expect(mockClaudeStarts[1].prompt).toContain('Review Round 1 of 3');

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

    expect(mockClaudeStarts).toHaveLength(3);
    expect(mockClaudeStarts[2].prompt).toContain('# Rework Request — Code Review Feedback');
    expect(mockClaudeStarts[2].prompt).toContain('Avatar image size is not validated.');
    expect(mockClaudeStarts[2].prompt).toContain('Validate avatar file size <= 5MB before upload.');

    let rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(3);
    expect(rounds[2].phase).toBe('rework');
    expect(rounds[2].status).toBe('running');

    nextExitResolvers[2](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(4);
    expect(mockClaudeStarts[3].prompt).toContain('Review Round 2 of 3');
    expect(mockClaudeStarts[3].prompt).toContain('Validate avatar file size <= 5MB before upload.');

    rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(4);
    expect(rounds[3].phase).toBe('review');
    expect(rounds[3].round_index).toBe(4);

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

    vi.spyOn(executorPool, 'selectExecutor').mockResolvedValueOnce({
      status: 'waiting_executor',
      profileName: 'Review Profile',
      rejectionSummary: 'No executor capacity available',
    });

    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    const currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.status).toBe('waiting_executor');

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    expect(reviewRound.phase).toBe('review');
    expect(reviewRound.status).toBe('waiting_executor');

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

    resourceManager.acquireAtomic({
      ownerType: 'todo',
      ownerId: 'other-todo',
      runToken: 'other-token',
      resources: ['unity.editor'],
    });

    await orchestrator.startTodo(todo.id);

    const currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.status).toBe('waiting_resource');

    const round = queries.getActiveExecutionRound(todo.id)!;
    expect(round.status).toBe('waiting_resource');

    resourceManager.releaseRun('other-token');
    await orchestrator.wakeWaitingResources();
    await new Promise((r) => setTimeout(r, 60));

    const runningRound = queries.getExecutionRoundById(round.id)!;
    expect(runningRound.status).toBe('running');
  });

  it('6. Runtime quota rejection in Review profile switches to next candidate', async () => {
    const codexModel = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
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
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(2);

    queries.createTaskLog(todo.id, 'output', '429 Rate limit exceeded for claude-3-7-sonnet');
    nextExitResolvers[1](1);
    await new Promise((r) => setTimeout(r, 80));

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

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    expect(reviewRound.phase).toBe('review');

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

    resourceManager.acquireAtomic({
      ownerType: 'todo', ownerId: 'other', runToken: 'tok1', resources: ['unity.editor'],
    });

    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)!.status).toBe('waiting_resource');

    await orchestrator.stopTodo(todo.id);
    expect(queries.getTodoById(todo.id)!.status).toBe('stopped');

    resourceManager.releaseRun('tok1');
    await orchestrator.wakeWaitingResources();

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

    queries.updateExecutionRound(round1.id, { status: 'stopped' });
    queries.createExecutionRound(todo.id, 'rework', 2, 'new-run-token', { status: 'running' });

    oldResolver(0);
    await new Promise((r) => setTimeout(r, 60));

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

    const sameRound = reviewPipeline.ensureInitialRound(todo.id);
    expect(sameRound?.id).toBe(round1.id);

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

    expect(() => reviewPipeline.manualApprove(todo.id)).toThrowError(InvalidTransitionError);

    const round1 = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round1.id, { status: 'completed' });
    queries.createExecutionRound(todo.id, 'review', 2, 'rev-token', {
      status: 'completed',
      result_payload: JSON.stringify({ verdict: 'needs_changes', summary: 'Please fix', issues: [] }),
    });
    queries.updateTodo(todo.id, { pipeline_phase: 'review' });
    queries.updateTodoStatus(todo.id, 'stopped');

    const approved = reviewPipeline.manualApprove(todo.id);
    expect(approved.status).toBe('completed');

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

    queries.createExecutionRound(todo.id, 'review', 1, 'rev-token', {
      status: 'completed',
      result_payload: JSON.stringify({ verdict: 'needs_changes', summary: 'Need changes', issues: [] }),
    });
    queries.updateTodo(todo.id, { pipeline_phase: 'review' });
    queries.updateTodoStatus(todo.id, 'stopped');

    const { round } = reviewPipeline.manualRework(todo.id);
    expect(round.phase).toBe('rework');
    expect(round.status).toBe('pending');

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
      0
    );

    await orchestrator.startTodo(todo.id);

    expect(mockClaudeStarts).toHaveLength(1);
    expect(mockClaudeStarts[0].prompt).toContain('Simple fix');

    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(0);

    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    const completed = queries.getTodoById(todo.id)!;
    expect(completed.status).toBe('completed');
  });

  it('16. Race 1: stopTodo exitPromise race prevents premature round completion and rework auto-chaining', async () => {
    const todo = queries.createTodo(
      project.id,
      'Stop Race Task',
      'Implement feature',
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

    await orchestrator.startTodo(todo.id);
    expect(mockClaudeStarts).toHaveLength(1);

    // Implementation completes, review starts
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(2);
    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    expect(reviewRound.phase).toBe('review');
    expect(reviewRound.status).toBe('running');

    // Create review output log that would otherwise trigger rework
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({
        verdict: 'needs_changes',
        summary: 'Changes requested',
        issues: [{ severity: 'blocking', description: 'Fix this', files: ['a.ts'] }],
      })
    );

    // Setup mock stopClaude that resolves only after exitPromise fires
    let stopClaudeResolver: () => void;
    const stopClaudePromise = new Promise<boolean>((resolve) => {
      stopClaudeResolver = () => resolve(true);
    });
    vi.spyOn(claudeManager, 'stopClaude').mockImplementationOnce(() => stopClaudePromise);

    // 1. User requests stop
    const stopPromise = orchestrator.stopTodo(todo.id);

    // 2. Child process exits while stopTodo is waiting for stopClaude
    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    // 3. Complete stopClaude
    stopClaudeResolver!();
    await stopPromise;

    // Assert: No rework round created! Todo and round are stopped!
    const allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(allRounds).toHaveLength(2); // Only impl + review, no rework!
    expect(allRounds[1].status).toBe('stopped');

    const stoppedTodo = queries.getTodoById(todo.id)!;
    expect(stoppedTodo.status).toBe('stopped');

    // Resources released
    const available = resourceManager.getStatus().find((s) => s.key === 'unity.editor');
    expect(available?.used).toBe(0);
  });

  it('17. Race 2: stopProject exitPromise race keeps todos and rounds stopped', async () => {
    const todo = queries.createTodo(
      project.id,
      'Stop Project Race Task',
      'Implement feature',
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

    let stopClaudeResolver: () => void;
    const stopClaudePromise = new Promise<boolean>((resolve) => {
      stopClaudeResolver = () => resolve(true);
    });
    vi.spyOn(claudeManager, 'stopClaude').mockImplementationOnce(() => stopClaudePromise);

    const stopProjectPromise = orchestrator.stopProject(project.id);

    // Process exits during stopProject
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    stopClaudeResolver!();
    await stopProjectPromise;

    const allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(allRounds).toHaveLength(1);
    expect(allRounds[0].status).toBe('stopped');

    const stoppedTodo = queries.getTodoById(todo.id)!;
    expect(stoppedTodo.status).toBe('stopped');
  });

  it('18. Race 3: Diff resolves while stopTodo is still pending -> aborts transition with superseded state and prevents resurrection', async () => {
    const todo = queries.createTodo(
      project.id,
      'Async Diff Race Task',
      'Implement feature',
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

    let diffResolver: (val: string) => void;
    const diffBlockedPromise = new Promise<string>((resolve) => {
      diffResolver = resolve;
    });
    mockGitDiff.mockImplementationOnce(() => diffBlockedPromise);

    await orchestrator.startTodo(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;

    // 1. Implementation process exits, triggering advanceRoundOnSuccess which blocks on collectDiffSummary
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 2. Configure stopClaude to return an unresolved promise
    let stopClaudeResolver: () => void;
    const stopClaudePromise = new Promise<boolean>((resolve) => {
      stopClaudeResolver = () => resolve(true);
    });
    vi.spyOn(claudeManager, 'stopClaude').mockImplementationOnce(() => stopClaudePromise);

    // 3. User calls stopTodo() WITHOUT awaiting completion
    const stopPromise = orchestrator.stopTodo(todo.id);

    // 4. Diff resolves WHILE stopClaude is still pending
    diffResolver!('diff --git a/file.ts b/file.ts\n+ new code');
    await new Promise((r) => setTimeout(r, 60));

    // Assert at this point: No review round created, no CLI launched, todo not changed back to pending
    let allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(allRounds).toHaveLength(1);
    expect(mockClaudeStarts).toHaveLength(1);
    expect(queries.getTodoById(todo.id)!.status).not.toBe('pending');

    // 5. Complete stopClaude
    stopClaudeResolver!();
    await stopPromise;

    // Final state: Todo stopped, round stopped, no next round
    allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(allRounds).toHaveLength(1);
    expect(allRounds[0].status).toBe('stopped');
    expect(queries.getTodoById(todo.id)!.status).toBe('stopped');
  });

  it('18b. Race 3b: Rework -> Review diff resolves while stopTodo is pending -> aborts transition with superseded state and prevents resurrection', async () => {
    const todo = queries.createTodo(
      project.id,
      'Rework Stop Race Task',
      'Implement feature',
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

    // 1. Implementation starts and completes
    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    // 2. Review 1 starts and outputs needs_changes -> Rework 1 starts
    expect(mockClaudeStarts).toHaveLength(2);
    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({
        verdict: 'needs_changes',
        summary: 'Fix security flaw',
        issues: [{ severity: 'blocking', description: 'Fix SQL injection', files: ['db.ts'] }],
      })
    );
    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(mockClaudeStarts).toHaveLength(3);
    const reworkRound = queries.getActiveExecutionRound(todo.id)!;
    expect(reworkRound.phase).toBe('rework');
    expect(reworkRound.status).toBe('running');

    // 3. Configure mockGitDiff to block on a promise for Rework -> Review transition
    let diffResolver: (val: string) => void;
    const diffBlockedPromise = new Promise<string>((resolve) => {
      diffResolver = resolve;
    });
    mockGitDiff.mockImplementationOnce(() => diffBlockedPromise);

    // 4. Rework process exits 0, triggering advanceRoundOnSuccess which blocks on collectDiffSummary
    nextExitResolvers[2](0);
    await new Promise((r) => setTimeout(r, 60));

    // 5. Configure stopClaude to return an unresolved promise
    let stopClaudeResolver: () => void;
    const stopClaudePromise = new Promise<boolean>((resolve) => {
      stopClaudeResolver = () => resolve(true);
    });
    vi.spyOn(claudeManager, 'stopClaude').mockImplementationOnce(() => stopClaudePromise);

    // 6. User calls stopTodo() WITHOUT awaiting completion
    const stopPromise = orchestrator.stopTodo(todo.id);

    // 7. Diff resolves WHILE stopClaude is still pending
    diffResolver!('diff --git a/db.ts b/db.ts\n+ fixed code');
    await new Promise((r) => setTimeout(r, 60));

    // Assert before resolving stopClaude:
    // - No Review 2 round created
    // - No additional CLI process launched
    // - Todo was not changed back to pending
    // - Rework round was not marked completed by pipeline
    let allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(allRounds).toHaveLength(3); // Impl (1), Review (2), Rework (3) - no Review (4)!
    expect(mockClaudeStarts).toHaveLength(3);
    expect(queries.getTodoById(todo.id)!.status).not.toBe('pending');
    expect(queries.getExecutionRoundById(reworkRound.id)!.status).not.toBe('completed');

    // 8. Resolve stopClaude
    stopClaudeResolver!();
    await stopPromise;

    // Final state: Todo is stopped, Rework round is stopped, no next round
    allRounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(allRounds).toHaveLength(3);
    expect(allRounds[2].status).toBe('stopped');
    expect(queries.getTodoById(todo.id)!.status).toBe('stopped');
  });

  it('19. Race 4: Periodic stale recovery ignores task during intentional Stop', async () => {
    const todo = queries.createTodo(
      project.id,
      'Stale Stop Task',
      'Implement feature',
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

    await orchestrator.startTodo(todo.id);
    const round = queries.getActiveExecutionRound(todo.id)!;
    expect(round.status).toBe('running');

    // Configure stopClaude to remain pending
    let stopClaudeResolver: () => void;
    const stopClaudePromise = new Promise<boolean>((resolve) => {
      stopClaudeResolver = () => resolve(true);
    });
    vi.spyOn(claudeManager, 'stopClaude').mockImplementationOnce(() => stopClaudePromise);

    // Call stopTodo without awaiting
    const stopPromise = orchestrator.stopTodo(todo.id);

    // Process is no longer alive
    vi.spyOn(orchestrator, 'isProcessAlive').mockReturnValue(false);

    // Stale recovery runs while stop is in-flight
    orchestrator.recoverStaleTasks();

    // Assert: Not marked failed by stale recovery
    const currentTodo = queries.getTodoById(todo.id)!;
    expect(currentTodo.status).not.toBe('failed');

    const currentRound = queries.getExecutionRoundById(round.id)!;
    expect(currentRound.status).not.toBe('failed');
    expect(currentRound.error_message).toBeNull();

    // Now resolve stopClaude
    stopClaudeResolver!();
    await stopPromise;

    // Final state: stopped cleanly by stopTodo
    expect(queries.getTodoById(todo.id)!.status).toBe('stopped');
    expect(queries.getExecutionRoundById(round.id)!.status).toBe('stopped');
    const resStatus = resourceManager.getStatus().find((s) => s.key === 'unity.editor');
    expect(resStatus?.used).toBe(0);
  });

  it('19b. Race 4b: Recovered live Review process later dies during periodic stale recovery', async () => {
    const todo = queries.createTodo(
      project.id,
      'Stale Review Task',
      'Implement feature',
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

    reviewPipeline.ensureInitialRound(todo.id);
    const round = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round.id, { status: 'running' });
    queries.updateTodoStatus(todo.id, 'running');
    queries.updateTodo(todo.id, { process_pid: 88888 });

    resourceManager.acquireAtomic({
      ownerType: 'todo', ownerId: todo.id, runToken: round.run_token, resources: ['unity.editor'],
    });

    // 1. Startup reconciliation: process PID 88888 is reported live
    const isAliveSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    reviewPipeline.reconcileOnStartup();

    expect(queries.getTodoById(todo.id)!.status).toBe('running');
    expect(queries.getExecutionRoundById(round.id)!.status).toBe('running');

    // 2. Later PID dies and periodic stale recovery runs
    isAliveSpy.mockImplementation(() => { throw new Error('ESRCH'); });
    orchestrator.recoverStaleTasks();

    const failedTodo = queries.getTodoById(todo.id)!;
    expect(failedTodo.status).toBe('failed');
    expect(failedTodo.process_pid).toBe(0);

    const failedRound = queries.getExecutionRoundById(round.id)!;
    expect(failedRound.status).toBe('failed');
    expect(failedRound.finished_at).toBeTruthy();
    expect(failedRound.error_message).toContain('Process exited unexpectedly');

    // No active round remains
    expect(queries.getActiveExecutionRound(todo.id)).toBeUndefined();

    // Resource lease released
    const status = resourceManager.getStatus().find((s) => s.key === 'unity.editor');
    expect(status?.used).toBe(0);
  });

  it('20. Race 5: Continue on review_enabled completed Todo is rejected without mutating history', async () => {
    const todo = queries.createTodo(
      project.id,
      'Completed Pipeline Task',
      'Implement feature',
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

    // Complete pipeline
    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](0);
    await new Promise((r) => setTimeout(r, 60));

    queries.createTaskLog(
      todo.id,
      'output',
      JSON.stringify({ verdict: 'approved', summary: 'All good', issues: [] })
    );
    nextExitResolvers[1](0);
    await new Promise((r) => setTimeout(r, 60));

    expect(queries.getTodoById(todo.id)!.status).toBe('completed');
    const roundsBefore = queries.getExecutionRoundsByTodoId(todo.id);
    expect(roundsBefore).toHaveLength(2);

    // Continue call must throw
    await expect(orchestrator.continueTodo(todo.id, 'One more change')).rejects.toThrow(
      'Continue is not supported for reviewed pipeline tasks in Review/Rework V1.'
    );

    // History is completely unchanged
    const roundsAfter = queries.getExecutionRoundsByTodoId(todo.id);
    expect(roundsAfter).toHaveLength(2);
    expect(roundsAfter[1].status).toBe('completed');
    expect(mockClaudeStarts).toHaveLength(2);
  });

  it('21. Failure 6: Manual execution config failure marks Round failed and sets error_message', async () => {
    const todo = queries.createTodo(
      project.id,
      'Config Fail Task',
      'Task',
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
      'unsupported-effort',
      claudeModel.id,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);

    const failedTodo = queries.getTodoById(todo.id)!;
    expect(failedTodo.status).toBe('failed');

    const round = queries.getLatestExecutionRound(todo.id)!;
    expect(round.status).toBe('failed');
    expect(round.error_message).toContain('Configuration error');
    expect(round.finished_at).toBeTruthy();
    expect(queries.getActiveExecutionRound(todo.id)).toBeUndefined();
  });

  it('22. Failure 7: Resource configuration failure marks Round failed and sets error_message', async () => {
    const todo = queries.createTodo(
      project.id,
      'Resource Parse Fail Task',
      'Task',
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
      '{invalid json}',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    await orchestrator.startTodo(todo.id);

    const failedTodo = queries.getTodoById(todo.id)!;
    expect(failedTodo.status).toBe('failed');

    const round = queries.getLatestExecutionRound(todo.id)!;
    expect(round.status).toBe('failed');
    expect(round.error_message).toBeTruthy();
    expect(round.finished_at).toBeTruthy();
    expect(queries.getActiveExecutionRound(todo.id)).toBeUndefined();
  });

  it('23. Wake 8: Server startup wake resumes waiting_executor and waiting_resource pipeline rounds', async () => {
    const todo = queries.createTodo(
      project.id,
      'Waiting Startup Wake Task',
      'Task',
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
    queries.updateExecutionRound(round.id, { status: 'waiting_executor' });
    queries.updateTodoStatus(todo.id, 'waiting_executor');

    // Trigger startup wake
    await orchestrator.wakeWaitingExecutors();
    await new Promise((r) => setTimeout(r, 60));

    const runningRound = queries.getExecutionRoundById(round.id)!;
    expect(runningRound.status).toBe('running');
    expect(queries.getTodoById(todo.id)!.status).toBe('running');
  });

  it('24. Migration 9: Production initDatabase() reconciles legacy duplicate active & index rounds safely and creates unique indexes', () => {
    const migrationDb = new Database(':memory:');
    // Create legacy table structure without unique indexes
    migrationDb.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        status TEXT,
        review_enabled INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS todo_execution_rounds (
        id TEXT PRIMARY KEY,
        todo_id TEXT,
        round_index INTEGER,
        phase TEXT,
        status TEXT,
        run_token TEXT,
        execution_snapshot TEXT,
        input_payload TEXT,
        result_payload TEXT,
        error_message TEXT,
        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME,
        updated_at DATETIME
      );
    `);

    // Insert duplicate active rounds and duplicate round_index rows
    migrationDb.prepare(`
      INSERT INTO todo_execution_rounds (id, todo_id, round_index, phase, status, run_token, created_at)
      VALUES
        ('round-1', 'todo-1', 1, 'implementation', 'running', 'token-1', '2026-08-01T00:00:00.000Z'),
        ('round-2', 'todo-1', 1, 'review', 'running', 'token-2', '2026-08-02T00:00:00.000Z'),
        ('round-3', 'todo-1', 2, 'review', 'running', 'token-3', '2026-08-03T00:00:00.000Z')
    `).run();

    // Call production initDatabase() directly
    expect(() => initDatabase(migrationDb)).not.toThrow();

    // History is preserved (all 3 records still exist)
    const allRounds = migrationDb.prepare('SELECT * FROM todo_execution_rounds WHERE todo_id = ? ORDER BY id').all('todo-1') as any[];
    expect(allRounds).toHaveLength(3);

    // Exactly one active round remains (round-3, the newest)
    const activeRounds = migrationDb.prepare(`
      SELECT * FROM todo_execution_rounds
      WHERE todo_id = ? AND status IN ('pending', 'waiting_executor', 'waiting_quota', 'waiting_resource', 'running')
    `).all('todo-1') as any[];
    expect(activeRounds).toHaveLength(1);
    expect(activeRounds[0].id).toBe('round-3');
    expect(activeRounds[0].status).toBe('running');

    // Older conflicting rounds are failed with diagnostic error metadata
    const failedRounds = migrationDb.prepare(`
      SELECT * FROM todo_execution_rounds
      WHERE todo_id = ? AND status = 'failed'
    `).all('todo-1') as any[];
    expect(failedRounds).toHaveLength(2);
    for (const r of failedRounds) {
      expect(r.error_message).toContain('Superseded legacy');
    }

    // Both unique indexes exist
    const indexes = migrationDb.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todo_execution_rounds'
    `).all() as any[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_todo_execution_rounds_unique_index');
    expect(indexNames).toContain('idx_todo_execution_rounds_active_unique');

    // Subsequent duplicate active round insertion is rejected by unique index
    expect(() => {
      migrationDb.prepare(`
        INSERT INTO todo_execution_rounds (id, todo_id, round_index, phase, status, run_token)
        VALUES ('round-4', 'todo-1', 4, 'rework', 'running', 'token-4')
      `).run();
    }).toThrow();

    // Second call to initDatabase() is idempotent and does not throw
    expect(() => initDatabase(migrationDb)).not.toThrow();

    migrationDb.close();
  });

  it('24b. Migration 9b: initDatabase() throws descriptive error if execution-round unique invariants cannot be established', () => {
    const corruptDb = new Database(':memory:');
    corruptDb.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        status TEXT,
        review_enabled INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS todo_execution_rounds (
        id TEXT PRIMARY KEY,
        todo_id TEXT,
        round_index INTEGER,
        phase TEXT,
        status TEXT,
        run_token TEXT,
        execution_snapshot TEXT,
        input_payload TEXT,
        result_payload TEXT,
        error_message TEXT,
        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME,
        updated_at DATETIME
      );
      INSERT INTO todo_execution_rounds (id, todo_id, round_index, phase, status, run_token)
      VALUES ('r1', 't1', 1, 'review', 'running', 'tok1');
      INSERT INTO todo_execution_rounds (id, todo_id, round_index, phase, status, run_token)
      VALUES ('r2', 't1', 1, 'review', 'running', 'tok2');

      -- Create trigger preventing updates so dedupe throws
      CREATE TRIGGER prevent_updates BEFORE UPDATE ON todo_execution_rounds BEGIN
        SELECT RAISE(FAIL, 'Updates forbidden on this table');
      END;
    `);

    expect(() => initDatabase(corruptDb)).toThrow(/Failed to (enforce|reconcile).*todo execution round/i);
    corruptDb.close();
  });
});
