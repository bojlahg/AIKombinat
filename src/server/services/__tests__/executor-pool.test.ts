import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { executorPool, ExecutorPool, formatCandidateDiagnostics } = await import('../executor-pool.js');
const { orchestrator } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { discussionOrchestrator } = await import('../discussion-orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const cliStatusModule = await import('../cli-status.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');

function createMockCliResult(pid: number, command: string = 'claude', args: string[] = []) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = (code: number) => {
      stdout.end();
      stderr.end();
      resolve(code);
    };
  });
  return {
    pid,
    stdout,
    stderr,
    stdin: null,
    exitPromise,
    resolveExit,
    command,
    args,
  };
}

describe('Executor Pool V1', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace('executor-pool');
    testDb = new Database(':memory:');
    initDatabase(testDb);
    executorPool.resetLimits();
    executorPool.resetReservations();
    cliStatusModule.clearCache();
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    executorPool.resetLimits();
    executorPool.resetReservations();
    cliStatusModule.clearCache();
    testDb.close();
    workspace.cleanup();
  });

  it('1. first candidate available -> selected', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'priority-test',
      name: 'Priority Test',
      description: '',
      executors: [
        { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('selected');
    expect(selection.selectedCandidate?.cli_tool).toBe('claude');
    expect(selection.selectedConfig).toMatchObject({
      cliTool: 'claude',
      model: 'claude-3.7-sonnet',
      effort: { nativeEffort: 'high' },
      source: 'profile',
      profileSlug: 'priority-test',
    });
  });

  it('2. first busy, second available -> second selected', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'fallback-busy',
      name: 'Fallback Busy',
      description: '',
      executors: [
        { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Set Claude limit to 1 and simulate a running Claude task
    executorPool.setLimit('claude', 1);
    executorPool.setLimit('codex', 2);

    const project = queries.createProject('Proj', workspace.resolvePath('proj'));
    const runningTodo = queries.createTodo(project.id, 'Running task', undefined, 0, 'claude');
    queries.updateTodoStatus(runningTodo.id, 'running');
    queries.updateTodo(runningTodo.id, {
      execution_snapshot: JSON.stringify({ agent: 'claude', model: 'claude-3.7-sonnet' }),
    });

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('selected');
    expect(selection.selectedCandidate?.cli_tool).toBe('codex');
    expect(selection.selectedConfig).toMatchObject({
      cliTool: 'codex',
      model: 'gpt-5',
      effort: { nativeEffort: 'medium' },
      source: 'profile',
    });

    // Check evaluations
    const claudeEval = selection.evaluations.find((e) => e.cliTool === 'claude');
    expect(claudeEval).toMatchObject({
      status: 'busy',
      reason: 'provider concurrency limit reached',
    });
    const codexEval = selection.evaluations.find((e) => e.cliTool === 'codex');
    expect(codexEval).toMatchObject({
      status: 'available',
      reason: 'available',
    });
  });

  it('3. missing model skipped', async () => {
    const missingClaude = queries.addModel('claude', 'claude-missing', 'Claude Missing', ['high']);
    testDb.prepare("UPDATE cli_models SET status = 'missing' WHERE id = ?").run(missingClaude.id);

    const availableCodex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'missing-model-test',
      name: 'Missing Model Test',
      description: '',
      executors: [
        { cli_model_id: missingClaude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: availableCodex.id, effort_value: 'medium', priority: 2 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('selected');
    expect(selection.selectedCandidate?.cli_tool).toBe('codex');
    expect(selection.evaluations[0]).toMatchObject({
      status: 'unavailable',
      reason: 'Model "Claude Missing" is missing from CLI discovery',
    });
  });

  it('4. unavailable CLI skipped', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'uninstalled-cli-test',
      name: 'Uninstalled CLI Test',
      description: '',
      executors: [
        { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: tool === 'codex', // Claude uninstalled, Codex installed
      version: tool === 'codex' ? '1.0.0' : null,
    }));

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('selected');
    expect(selection.selectedCandidate?.cli_tool).toBe('codex');
    expect(selection.evaluations[0]).toMatchObject({
      status: 'unavailable',
      reason: 'CLI not installed',
    });
  });

  it('5. all valid candidates busy -> WAITING_EXECUTOR, not failed', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'all-busy-test',
      name: 'All Busy Profile',
      description: '',
      executors: [
        { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Set limits to 0 so both are busy
    executorPool.setLimit('claude', 0);
    executorPool.setLimit('codex', 0);

    const project = queries.createProject('Test Project', workspace.resolvePath('test-project'));
    const todo = queries.createTodo(
      project.id,
      'Execute task with busy profile',
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0, // no worktree
      undefined,
      undefined,
      undefined,
      undefined,
      profile.id,
    );

    await orchestrator.startTodo(todo.id);

    const updatedTodo = queries.getTodoById(todo.id);
    expect(updatedTodo?.status).toBe('waiting_executor');
    expect(updatedTodo?.process_pid).toBe(0);

    // Verify diagnostic logs were created
    const logs = queries.getTaskLogsByTodoId(todo.id);
    const diagnosticLog = logs.find((l) => l.message.includes('[executor-pool] Waiting for executor capacity'));
    expect(diagnosticLog).toBeDefined();
    expect(diagnosticLog?.message).toContain('Claude / Claude 3.7 Sonnet / high:');
    expect(diagnosticLog?.message).toContain('busy - provider concurrency limit reached');
    expect(diagnosticLog?.message).toContain('Codex / GPT-5 / medium:');
    expect(diagnosticLog?.message).toContain('busy - provider concurrency limit reached');
  });

  it('6. no valid candidates -> clear configuration failure', async () => {
    const missingClaude = queries.addModel('claude', 'claude-missing', 'Claude Missing', ['high']);
    testDb.prepare("UPDATE cli_models SET status = 'missing' WHERE id = ?").run(missingClaude.id);

    const codexWithInvalidEffort = queries.addModel('codex', 'gpt-5', 'GPT-5', ['low', 'medium']);
    const profile = queries.createExecutionProfile({
      slug: 'invalid-candidates',
      name: 'Invalid Candidates Profile',
      description: '',
      executors: [
        { cli_model_id: missingClaude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codexWithInvalidEffort.id, effort_value: 'xhigh', priority: 2 }, // unsupported effort
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const project = queries.createProject('Test Project', workspace.resolvePath('test-project-2'));
    const todo = queries.createTodo(
      project.id,
      'Execute task with invalid profile',
      undefined,
      0,
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

    await orchestrator.startTodo(todo.id);

    const updatedTodo = queries.getTodoById(todo.id);
    expect(updatedTodo?.status).toBe('failed');

    const logs = queries.getTaskLogsByTodoId(todo.id);
    const errorLog = logs.find((l) => l.log_type === 'error');
    expect(errorLog?.message).toContain('has no eligible executors');
    expect(errorLog?.message).toContain('Model "Claude Missing" is missing from CLI discovery');
    expect(errorLog?.message).toContain('Effort "xhigh" is not supported by model "GPT-5"');
  });

  it('7. waiting task can run after capacity is released', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'single-slot-profile',
      name: 'Single Slot Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Allow 1 concurrent Claude process
    executorPool.setLimit('claude', 1);

    const { worktreeManager } = await import('../worktree-manager.js');
    vi.spyOn(worktreeManager, 'createWorktree').mockResolvedValue({
      worktreePath: workspace.resolvePath('mock-worktree'),
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Resume Project', workspace.resolvePath('resume-project'), 'main', 1);
    queries.updateProject(project.id, { max_concurrent: 5, use_worktree: 1 });

    // Create Todo 1 (runs first)
    const todo1 = queries.createTodo(project.id, 'Task 1', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);

    // Create Todo 2 (will wait)
    const todo2 = queries.createTodo(project.id, 'Task 2', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);

    const mock1 = createMockCliResult(101, 'claude');
    const mock2 = createMockCliResult(102, 'claude');

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => mock1)
      .mockImplementationOnce(async () => mock2);

    // Start Task 1 -> should run
    await orchestrator.startTodo(todo1.id);
    expect(queries.getTodoById(todo1.id)?.status).toBe('running');
    expect(queries.getTodoById(todo1.id)?.process_pid).toBe(101);

    // Start Task 2 -> capacity is 1, so Task 2 becomes waiting_executor
    await orchestrator.startTodo(todo2.id);
    expect(queries.getTodoById(todo2.id)?.status).toBe('waiting_executor');

    // Now Task 1 finishes successfully -> releases capacity
    mock1.resolveExit(0);
    // Yield event loop so exitPromise resolves and triggers resumeWaitingTasks
    await new Promise((r) => setTimeout(r, 50));

    expect(queries.getTodoById(todo1.id)?.status).toBe('completed');
    // Task 2 should now have been started automatically!
    const refreshedTodo2 = queries.getTodoById(todo2.id);
    expect(refreshedTodo2?.status).toBe('running');
    expect(refreshedTodo2?.process_pid).toBe(102);

    // Cleanup Task 2
    mock2.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('8. deterministic priority order', async () => {
    const m1 = queries.addModel('claude', 'm-1', 'Model 1');
    const m2 = queries.addModel('codex', 'm-2', 'Model 2');
    const m3 = queries.addModel('antigravity', 'm-3', 'Model 3');

    const profile = queries.createExecutionProfile({
      slug: 'deterministic-order',
      name: 'Deterministic Order',
      description: '',
      executors: [
        { cli_model_id: m3.id, effort_value: null, priority: 30 },
        { cli_model_id: m1.id, effort_value: null, priority: 10 },
        { cli_model_id: m2.id, effort_value: null, priority: 20 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const selection1 = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection1.selectedCandidate?.cli_model_id).toBe(m1.id);
    expect(selection1.evaluations.map((e) => e.priority)).toEqual([10, 20, 30]);

    // Make m1 busy -> next in order is m2
    executorPool.setLimit('claude', 0);
    const selection2 = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection2.selectedCandidate?.cli_model_id).toBe(m2.id);
  });

  it('9. manual execution without an Execution Profile keeps existing behavior', async () => {
    const codex = queries.addModel('codex', 'sol', 'Sol', ['medium']);
    const project = queries.createProject('Manual Project', workspace.resolvePath('manual-project'));
    const todo = queries.createTodo(
      project.id,
      'Manual Task',
      undefined,
      0,
      'codex',
      'sol',
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      'medium',
      codex.id,
    );

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 201,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'codex',
      args: [],
    });

    await orchestrator.startTodo(todo.id);

    const runningTodo = queries.getTodoById(todo.id);
    expect(runningTodo?.status).toBe('running');
    expect(runningTodo?.process_pid).toBe(201);
    expect(runningTodo?.execution_snapshot).toBeDefined();

    const snapshot = JSON.parse(runningTodo!.execution_snapshot!);
    expect(snapshot).toMatchObject({
      configuration: 'manual',
      agent: 'codex',
      model: 'sol',
      effort: 'medium',
    });

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('10. Antigravity canonical model + effort resolution remains correct', async () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    const profile = queries.createExecutionProfile({
      slug: 'antigravity-flash',
      name: 'Antigravity Flash',
      description: '',
      executors: [
        { cli_model_id: model.id, effort_value: 'high', priority: 1 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('selected');
    expect(selection.selectedConfig).toMatchObject({
      cliTool: 'antigravity',
      source: 'profile',
      model: 'gemini-3.7-flash',
      effectiveModel: 'gemini-3.7-flash-high',
      effort: {
        nativeEffort: 'high',
        supportedEfforts: ['low', 'medium', 'high'],
        resolution: 'exact',
      },
    });

    const project = queries.createProject('Antigravity Project', workspace.resolvePath('agy-proj'));
    const todo = queries.createTodo(
      project.id,
      'Agy Task',
      undefined,
      0,
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

    let resolveExit: (code: number) => void = () => {};
    const startSpy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 301,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'agy',
      args: [],
    });

    await orchestrator.startTodo(todo.id);

    const runningTodo = queries.getTodoById(todo.id);
    expect(runningTodo?.status).toBe('running');
    const snapshot = JSON.parse(runningTodo!.execution_snapshot!);
    expect(snapshot).toMatchObject({
      configuration: 'profile',
      agent: 'antigravity',
      model: 'gemini-3.7-flash',
      effectiveModel: 'gemini-3.7-flash-high',
      effort: 'high',
    });

    // Verify startClaude was handed the resolved launch selection carrying the
    // frozen provider slug (not a logical model for the adapter to re-resolve)
    expect(startSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { model: 'gemini-3.7-flash', effectiveModel: 'gemini-3.7-flash-high', effort: 'high' },
      undefined,
      'headless',
      'antigravity',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
      undefined,
      undefined,
      'high', // the adapter drops --effort itself when the slug already encodes it
      'implementation',
    );

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('11. atomic reservation prevents concurrent oversubscription with Promise.all', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'single-slot-race',
      name: 'Single Slot Race',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Tool limit is 1
    executorPool.setLimit('claude', 1);

    const { worktreeManager } = await import('../worktree-manager.js');
    vi.spyOn(worktreeManager, 'createWorktree').mockResolvedValue({
      worktreePath: workspace.resolvePath('mock-worktree'),
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Race Project', workspace.resolvePath('race-proj'), 'main', 1);
    queries.updateProject(project.id, { max_concurrent: 5, use_worktree: 1 });

    const t1 = queries.createTodo(project.id, 'Task 1', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);
    const t2 = queries.createTodo(project.id, 'Task 2', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);

    let resolveExit: (code: number) => void = () => {};
    let startCallCount = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      startCallCount++;
      return {
        pid: 400 + startCallCount,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
        command: 'claude',
        args: [],
      };
    });

    // Start both concurrently
    await Promise.all([
      orchestrator.startTodo(t1.id),
      orchestrator.startTodo(t2.id),
    ]);

    const status1 = queries.getTodoById(t1.id)?.status;
    const status2 = queries.getTodoById(t2.id)?.status;

    // Exactly one is running and one is waiting_executor
    const runningCount = (status1 === 'running' ? 1 : 0) + (status2 === 'running' ? 1 : 0);
    const waitingCount = (status1 === 'waiting_executor' ? 1 : 0) + (status2 === 'waiting_executor' ? 1 : 0);

    expect(runningCount).toBe(1);
    expect(waitingCount).toBe(1);
    expect(startCallCount).toBe(1);

    // Clean up
    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('12. reservation released after setup/spawn failure', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'failure-release',
      name: 'Failure Release',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Fail Project', workspace.resolvePath('fail-proj'));
    const t1 = queries.createTodo(project.id, 'Failing Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    const t2 = queries.createTodo(project.id, 'Next Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);

    // Mock startClaude throwing an error on first call, succeeding on second call
    let resolveExit2: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude')
      .mockRejectedValueOnce(new Error('CLI spawn failed'))
      .mockResolvedValueOnce({
        pid: 502,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit2 = resolve; }),
        command: 'claude',
        args: [],
      });

    await orchestrator.startTodo(t1.id);
    expect(queries.getTodoById(t1.id)?.status).toBe('failed');
    // Ensure reservation was released
    expect(executorPool.getReservations().length).toBe(0);

    // Second task can now run immediately without being blocked by a leaked reservation
    await orchestrator.startTodo(t2.id);
    expect(queries.getTodoById(t2.id)?.status).toBe('running');
    expect(queries.getTodoById(t2.id)?.process_pid).toBe(502);

    resolveExit2(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('13. Stop All never launches waiting work & converts waiting tasks to stopped', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'stop-all-test',
      name: 'Stop All Test',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const project = queries.createProject('Stop All Project', workspace.resolvePath('stop-all-proj'));
    const runningTodo = queries.createTodo(project.id, 'Running A', undefined, 0, 'claude');
    queries.updateTodoStatus(runningTodo.id, 'running');
    queries.updateTodo(runningTodo.id, { process_pid: 999 });

    const waitingTodo = queries.createTodo(project.id, 'Waiting B', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    vi.spyOn(claudeManager, 'stopClaude').mockResolvedValue(true);

    await orchestrator.stopProject(project.id);

    // Both should be stopped, and waiting task must NOT have become running
    expect(queries.getTodoById(runningTodo.id)?.status).toBe('stopped');
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('stopped');
  });

  it('14. cross-project capacity release wakes waiting task', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'cross-project-profile',
      name: 'Cross Project Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Provider limit is 1
    executorPool.setLimit('claude', 1);

    const projectA = queries.createProject('Project A', workspace.resolvePath('proj-a'));
    const projectB = queries.createProject('Project B', workspace.resolvePath('proj-b'));

    const todoA = queries.createTodo(projectA.id, 'Task A', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    const todoB = queries.createTodo(projectB.id, 'Task B', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);

    const mockA = createMockCliResult(601, 'claude');
    const mockB = createMockCliResult(602, 'claude');

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => mockA)
      .mockImplementationOnce(async () => mockB);

    // Start Task A in Project A -> starts
    await orchestrator.startTodo(todoA.id);
    expect(queries.getTodoById(todoA.id)?.status).toBe('running');

    // Start Task B in Project B -> enters waiting_executor because capacity (1) is occupied
    await orchestrator.startTodo(todoB.id);
    expect(queries.getTodoById(todoB.id)?.status).toBe('waiting_executor');

    // Task A completes in Project A -> releases global Claude capacity
    mockA.resolveExit(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(queries.getTodoById(todoA.id)?.status).toBe('completed');
    // Task B in Project B is automatically woken and started!
    expect(queries.getTodoById(todoB.id)?.status).toBe('running');
    expect(queries.getTodoById(todoB.id)?.process_pid).toBe(602);

    mockB.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('15. profile-based Discussion counts actual selected provider', async () => {
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'discussion-codex',
      name: 'Discussion Codex Profile',
      description: '',
      executors: [{ cli_model_id: codex.id, effort_value: 'medium', priority: 1 }],
    });

    // Project default is Claude
    const project = queries.createProject('Disc Project', workspace.resolvePath('disc-proj'), 'main', 0, 'claude');

    // Discussion agent uses the profile (cli_tool is null)
    const agent = queries.createDiscussionAgent(
      project.id,
      'Codex Agent',
      'Engineer',
      'System prompt',
      undefined,
      undefined,
      undefined,
      false,
      profile.id,
    );

    const discussion = queries.createDiscussion(
      project.id,
      'Active Discussion',
      'Description',
      [agent.id],
    );

    // Set discussion running with current_agent_id and frozen execution_snapshot
    queries.updateDiscussionStatus(discussion.id, 'running');
    queries.updateDiscussion(discussion.id, {
      current_agent_id: agent.id,
      execution_snapshot: JSON.stringify({ agent: 'codex', model: 'gpt-5' }),
    });

    // Verify accounting: Codex capacity is 1, Claude capacity is 0
    expect(executorPool.getActiveToolUsage('codex')).toBe(1);
    expect(executorPool.getActiveToolUsage('claude')).toBe(0);
  });

  it('16. persisted WAITING_EXECUTOR is safely reevaluated after startup/recovery', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'recovery-wake',
      name: 'Recovery Wake',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const project = queries.createProject('Recovery Project', workspace.resolvePath('recovery-proj'));
    const waitingTodo = queries.createTodo(project.id, 'Persisted Waiting', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 701,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    // Wake all waiting executors on startup
    await orchestrator.wakeWaitingExecutors();

    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');
    expect(queries.getTodoById(waitingTodo.id)?.process_pid).toBe(701);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('17. repeated unchanged reevaluation does not spam identical logs', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'no-spam-profile',
      name: 'No Spam Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Claude is busy (limit = 0)
    executorPool.setLimit('claude', 0);

    const project = queries.createProject('Spam Project', workspace.resolvePath('spam-proj'));
    const todo = queries.createTodo(project.id, 'Waiting Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);

    // Start task -> becomes waiting_executor, logs initial diagnostic
    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('waiting_executor');

    const logsAfterFirstStart = queries.getTaskLogsByTodoId(todo.id).filter((l) => l.message.includes('[executor-pool] Waiting for executor capacity'));
    expect(logsAfterFirstStart.length).toBe(1);

    // Repeated wakes occur (e.g. 5 other tasks finish, but Claude is still limit=0)
    await orchestrator.wakeWaitingExecutors();
    await orchestrator.wakeWaitingExecutors();
    await orchestrator.wakeWaitingExecutors();

    // Verify logs were NOT duplicated
    const logsAfterWakes = queries.getTaskLogsByTodoId(todo.id).filter((l) => l.message.includes('[executor-pool] Waiting for executor capacity'));
    expect(logsAfterWakes.length).toBe(1);
  });

  it('18. simultaneous capacity release/wake does not launch the same todo twice', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'wake-concurrency-profile',
      name: 'Wake Concurrency Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const project = queries.createProject('Double Wake Project', workspace.resolvePath('double-wake-proj'));
    const waitingTodo = queries.createTodo(project.id, 'Double Wake Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    let resolveExit: (code: number) => void = () => {};
    let launchCount = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      launchCount++;
      return {
        pid: 800 + launchCount,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
        command: 'claude',
        args: [],
      };
    });

    // Fire 5 concurrent wake calls simultaneously
    await Promise.all([
      orchestrator.wakeWaitingExecutors(),
      orchestrator.wakeWaitingExecutors(),
      orchestrator.wakeWaitingExecutors(),
      orchestrator.wakeWaitingExecutors(),
      orchestrator.wakeWaitingExecutors(),
    ]);

    expect(launchCount).toBe(1);
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('formats human-readable diagnostics matching roadmap examples', () => {
    const diagnostics = formatCandidateDiagnostics([
      {
        candidateId: '1',
        cliTool: 'claude',
        toolName: 'Claude',
        model: 'fable-5',
        modelLabel: 'Fable 5',
        effort: 'high',
        priority: 1,
        status: 'busy',
        reason: 'provider concurrency limit reached',
      },
      {
        candidateId: '2',
        cliTool: 'codex',
        toolName: 'Codex',
        model: 'gpt-5.6',
        modelLabel: 'GPT-5.6',
        effort: 'xhigh',
        priority: 2,
        status: 'unavailable',
        reason: 'CLI not installed',
      },
      {
        candidateId: '3',
        cliTool: 'antigravity',
        toolName: 'Antigravity',
        model: 'gemini-3.7-flash',
        modelLabel: 'Gemini 3.7 Flash',
        effort: 'high',
        priority: 3,
        status: 'available',
        reason: 'available',
      },
    ]);

    expect(diagnostics).toBe(
      'Claude / Fable 5 / high:\n  busy - provider concurrency limit reached\n\n' +
      'Codex / GPT-5.6 / xhigh:\n  unavailable - CLI not installed\n\n' +
      'Antigravity / Gemini 3.7 Flash / high:\n  available - available'
    );
  });

  it('19. reservation is not counted together with the same running todo (limit=2 allows second todo)', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'two-slots-profile',
      name: 'Two Slots Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Limit is 2
    executorPool.setLimit('claude', 2);

    const { worktreeManager } = await import('../worktree-manager.js');
    vi.spyOn(worktreeManager, 'createWorktree').mockResolvedValue({
      worktreePath: workspace.resolvePath('mock-worktree'),
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Two Slot Project', workspace.resolvePath('two-slot-proj'), 'main', 1);
    queries.updateProject(project.id, { max_concurrent: 5, use_worktree: 1 });
    const t1 = queries.createTodo(project.id, 'Task 1', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);
    const t2 = queries.createTodo(project.id, 'Task 2', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);

    let resolveExit1: (code: number) => void = () => {};
    let resolveExit2: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 901,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit1 = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 902,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit2 = resolve; }),
        command: 'claude',
        args: [],
      }));

    // Start Task 1
    await orchestrator.startTodo(t1.id);
    expect(queries.getTodoById(t1.id)?.status).toBe('running');
    // Ensure reservation was released synchronously when transitioning to running
    expect(executorPool.getReservations().length).toBe(0);
    // Active usage is exactly 1 (not 2)
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    // Start Task 2 -> starts immediately because capacity is 1/2
    await orchestrator.startTodo(t2.id);
    expect(queries.getTodoById(t2.id)?.status).toBe('running');
    expect(executorPool.getActiveToolUsage('claude')).toBe(2);

    resolveExit1(0);
    resolveExit2(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('20. spawn failure wakes an already WAITING_EXECUTOR task automatically', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'wake-on-spawn-fail',
      name: 'Wake On Spawn Fail',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Limit is 1
    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Spawn Fail Project', workspace.resolvePath('spawn-fail-proj'));
    const t1 = queries.createTodo(project.id, 'Task 1 (Failing)', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    const t2 = queries.createTodo(project.id, 'Task 2 (Waiting)', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);

    // Mark t2 as waiting_executor
    queries.updateTodoStatus(t2.id, 'waiting_executor');

    let resolveExit2: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockRejectedValueOnce(new Error('Spawn error'))
      .mockResolvedValueOnce({
        pid: 950,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit2 = resolve; }),
        command: 'claude',
        args: [],
      });

    // Start Task 1 -> fails during spawn, which should wake Task 2
    await orchestrator.startTodo(t1.id);
    expect(queries.getTodoById(t1.id)?.status).toBe('failed');

    // Give microtask/event-loop a chance to process the coalesced wake
    await new Promise((r) => setTimeout(r, 50));

    // Task 2 should now be running
    expect(queries.getTodoById(t2.id)?.status).toBe('running');
    expect(queries.getTodoById(t2.id)?.process_pid).toBe(950);

    resolveExit2(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('21. interactive Session enforces provider limit and wakes waiting tasks on exit', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'session-capacity-profile',
      name: 'Session Capacity Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Limit is 1
    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Session Project', workspace.resolvePath('session-proj'));
    const waitingTodo = queries.createTodo(project.id, 'Waiting Todo', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    const session = queries.createSession(project.id, 'Interactive Session', 'Desc', 'claude');

    let resolveSessionExit: (code: number) => void = () => {};
    let resolveTodoExit: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 1001,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveSessionExit = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 1002,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveTodoExit = resolve; }),
        command: 'claude',
        args: [],
      }));

    // Start session -> occupies Claude slot (1/1)
    await sessionManager.startSession(session.id);
    expect(queries.getSessionById(session.id)?.status).toBe('running');
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    // Attempting to start another Claude session fails with human-readable error
    const session2 = queries.createSession(project.id, 'Second Session', 'Desc', 'claude');
    await expect(sessionManager.startSession(session2.id)).rejects.toThrow(
      /Provider concurrency limit reached for Claude/,
    );

    // Session exits -> frees Claude capacity and wakes waitingTodo
    resolveSessionExit(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(queries.getSessionById(session.id)?.status).toBe('completed');
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');
    expect(queries.getTodoById(waitingTodo.id)?.process_pid).toBe(1002);

    resolveTodoExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('22. Discussion turn enforces provider limit, pauses when busy, and wakes waiting tasks on exit', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'disc-capacity-profile',
      name: 'Discussion Capacity Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Limit is 1
    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Discussion Project', workspace.resolvePath('disc-proj'), 'main', 0, 'claude');
    const waitingTodo = queries.createTodo(project.id, 'Waiting Todo', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    const agent1 = queries.createDiscussionAgent(project.id, 'Agent 1', 'Role', 'Prompt', undefined, undefined, undefined, false, profile.id);
    const agent2 = queries.createDiscussionAgent(project.id, 'Agent 2', 'Role', 'Prompt', 'codex', undefined, undefined, false);

    const discussion = queries.createDiscussion(project.id, 'Disc 1', 'Desc', [agent1.id, agent2.id], 1, false, undefined, 'none', null, null, 0);

    let resolveDiscExit1: (code: number) => void = () => {};
    let resolveDiscExit2: (code: number) => void = () => {};
    let resolveTodoExit: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 1101,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveDiscExit1 = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 1102,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveDiscExit2 = resolve; }),
        command: 'codex',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 1103,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveTodoExit = resolve; }),
        command: 'claude',
        args: [],
      }));

    // Start discussion turn 1 (Agent 1 on Claude)
    await discussionOrchestrator.startDiscussion(discussion.id);
    expect(queries.getDiscussionById(discussion.id)?.status).toBe('running');
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    // Another discussion attempting to start Claude when busy will pause cleanly
    const discussion2 = queries.createDiscussion(project.id, 'Disc 2', 'Desc', [agent1.id, agent2.id], 1, false, undefined, 'none', null, null, 0);
    await discussionOrchestrator.startDiscussion(discussion2.id);
    expect(queries.getDiscussionById(discussion2.id)?.status).toBe('paused');

    // Agent 1 completes -> advances to Agent 2 (Codex), releasing Claude capacity
    resolveDiscExit1(0);
    await new Promise((r) => setTimeout(r, 50));

    // Waiting todo is woken up automatically and uses Claude
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');
    expect(queries.getTodoById(waitingTodo.id)?.process_pid).toBe(1103);

    resolveTodoExit(0);
    resolveDiscExit2(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('23. Discussion with multi-candidate profile selects Codex when Claude busy and freezes snapshot', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'multi-profile-disc',
      name: 'Multi Profile Disc',
      description: '',
      executors: [
        { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Claude limit = 1, Codex limit = 2
    executorPool.setLimit('claude', 1);
    executorPool.setLimit('codex', 2);

    const project = queries.createProject('Multi Disc Project', workspace.resolvePath('multi-disc'), 'main', 0, 'claude');

    // Simulate an active Claude todo consuming Claude's only slot
    const activeTodo = queries.createTodo(project.id, 'Claude Task', undefined, 0, 'claude');
    queries.updateTodoStatus(activeTodo.id, 'running');
    queries.updateTodo(activeTodo.id, { execution_snapshot: JSON.stringify({ agent: 'claude' }) });

    const agent1 = queries.createDiscussionAgent(project.id, 'Agent 1', 'Role', 'Prompt', undefined, undefined, undefined, false, profile.id);
    const agent2 = queries.createDiscussionAgent(project.id, 'Agent 2', 'Role', 'Prompt', undefined, undefined, undefined, false, profile.id);

    const discussion = queries.createDiscussion(project.id, 'Disc Multi', 'Desc', [agent1.id, agent2.id], 2, false, undefined, 'none', null, null, 0);

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1201,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'codex',
      args: [],
    });

    await discussionOrchestrator.startDiscussion(discussion.id);

    const runningDisc = queries.getDiscussionById(discussion.id);
    expect(runningDisc?.status).toBe('running');
    // Frozen execution_snapshot was persisted
    expect(runningDisc?.execution_snapshot).toBeDefined();
    const snap = JSON.parse(runningDisc!.execution_snapshot!);
    expect(snap.agent).toBe('codex');

    // Accounting check: Codex is 1, Claude is 1 (from the active todo, NOT from discussion)
    expect(executorPool.getActiveToolUsage('codex')).toBe(1);
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('24. wake coalescing guarantees second pass when capacity freed during active wake', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'coalesce-profile',
      name: 'Coalesce Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    let resolveExit: (code: number) => void = () => {};
    const startSpy = vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => ({
      pid: 2401,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    }));

    const project = queries.createProject('Coalesce Project', workspace.resolvePath('coalesce-proj'));
    const waitingTodo = queries.createTodo(project.id, 'Waiting Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    // Start with Claude limit = 0 (so first pass sees it busy)
    executorPool.setLimit('claude', 0);

    // Start a wake pass while limit is 0 -> finishes with todo still waiting_executor
    const wakePromise = orchestrator.wakeWaitingExecutors();

    // Capacity is freed concurrently while wake pass is executing!
    executorPool.setLimit('claude', 1);
    // Second wake requested while wakePromise is still in flight
    const secondWakePromise = orchestrator.wakeWaitingExecutors();

    await Promise.all([wakePromise, secondWakePromise]);

    // Waiter was reevaluated and launched in the coalesced pass!
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');
    expect(startSpy).toHaveBeenCalledTimes(1);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('25. failed reservation after candidate evaluation does not return selected', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'failed-reserve-profile',
      name: 'Failed Reserve Profile',
      description: '',
      executors: [
        { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
      ],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Mock reserveSlot: fails for claude, succeeds for codex
    vi.spyOn(executorPool, 'reserveSlot').mockImplementation((ownerId, tool) => {
      if (tool === 'claude') return false; // simulated race where slot was snatched
      return true;
    });

    const selection = await executorPool.selectExecutor({
      executionProfileId: profile.id,
      reserveOwnerId: 'todo-123',
    });

    // Should fall back to second candidate (codex) because reservation failed for claude
    expect(selection.status).toBe('selected');
    expect(selection.selectedCandidate?.cli_tool).toBe('codex');
    expect(selection.selectedConfig?.cliTool).toBe('codex');
  });

  it('26. manual Todo respects provider limit, becomes WAITING_EXECUTOR when full, and starts after capacity released', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Limit Claude = 1
    executorPool.setLimit('claude', 1);

    const { worktreeManager } = await import('../worktree-manager.js');
    vi.spyOn(worktreeManager, 'createWorktree').mockResolvedValue({
      worktreePath: workspace.resolvePath('mock-worktree'),
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Manual Todo Project', workspace.resolvePath('manual-proj'), 'main', 1);
    queries.updateProject(project.id, { max_concurrent: 5, use_worktree: 1 });

    const t1 = queries.createTodo(project.id, 'Task 1', undefined, 0, 'claude', undefined, undefined, undefined, undefined, 1);
    const t2 = queries.createTodo(project.id, 'Task 2', undefined, 0, 'claude', undefined, undefined, undefined, undefined, 1);

    const mock1 = createMockCliResult(1301, 'claude');
    const mock2 = createMockCliResult(1302, 'claude');

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => mock1)
      .mockImplementationOnce(async () => mock2);

    // Start Task 1 -> starts normally
    await orchestrator.startTodo(t1.id);
    expect(queries.getTodoById(t1.id)?.status).toBe('running');
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    // Start Task 2 (manual) -> provider capacity is full (1/1), so enters WAITING_EXECUTOR
    await orchestrator.startTodo(t2.id);
    expect(queries.getTodoById(t2.id)?.status).toBe('waiting_executor');
    const logs = queries.getTaskLogsByTodoId(t2.id);
    expect(logs.some((l) => l.message.includes('[executor-pool] Waiting for executor capacity (manual Claude CLI)'))).toBe(true);

    // Task 1 completes -> releases capacity and wakes Task 2
    mock1.resolveExit(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(queries.getTodoById(t1.id)?.status).toBe('completed');
    expect(queries.getTodoById(t2.id)?.status).toBe('running');
    expect(queries.getTodoById(t2.id)?.process_pid).toBe(1302);
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    mock2.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('27. concurrent manual Todo starts cannot oversubscribe provider limit', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Limit Claude = 1
    executorPool.setLimit('claude', 1);

    const { worktreeManager } = await import('../worktree-manager.js');
    vi.spyOn(worktreeManager, 'createWorktree').mockResolvedValue({
      worktreePath: workspace.resolvePath('mock-worktree'),
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Race Manual Project', workspace.resolvePath('race-manual-proj'), 'main', 1);
    queries.updateProject(project.id, { max_concurrent: 5, use_worktree: 1 });

    const t1 = queries.createTodo(project.id, 'Task A', undefined, 0, 'claude', undefined, undefined, undefined, undefined, 1);
    const t2 = queries.createTodo(project.id, 'Task B', undefined, 0, 'claude', undefined, undefined, undefined, undefined, 1);

    let resolveExit: (code: number) => void = () => {};
    let launchCount = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      launchCount++;
      return {
        pid: 1400 + launchCount,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
        command: 'claude',
        args: [],
      };
    });

    // Concurrently start both manual todos
    await Promise.all([
      orchestrator.startTodo(t1.id),
      orchestrator.startTodo(t2.id),
    ]);

    const s1 = queries.getTodoById(t1.id)?.status;
    const s2 = queries.getTodoById(t2.id)?.status;

    // Exactly one is running and one is waiting_executor
    expect((s1 === 'running' ? 1 : 0) + (s2 === 'running' ? 1 : 0)).toBe(1);
    expect((s1 === 'waiting_executor' ? 1 : 0) + (s2 === 'waiting_executor' ? 1 : 0)).toBe(1);
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    expect(launchCount).toBe(1);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('28. concurrent manual Session starts: exactly one starts and other fails cleanly with provider busy', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Limit Claude = 1
    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Session Race Project', workspace.resolvePath('session-race-proj'));
    const s1 = queries.createSession(project.id, 'Session 1', 'Desc', 'claude');
    const s2 = queries.createSession(project.id, 'Session 2', 'Desc', 'claude');

    let resolveExit: (code: number) => void = () => {};
    let spawnCount = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      spawnCount++;
      return {
        pid: 1500 + spawnCount,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
        command: 'claude',
        args: [],
      };
    });

    const results = await Promise.allSettled([
      sessionManager.startSession(s1.id),
      sessionManager.startSession(s2.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/Provider concurrency limit reached for Claude/);
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    expect(executorPool.getReservations().length).toBe(0);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('29. profile Session reservation is cleanly released on validation failure before running', async () => {
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'codex-only-profile',
      name: 'Codex Only Profile',
      description: '',
      executors: [{ cli_model_id: codex.id, effort_value: 'medium', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Codex limit = 1
    executorPool.setLimit('codex', 1);

    const project = queries.createProject('Validation Project', workspace.resolvePath('val-proj'), 'main', 1);
    const session1 = queries.createSession(project.id, 'Session 1', 'Desc', undefined, undefined, true, undefined, undefined, undefined, undefined, profile.id);
    queries.updateSession(session1.id, { worktree_path: workspace.resolvePath('mock-worktree') });

    // Attempting to continue/resume with non-Claude profile fails validation
    await expect(
      sessionManager.startSession(session1.id, { continueSession: true })
    ).rejects.toThrow(/Resume is only supported for Claude sessions/);

    // Verify reservation was NOT leaked
    expect(executorPool.getReservations().length).toBe(0);
    expect(executorPool.getActiveToolUsage('codex')).toBe(0);

    // A subsequent session can now acquire the 1/1 slot without being blocked
    const session2 = queries.createSession(project.id, 'Session 2', 'Desc', undefined, undefined, false, undefined, undefined, undefined, undefined, profile.id);

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1601,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'codex',
      args: [],
    });

    await sessionManager.startSession(session2.id);
    expect(queries.getSessionById(session2.id)?.status).toBe('running');
    expect(executorPool.getActiveToolUsage('codex')).toBe(1);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('30. Discussion completed turn immediately clears provider identity and wakes WAITING_EXECUTOR todo before next turn', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'claude-profile',
      name: 'Claude Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Claude limit = 1
    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Disc Release Project', workspace.resolvePath('disc-rel-proj'), 'main', 0, 'claude');
    const waitingTodo = queries.createTodo(project.id, 'Waiting Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    const agent1 = queries.createDiscussionAgent(project.id, 'Agent 1', 'Role', 'Prompt', undefined, undefined, undefined, false, profile.id);
    const agent2 = queries.createDiscussionAgent(project.id, 'Agent 2', 'Role', 'Prompt', undefined, undefined, undefined, false, profile.id);

    const discussion = queries.createDiscussion(project.id, 'Disc Rel', 'Desc', [agent1.id, agent2.id], 1, false, undefined, 'none', null, null, 0);

    let resolveTurn1: (code: number) => void = () => {};
    let resolveTodoExit: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 1701,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveTurn1 = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 1702,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveTodoExit = resolve; }),
        command: 'claude',
        args: [],
      }));

    // Start discussion turn 1
    await discussionOrchestrator.startDiscussion(discussion.id);
    expect(queries.getDiscussionById(discussion.id)?.status).toBe('running');
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    // Turn 1 finishes: immediately releases Claude capacity and wakes waitingTodo
    resolveTurn1(0);
    await new Promise((r) => setTimeout(r, 50));

    // Waiting todo is now running on Claude (1/1 slot occupied by todo)
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');
    expect(queries.getTodoById(waitingTodo.id)?.process_pid).toBe(1702);

    // Discussion turn 2 paused cleanly because Claude is busy with the todo
    expect(queries.getDiscussionById(discussion.id)?.status).toBe('paused');

    resolveTodoExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('31. Discussion next turn independently selects next provider and does not leak old provider identity', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profileClaude = queries.createExecutionProfile({
      slug: 'prof-claude',
      name: 'Prof Claude',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });
    const profileCodex = queries.createExecutionProfile({
      slug: 'prof-codex',
      name: 'Prof Codex',
      description: '',
      executors: [{ cli_model_id: codex.id, effort_value: 'medium', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const project = queries.createProject('Multi Turn Project', workspace.resolvePath('multi-turn'), 'main', 0, 'claude');
    const agent1 = queries.createDiscussionAgent(project.id, 'Agent 1', 'Role', 'Prompt', undefined, undefined, undefined, false, profileClaude.id);
    const agent2 = queries.createDiscussionAgent(project.id, 'Agent 2', 'Role', 'Prompt', undefined, undefined, undefined, false, profileCodex.id);

    const discussion = queries.createDiscussion(project.id, 'Disc Multi Turn', 'Desc', [agent1.id, agent2.id], 1, false, undefined, 'none', null, null, 0);

    let resolveTurn1: (code: number) => void = () => {};
    let resolveTurn2: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 1801,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveTurn1 = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 1802,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveTurn2 = resolve; }),
        command: 'codex',
        args: [],
      }));

    // Start turn 1 (Claude)
    await discussionOrchestrator.startDiscussion(discussion.id);
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    expect(executorPool.getActiveToolUsage('codex')).toBe(0);

    // Finish turn 1 -> automatically advances to turn 2 (Codex)
    resolveTurn1(0);
    await new Promise((r) => setTimeout(r, 50));

    // Turn 2 is running with Codex: Claude capacity is 0, Codex capacity is 1
    expect(executorPool.getActiveToolUsage('claude')).toBe(0);
    expect(executorPool.getActiveToolUsage('codex')).toBe(1);

    const runningDisc = queries.getDiscussionById(discussion.id);
    expect(runningDisc?.execution_snapshot).toBeDefined();
    const snap = JSON.parse(runningDisc!.execution_snapshot!);
    expect(snap.agent).toBe('codex');

    resolveTurn2(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('32. session pre-spawn failure (e.g. memory injection error) marks session failed, clears snapshot, and wakes waiting tasks', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'claude-session-fail',
      name: 'Claude Session Fail',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Claude limit = 1
    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Session Fail Project', workspace.resolvePath('sess-fail'), 'main', 0, 'claude');
    const waitingTodo = queries.createTodo(project.id, 'Waiting Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    const memoryInjectHook = await import('../memory-inject-hook.js');
    vi.spyOn(memoryInjectHook, 'applyMemoryInjection').mockRejectedValue(new Error('Memory store corrupted'));

    const session = queries.createSession(project.id, 'Session With Mem', 'Desc', undefined, undefined, false, 'all', undefined, undefined, undefined, profile.id);

    let resolveTodoExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => ({
      pid: 2001,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveTodoExit = resolve; }),
      command: 'claude',
      args: [],
    }));

    await expect(sessionManager.startSession(session.id)).rejects.toThrow('Memory store corrupted');

    const failedSession = queries.getSessionById(session.id);
    expect(failedSession?.status).toBe('failed');
    expect(failedSession?.execution_snapshot).toBeNull();
    expect(failedSession?.process_pid).toBe(0);

    // Waiting todo woke up and started running
    await new Promise((r) => setTimeout(r, 50));
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    resolveTodoExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('33. user terminal input arriving during memory injection with pending initial prompt is not written to PTY before Send/Skip', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const project = queries.createProject('Prompt Gate Project', workspace.resolvePath('prompt-gate'), 'main', 0, 'claude');
    const session = queries.createSession(project.id, 'Session Review', 'Initial description to review', 'claude');

    let resolveMem: (value: string) => void = () => {};
    const memoryInjectHook = await import('../memory-inject-hook.js');
    vi.spyOn(memoryInjectHook, 'applyMemoryInjection').mockImplementation(
      () => new Promise((resolve) => { resolveMem = resolve; })
    );
    queries.updateSession(session.id, { memory_inject_mode: 'all' });

    const writtenToPty: string[] = [];
    vi.spyOn(claudeManager, 'writeStdinRaw').mockImplementation((pid, input) => {
      writtenToPty.push(input);
      return true;
    });
    vi.spyOn(claudeManager, 'writeToStdin').mockReturnValue(true);

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 2101,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    // Start session (async memory injection begins)
    const startPromise = sessionManager.startSession(session.id);

    // User types while memory injection is pending
    expect(sessionManager.hasPendingPrompt(session.id)).toBe(true);
    sessionManager.writeTerminalInput(session.id, 'accidental-typeahead-1\n');

    // Complete memory injection
    resolveMem('<long_term_memory>wiki block</long_term_memory>');
    await startPromise;

    // After spawn, session is running and holds the initial prompt
    expect(sessionManager.hasPendingPrompt(session.id)).toBe(true);
    // Keystrokes typed during startup were NOT written to PTY
    expect(writtenToPty).toEqual([]);

    // User reviews and submits the held prompt
    sessionManager.submitInitialPrompt(session.id);
    expect(sessionManager.hasPendingPrompt(session.id)).toBe(false);

    // Now subsequent typing goes to PTY
    sessionManager.writeTerminalInput(session.id, 'user-approved-command\n');
    expect(writtenToPty).toContain('user-approved-command\n');

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('34. normal no-prompt session captures startup type-ahead and drains to PTY upon spawn', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    const project = queries.createProject('No Prompt Project', workspace.resolvePath('no-prompt'), 'main', 0, 'claude');
    // Session with NO description and NO memory injection
    const session = queries.createSession(project.id, 'Interactive Shell', '', 'claude');

    const writtenToPty: string[] = [];
    vi.spyOn(claudeManager, 'writeStdinRaw').mockImplementation((pid, input) => {
      writtenToPty.push(input);
      return true;
    });

    let resolveSpawn: (res: any) => void = () => {};
    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(
      () => new Promise((resolve) => {
        resolveSpawn = () => resolve({
          pid: 2201,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          stdin: null,
          exitPromise: new Promise<number>((r) => { resolveExit = r; }),
          command: 'claude',
          args: [],
        });
      })
    );

    const startPromise = sessionManager.startSession(session.id);

    // Prompt gate is false
    expect(sessionManager.hasPendingPrompt(session.id)).toBe(false);

    // Type-ahead while spawning
    sessionManager.writeTerminalInput(session.id, 'ls -la\n');
    sessionManager.writeTerminalInput(session.id, 'pwd\n');

    // Spawn completes
    resolveSpawn(null);
    await startPromise;

    // Both buffered inputs were drained directly into PTY
    expect(writtenToPty).toEqual(['ls -la\n', 'pwd\n']);

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('35. stale process recovery marks dead running todo as failed and automatically wakes WAITING_EXECUTOR todo', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'stale-prof',
      name: 'Stale Prof',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    // Claude limit = 1
    executorPool.setLimit('claude', 1);

    const project = queries.createProject('Stale Project', workspace.resolvePath('stale-proj'), 'main', 0, 'claude');
    const taskA = queries.createTodo(project.id, 'Task A (Stale)', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(taskA.id, 'running');
    queries.updateTodo(taskA.id, { process_pid: 999999, execution_snapshot: JSON.stringify({ agent: 'claude' }) });

    const taskB = queries.createTodo(project.id, 'Task B (Waiting)', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(taskB.id, 'waiting_executor');

    // Dead process check
    vi.spyOn(orchestrator as any, 'isProcessAlive').mockReturnValue(false);

    let resolveExitB: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 2301,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExitB = resolve; }),
      command: 'claude',
      args: [],
    });

    // Run stale process check
    (orchestrator as any).recoverStaleTasks();

    // Task A marked failed, snapshot cleared
    const updatedA = queries.getTodoById(taskA.id);
    expect(updatedA?.status).toBe('failed');
    expect(updatedA?.process_pid).toBe(0);
    expect(updatedA?.execution_snapshot).toBeNull();

    // Task B automatically woke and started running
    await new Promise((r) => setTimeout(r, 50));
    const updatedB = queries.getTodoById(taskB.id);
    expect(updatedB?.status).toBe('running');
    expect(updatedB?.process_pid).toBe(2301);

    resolveExitB(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('36. configurable provider concurrency limits respect env vars, overrides, and fallbacks', () => {
    const pool = new ExecutorPool();

    // Default values
    expect(pool.getLimit('claude')).toBe(2);
    expect(pool.getLimit('codex')).toBe(2);
    expect(pool.getLimit('antigravity')).toBe(2);
    expect(pool.getLimit('raw-shell')).toBe(10);

    // 1. Valid env override
    process.env.EXECUTOR_LIMIT_CLAUDE = '4';
    expect(pool.getLimit('claude')).toBe(4);

    // 2. Zero env limit
    process.env.EXECUTOR_LIMIT_CODEX = '0';
    expect(pool.getLimit('codex')).toBe(0);

    // 3. Invalid env fallbacks
    process.env.EXECUTOR_LIMIT_ANTIGRAVITY = 'invalid';
    expect(pool.getLimit('antigravity')).toBe(2);
    process.env.EXECUTOR_LIMIT_ANTIGRAVITY = '-5';
    expect(pool.getLimit('antigravity')).toBe(2);

    // 4. setLimit overrides env
    pool.setLimit('claude', 1);
    expect(pool.getLimit('claude')).toBe(1);

    // 5. resetLimits restores env/default behavior
    pool.resetLimits();
    expect(pool.getLimit('claude')).toBe(4); // Back to env value

    // Clean up env vars
    delete process.env.EXECUTOR_LIMIT_CLAUDE;
    delete process.env.EXECUTOR_LIMIT_CODEX;
    delete process.env.EXECUTOR_LIMIT_ANTIGRAVITY;

    expect(pool.getLimit('claude')).toBe(2);
  });
});

