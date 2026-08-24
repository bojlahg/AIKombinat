import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { executorPool } = await import('../executor-pool.js');
const { orchestrator } = await import('../orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const cliStatusModule = await import('../cli-status.js');
const { providerQuotaService } = await import('../provider-quota.js');
const { classifyProviderFailure } = await import('../failure-classifier.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');

describe('Quota Awareness V1', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
    executorPool.resetLimits();
    executorPool.resetReservations();
    providerQuotaService.resetForTesting();
    cliStatusModule.clearCache();
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    executorPool.resetLimits();
    executorPool.resetReservations();
    providerQuotaService.resetForTesting();
    cliStatusModule.clearCache();
    testDb.close();
  });

  it('1. default quota state is unknown', () => {
    const claudeState = providerQuotaService.getQuotaState('claude');
    const codexState = providerQuotaService.getQuotaState('codex');
    const agyState = providerQuotaService.getQuotaState('antigravity');

    expect(claudeState.state).toBe('unknown');
    expect(codexState.state).toBe('unknown');
    expect(agyState.state).toBe('unknown');
  });

  it('2. unknown does not block executor selection', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'unknown-quota-profile',
      name: 'Unknown Quota Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('selected');
    expect(selection.selectedCandidate?.cli_tool).toBe('claude');
    expect(selection.evaluations[0].status).toBe('available');
  });

  it('3. exhausted candidate is skipped', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'exhausted-single-profile',
      name: 'Exhausted Single Profile',
      description: '',
      executors: [{ cli_model_id: claude.id, effort_value: 'high', priority: 1 }],
    });

    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));

    providerQuotaService.markExhausted('claude', {
      source: 'test',
      reason: 'Exceeded quota limit',
    });

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('no_candidates');
    expect(selection.evaluations[0].status).toBe('unavailable');
    expect(selection.evaluations[0].reason).toContain('provider quota exhausted');
  });

  it('4. exhausted first candidate -> second candidate selected', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'fallback-quota-profile',
      name: 'Fallback Quota Profile',
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

    // Mark Claude as exhausted, Codex remains unknown/available
    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'Rate limit reached',
    });

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('selected');
    expect(selection.selectedCandidate?.cli_tool).toBe('codex');

    expect(selection.evaluations[0]).toMatchObject({
      cliTool: 'claude',
      status: 'unavailable',
    });
    expect(selection.evaluations[0].reason).toContain('provider quota exhausted');
    expect(selection.evaluations[1]).toMatchObject({
      cliTool: 'codex',
      status: 'available',
    });
  });

  it('5. all valid candidates exhausted -> clear waiting/unavailable diagnostic', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'all-exhausted-profile',
      name: 'All Exhausted Profile',
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

    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'Claude capacity reached' });
    providerQuotaService.markExhausted('codex', { source: 'test', reason: 'Codex 429 quota exceeded' });

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('no_candidates');

    const project = queries.createProject('Exhausted Project', 'C:/exhausted-project');
    const todo = queries.createTodo(
      project.id,
      'Execute task when all providers exhausted',
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
    expect(errorLog?.message).toContain('Claude / Claude 3.7 Sonnet / high:');
    expect(errorLog?.message).toContain('unavailable - provider quota exhausted');
    expect(errorLog?.message).toContain('Codex / GPT-5 / medium:');
    expect(errorLog?.message).toContain('unavailable - provider quota exhausted');
  });

  it('6. runtime Claude quota rejection marks Claude exhausted and allows Codex fallback', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'runtime-fallback-profile',
      name: 'Runtime Fallback Profile',
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

    const project = queries.createProject('Runtime Fallback Project', 'C:/rt-proj');
    const todo = queries.createTodo(
      project.id,
      'Task with profile fallback',
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

    let resolveExit1: (code: number) => void = () => {};
    let resolveExit2: (code: number) => void = () => {};

    const stdout1 = new PassThrough();
    const stderr1 = new PassThrough();

    const startClaudeSpy = vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(async () => ({
        pid: 701,
        stdout: stdout1,
        stderr: stderr1,
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit1 = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 702,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit2 = resolve; }),
        command: 'codex',
        args: [],
      }));

    // Start todo -> first candidate (Claude) is selected
    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    expect(queries.getTodoById(todo.id)?.process_pid).toBe(701);

    // Simulate Claude emitting a quota exhaustion error and exiting with code 1
    queries.createTaskLog(todo.id, 'error', 'Error: You have exhausted your capacity limit.');
    resolveExit1(1);

    // Wait for async exitPromise and fallback execution
    await new Promise((r) => setTimeout(r, 60));

    // Claude must now be marked exhausted in ProviderQuotaService
    const claudeQuota = providerQuotaService.getQuotaState('claude');
    expect(claudeQuota.state).toBe('exhausted');
    expect(claudeQuota.source).toBe('runtime_rejection');

    // The task should now have automatically switched to Codex and is running!
    const refreshedTodo = queries.getTodoById(todo.id);
    expect(refreshedTodo?.status).toBe('running');
    expect(refreshedTodo?.process_pid).toBe(702);

    expect(startClaudeSpy).toHaveBeenCalledTimes(2);

    resolveExit2(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('7. runtime Codex quota rejection marks Codex exhausted', async () => {
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const project = queries.createProject('Codex Project', 'C:/codex-proj');
    const todo = queries.createTodo(
      project.id,
      'Codex Task',
      undefined,
      0,
      'codex',
      'gpt-5',
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
      pid: 801,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'codex',
      args: [],
    });

    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('running');

    // Simulate Codex quota error
    queries.createTaskLog(todo.id, 'error', 'HTTP 429: insufficient_quota - quota exceeded');
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 40));

    const codexQuota = providerQuotaService.getQuotaState('codex');
    expect(codexQuota.state).toBe('exhausted');
    expect(codexQuota.source).toBe('runtime_rejection');
  });

  it('8. runtime Antigravity quota rejection marks Antigravity exhausted', async () => {
    const agy = queries.addModel('antigravity', 'gemini-3.7-flash', 'Gemini 3.7 Flash', ['high'], { high: 'gemini-3.7-flash-high' });
    const project = queries.createProject('Agy Project', 'C:/agy-proj');
    const todo = queries.createTodo(
      project.id,
      'Agy Task',
      undefined,
      0,
      'antigravity',
      'gemini-3.7-flash',
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      'high',
      agy.id,
    );

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 901,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'agy',
      args: [],
    });

    await orchestrator.startTodo(todo.id);
    expect(queries.getTodoById(todo.id)?.status).toBe('running');

    // Simulate Antigravity RESOURCE_EXHAUSTED error
    queries.createTaskLog(todo.id, 'error', 'Error: RESOURCE_EXHAUSTED: Quota exceeded for quota metric');
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 40));

    const agyQuota = providerQuotaService.getQuotaState('antigravity');
    expect(agyQuota.state).toBe('exhausted');
    expect(agyQuota.source).toBe('runtime_rejection');
  });

  it('9. unrelated process failure does NOT change quota state', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Normal Error Project', 'C:/normal-err-proj');
    const todo = queries.createTodo(
      project.id,
      'Syntax Error Task',
      undefined,
      0,
      'claude',
      'claude-3.7-sonnet',
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      'high',
      claude.id,
    );

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1001,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    await orchestrator.startTodo(todo.id);

    // Normal programming error / git error / exit code 1
    queries.createTaskLog(todo.id, 'error', 'TypeError: undefined is not a function at index.js:42');
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 40));

    const claudeQuota = providerQuotaService.getQuotaState('claude');
    expect(claudeQuota.state).toBe('unknown'); // Still unknown, NOT exhausted
  });

  it('10. expired unknown-reset exhaustion becomes unknown', () => {
    providerQuotaService.setCooldownMs(100); // 100ms cooldown for test
    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'Rate limited',
    });

    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');

    // Fast-forward time past cooldown
    vi.setSystemTime(Date.now() + 200);

    const updatedState = providerQuotaService.getQuotaState('claude');
    expect(updatedState.state).toBe('unknown');
    expect(updatedState.source).toBe('cooldown_expired');

    vi.useRealTimers();
  });

  it('11. successful execution may mark provider available', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Success Project', 'C:/success-proj');
    const todo = queries.createTodo(
      project.id,
      'Successful Task',
      undefined,
      0,
      'claude',
      'claude-3.7-sonnet',
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      'high',
      claude.id,
    );

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1101,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

    await orchestrator.startTodo(todo.id);
    resolveExit(0); // Exit code 0 (success)

    await new Promise((r) => setTimeout(r, 40));

    expect(providerQuotaService.getQuotaState('claude').state).toBe('available');
    expect(providerQuotaService.getQuotaState('claude').source).toBe('execution_success');
  });

  it('12. manual execution does not silently fall back to another provider', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Manual No-Switch Project', 'C:/manual-proj');
    const todo = queries.createTodo(
      project.id,
      'Manual Task',
      undefined,
      0,
      'claude',
      'claude-3.7-sonnet',
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      null, // Manual task (no execution_profile_id)
      'high',
      claude.id,
    );

    let resolveExit: (code: number) => void = () => {};
    const startSpy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1201,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    await orchestrator.startTodo(todo.id);

    // Simulate quota rejection
    queries.createTaskLog(todo.id, 'error', 'Error: exhausted your quota');
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 40));

    const failedTodo = queries.getTodoById(todo.id);
    expect(failedTodo?.status).toBe('failed');
    // Did NOT spawn another CLI process (Codex / etc.)
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Clear error message in logs
    const logs = queries.getTaskLogsByTodoId(todo.id);
    const quotaErrorLog = logs.find((l) => l.message.includes('provider quota exhausted'));
    expect(quotaErrorLog).toBeDefined();
    expect(quotaErrorLog?.log_type).toBe('error');
  });

  it('13. quota state survives DB restart', () => {
    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'Quota limit exceeded',
      resetAt: '2026-08-24T12:00:00.000Z',
    });

    // Clear in-memory service cache (simulating process restart)
    providerQuotaService.resetForTesting();

    // Query state again -> loads from SQLite table
    const reloaded = providerQuotaService.getQuotaState('claude');
    expect(reloaded.state).toBe('exhausted');
    expect(reloaded.source).toBe('runtime_rejection');
    expect(reloaded.reason).toBe('Quota limit exceeded');
    expect(reloaded.resetAt).toBe('2026-08-24T12:00:00.000Z');
  });

  it('14. quota exhaustion and concurrency busy remain distinct diagnostics', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const profile = queries.createExecutionProfile({
      slug: 'distinct-diagnostics-profile',
      name: 'Distinct Diagnostics Profile',
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

    // Claude is exhausted, Codex is busy (concurrency limit = 0)
    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'daily quota reached' });
    executorPool.setLimit('codex', 0);

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('waiting_executor');

    const claudeEval = selection.evaluations.find((e) => e.cliTool === 'claude');
    const codexEval = selection.evaluations.find((e) => e.cliTool === 'codex');

    // Distinct statuses and reasons
    expect(claudeEval?.status).toBe('unavailable');
    expect(claudeEval?.reason).toContain('provider quota exhausted');

    expect(codexEval?.status).toBe('busy');
    expect(codexEval?.reason).toBe('provider concurrency limit reached');
  });
});
