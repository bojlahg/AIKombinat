import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';

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

describe('Executor Pool V1', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
    executorPool.resetLimits();
    cliStatusModule.clearCache();
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    executorPool.resetLimits();
    cliStatusModule.clearCache();
    testDb.close();
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

    const project = queries.createProject('Proj', 'C:/proj');
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

    const project = queries.createProject('Test Project', 'C:/test-project');
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

    const project = queries.createProject('Test Project', 'C:/test-project');
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
      worktreePath: 'C:/mock-worktree',
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Resume Project', 'C:/resume-project', 'main', 1);
    queries.updateProject(project.id, { max_concurrent: 5, use_worktree: 1 });

    // Create Todo 1 (runs first)
    const todo1 = queries.createTodo(project.id, 'Task 1', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);

    // Create Todo 2 (will wait)
    const todo2 = queries.createTodo(project.id, 'Task 2', undefined, 0, undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, profile.id);

    let resolveExit1: (code: number) => void = () => {};
    let resolveExit2: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 101,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit1 = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 102,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit2 = resolve; }),
        command: 'claude',
        args: [],
      }));

    // Start Task 1 -> should run
    await orchestrator.startTodo(todo1.id);
    expect(queries.getTodoById(todo1.id)?.status).toBe('running');
    expect(queries.getTodoById(todo1.id)?.process_pid).toBe(101);

    // Start Task 2 -> capacity is 1, so Task 2 becomes waiting_executor
    await orchestrator.startTodo(todo2.id);
    expect(queries.getTodoById(todo2.id)?.status).toBe('waiting_executor');

    // Now Task 1 finishes successfully -> releases capacity
    resolveExit1(0);
    // Yield event loop so exitPromise resolves and triggers resumeWaitingTasks
    await new Promise((r) => setTimeout(r, 50));

    expect(queries.getTodoById(todo1.id)?.status).toBe('completed');
    // Task 2 should now have been started automatically!
    const refreshedTodo2 = queries.getTodoById(todo2.id);
    expect(refreshedTodo2?.status).toBe('running');
    expect(refreshedTodo2?.process_pid).toBe(102);

    // Cleanup Task 2
    resolveExit2(0);
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
    const project = queries.createProject('Manual Project', 'C:/manual-project');
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

    const project = queries.createProject('Antigravity Project', 'C:/agy-proj');
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

    // Verify startClaude was called with the effective model slug
    expect(startSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'gemini-3.7-flash-high',
      undefined,
      'headless',
      'antigravity',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
      undefined,
      undefined,
      undefined, // launchEffort undefined when effectiveModel slug encodes the effort
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
      worktreePath: 'C:/mock-worktree',
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Race Project', 'C:/race-proj', 'main', 1);
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

    const project = queries.createProject('Fail Project', 'C:/fail-proj');
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

    const project = queries.createProject('Stop All Project', 'C:/stop-all-proj');
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

    const projectA = queries.createProject('Project A', 'C:/proj-a');
    const projectB = queries.createProject('Project B', 'C:/proj-b');

    const todoA = queries.createTodo(projectA.id, 'Task A', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    const todoB = queries.createTodo(projectB.id, 'Task B', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);

    let resolveExitA: (code: number) => void = () => {};
    let resolveExitB: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 601,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExitA = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 602,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExitB = resolve; }),
        command: 'claude',
        args: [],
      }));

    // Start Task A in Project A -> starts
    await orchestrator.startTodo(todoA.id);
    expect(queries.getTodoById(todoA.id)?.status).toBe('running');

    // Start Task B in Project B -> enters waiting_executor because capacity (1) is occupied
    await orchestrator.startTodo(todoB.id);
    expect(queries.getTodoById(todoB.id)?.status).toBe('waiting_executor');

    // Task A completes in Project A -> releases global Claude capacity
    resolveExitA(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(queries.getTodoById(todoA.id)?.status).toBe('completed');
    // Task B in Project B is automatically woken and started!
    expect(queries.getTodoById(todoB.id)?.status).toBe('running');
    expect(queries.getTodoById(todoB.id)?.process_pid).toBe(602);

    resolveExitB(0);
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
    const project = queries.createProject('Disc Project', 'C:/disc-proj', 'main', 0, 'claude');

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

    const project = queries.createProject('Recovery Project', 'C:/recovery-proj');
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

    const project = queries.createProject('Spam Project', 'C:/spam-proj');
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

    const project = queries.createProject('Double Wake Project', 'C:/double-wake-proj');
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
      worktreePath: 'C:/mock-worktree',
      branchName: 'mock-branch',
    });
    vi.spyOn(worktreeManager, 'isValidWorktree').mockResolvedValue(true);

    const project = queries.createProject('Two Slot Project', 'C:/two-slot-proj', 'main', 1);
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

    const project = queries.createProject('Spawn Fail Project', 'C:/spawn-fail-proj');
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

    const project = queries.createProject('Session Project', 'C:/session-proj');
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

    const project = queries.createProject('Discussion Project', 'C:/disc-proj', 'main', 0, 'claude');
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

    const project = queries.createProject('Multi Disc Project', 'C:/multi-disc', 'main', 0, 'claude');

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

    const project = queries.createProject('Coalesce Project', 'C:/coalesce-proj');
    const waitingTodo = queries.createTodo(project.id, 'Waiting Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profile.id);
    queries.updateTodoStatus(waitingTodo.id, 'waiting_executor');

    // Start with Claude limit = 0 (so first pass sees it busy)
    executorPool.setLimit('claude', 0);

    let wakeCount = 0;
    const origStartSingle = (orchestrator as any).startSingleTodo.bind(orchestrator);
    vi.spyOn(orchestrator as any, 'startSingleTodo').mockImplementation(async (...args: any[]) => {
      wakeCount++;
      return origStartSingle(...args);
    });

    // Start a wake pass while limit is 0 -> finishes with todo still waiting_executor
    const wakePromise = orchestrator.wakeWaitingExecutors();

    // Capacity is freed concurrently while wake pass is executing!
    executorPool.setLimit('claude', 1);
    // Second wake requested while wakePromise is still in flight
    const secondWakePromise = orchestrator.wakeWaitingExecutors();

    await Promise.all([wakePromise, secondWakePromise]);

    // Waiter was reevaluated and launched in the coalesced pass!
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('running');
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
});

