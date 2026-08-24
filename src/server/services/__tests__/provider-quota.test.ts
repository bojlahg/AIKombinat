import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { executorPool } = await import('../executor-pool.js');
const { orchestrator } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { discussionOrchestrator } = await import('../discussion-orchestrator.js');
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

  it('10b. known resetAt in 4 hours remains exhausted after 5-minute cooldown and transitions only after resetAt', () => {
    providerQuotaService.setCooldownMs(5 * 60 * 1000); // 5 min cooldown
    const fourHoursLater = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'Daily quota exhausted',
      resetAt: fourHoursLater,
    });

    // 10 minutes pass (greater than generic 5-min cooldown, but less than 4 hours)
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');

    // 4 hours + 1 minute pass (past resetAt)
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000 + 60 * 1000);
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

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

  it('11b. stale success cannot erase newer active exhaustion, but expired exhaustion can become available', async () => {
    providerQuotaService.setCooldownMs(100);
    // Mark Claude as actively exhausted
    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'Rate limited on earlier task',
    });

    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');

    // A concurrent task that started before exhaustion now finishes with success
    providerQuotaService.markAvailable('claude', { source: 'stale_success' });

    // Active exhaustion MUST be preserved
    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');

    // Fast forward past cooldown -> transitions to unknown
    vi.setSystemTime(Date.now() + 200);
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

    // A subsequent successful execution can now establish available state
    providerQuotaService.markAvailable('claude', { source: 'fresh_success' });
    expect(providerQuotaService.getQuotaState('claude').state).toBe('available');

    vi.useRealTimers();
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

  it('12b. manual Todo preflight blocks launch of already exhausted provider without spawning CLI', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Preflight Todo Project', 'C:/preflight-todo-proj');
    const todo = queries.createTodo(
      project.id,
      'Preflight Todo Task',
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

    // Mark Claude as already exhausted
    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'daily quota limit exceeded' });

    const startSpy = vi.spyOn(claudeManager, 'startClaude');

    await orchestrator.startTodo(todo.id);

    // CLI must NOT have been spawned
    expect(startSpy).not.toHaveBeenCalled();

    const failedTodo = queries.getTodoById(todo.id);
    expect(failedTodo?.status).toBe('failed');

    const logs = queries.getTaskLogsByTodoId(todo.id);
    const quotaLog = logs.find((l) => l.message.includes('provider quota exhausted'));
    expect(quotaLog).toBeDefined();
    expect(quotaLog?.log_type).toBe('error');
  });

  it('12c. manual Session preflight blocks launch of already exhausted provider', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Preflight Session Project', 'C:/preflight-sess-proj');
    const session = queries.createSession(
      project.id,
      'Preflight Session',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'quota exceeded' });
    const startSpy = vi.spyOn(claudeManager, 'startClaude');

    await expect(sessionManager.startSession(session.id)).rejects.toThrow('Provider quota exhausted');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('12d. manual Discussion preflight pauses turn for already exhausted provider', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5', 'GPT-5', ['medium']);
    const project = queries.createProject('Preflight Disc Project', 'C:/preflight-disc-proj');

    const agent1 = queries.createDiscussionAgent(
      project.id,
      'Agent Alpha',
      'Role description',
      'System prompt',
      'claude',
      'claude-3.7-sonnet',
      'blue',
      false,
      null,
      'high',
      claude.id,
    );
    const agent2 = queries.createDiscussionAgent(
      project.id,
      'Agent Beta',
      'Role description 2',
      'System prompt 2',
      'codex',
      'gpt-5',
      'green',
      false,
      null,
      'medium',
      codex.id,
    );

    const disc = queries.createDiscussion(
      project.id,
      'Test Topic',
      'Discussion Description',
      [agent1.id, agent2.id],
      3,
      false,
      undefined,
      'none',
      null,
      null,
      0,
    );

    providerQuotaService.markExhausted('claude', { source: 'test', reason: 'quota limit reached' });
    const startSpy = vi.spyOn(claudeManager, 'startClaude');

    await discussionOrchestrator.startDiscussion(disc.id);

    expect(startSpy).not.toHaveBeenCalled();
    const updatedDisc = queries.getDiscussionById(disc.id);
    expect(updatedDisc?.status).toBe('paused');

    const logs = queries.getDiscussionLogs(disc.id);
    const quotaWarn = logs.find((l) => l.message.includes('provider quota exhausted'));
    expect(quotaWarn).toBeDefined();
    expect(quotaWarn?.log_type).toBe('warning');
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

  it('15. Session failure classification reads raw PTY output for quota detection', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('PTY Session Project', 'C:/pty-sess-proj');
    const session = queries.createSession(
      project.id,
      'PTY Session',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1501,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    await sessionManager.startSession(session.id);

    // Simulate writing raw PTY chunk with quota message (no lifecycle log has quota text)
    queries.appendSessionRawChunk(session.id, Buffer.from('\x1b[31mError: usage limit reached. Please try later.\x1b[0m'));

    // Process exits with error code
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 40));

    // Claude quota must be marked exhausted from raw PTY chunk
    const claudeQuota = providerQuotaService.getQuotaState('claude');
    expect(claudeQuota.state).toBe('exhausted');
    expect(claudeQuota.source).toBe('runtime_rejection');
    expect(claudeQuota.reason).toContain('usage limit reached');
  });

  it('15b. Antigravity Session failure classification reads raw PTY output for RESOURCE_EXHAUSTED', async () => {
    const agy = queries.addModel('antigravity', 'gemini-3.7-flash', 'Gemini 3.7 Flash', ['high'], { high: 'gemini-3.7-flash-high' });
    const project = queries.createProject('Agy PTY Project', 'C:/agy-pty-proj');
    const session = queries.createSession(
      project.id,
      'Agy PTY Session',
      'Session description',
      'antigravity',
      'gemini-3.7-flash',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      agy.id,
    );

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1551,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'agy',
      args: [],
    });

    await sessionManager.startSession(session.id);

    queries.appendSessionRawChunk(session.id, Buffer.from('Error: RESOURCE_EXHAUSTED: Quota exceeded for quota metric'));
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 40));

    const agyQuota = providerQuotaService.getQuotaState('antigravity');
    expect(agyQuota.state).toBe('exhausted');
    expect(agyQuota.source).toBe('runtime_rejection');
    expect(agyQuota.reason).toContain('RESOURCE_EXHAUSTED');
  });

  it('16. Session unrelated PTY failure does not change quota state', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('PTY Normal Err Project', 'C:/pty-normal-proj');
    const session = queries.createSession(
      project.id,
      'PTY Normal Session',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    let resolveExit: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 1601,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    await sessionManager.startSession(session.id);

    queries.appendSessionRawChunk(session.id, Buffer.from('bash: git: command not found'));
    resolveExit(127);

    await new Promise((r) => setTimeout(r, 40));

    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');
  });

  it('17. overloaded_error is classified as other and does not alter quota state', () => {
    const result = classifyProviderFailure('claude', 1, 'Error: overloaded_error - Anthropic server is temporarily overloaded.');
    expect(result.category).toBe('other');

    // Quota state remains unknown
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');
  });

  it('18. Todo failure classification is strictly isolated to current execution and ignores historical logs', async () => {
    providerQuotaService.setCooldownMs(100);
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Todo Iso Project', 'C:/todo-iso-proj');
    const todo = queries.createTodo(
      project.id,
      'Todo Isolation Task',
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

    let resolveExitA: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce({
      pid: 1801,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExitA = resolve; }),
      command: 'claude',
      args: [],
    });

    // Run A starts
    await orchestrator.startTodo(todo.id);
    queries.createTaskLog(todo.id, 'error', 'Error: usage limit reached');
    resolveExitA(1);

    await new Promise((r) => setTimeout(r, 40));

    // Run A marked Claude exhausted
    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');

    // Fast-forward past cooldown -> Claude becomes unknown
    vi.setSystemTime(Date.now() + 200);
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

    // Reset todo status to pending for Retry
    queries.updateTodoStatus(todo.id, 'pending');

    let resolveExitB: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce({
      pid: 1802,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExitB = resolve; }),
      command: 'claude',
      args: [],
    });

    // Run B starts (same Todo retried)
    await orchestrator.startTodo(todo.id);
    // Run B fails with an unrelated error (e.g. exit code 127)
    queries.createTaskLog(todo.id, 'error', 'bash: build-script.sh: command not found');
    resolveExitB(127);

    await new Promise((r) => setTimeout(r, 40));

    // Run B must NOT poison Claude quota from Run A's historical quota error
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

    vi.useRealTimers();
  });

  it('19. Session failure classification is strictly isolated to current execution and ignores historical raw chunks', async () => {
    providerQuotaService.setCooldownMs(100);
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Session Iso Project', 'C:/sess-iso-proj');
    const session = queries.createSession(
      project.id,
      'Session Isolation',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    let resolveExitA: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce({
      pid: 1901,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExitA = resolve; }),
      command: 'claude',
      args: [],
    });

    // Session Run A starts
    await sessionManager.startSession(session.id);
    queries.appendSessionRawChunk(session.id, Buffer.from('\x1b[31mError: usage limit reached\x1b[0m'));
    resolveExitA(1);

    await new Promise((r) => setTimeout(r, 40));

    // Run A marked Claude exhausted
    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');

    // Fast-forward past cooldown -> Claude becomes unknown
    vi.setSystemTime(Date.now() + 200);
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

    let resolveExitB: (code: number) => void = () => {};
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce({
      pid: 1902,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExitB = resolve; }),
      command: 'claude',
      args: [],
    });

    // Session Run B starts (same session restarted)
    await sessionManager.startSession(session.id);
    queries.appendSessionRawChunk(session.id, Buffer.from('error: failed to push some refs'));
    resolveExitB(1);

    await new Promise((r) => setTimeout(r, 40));

    // Run B must NOT poison Claude quota from Run A's historical raw chunks
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');

    // Verify historical raw chunks from both runs are still preserved for terminal replay
    const allChunks = queries.getSessionRawChunks(session.id);
    expect(allChunks.length).toBe(2);

    vi.useRealTimers();
  });

  it('20. profile Todo Claude emits repeated quota errors -> marks Claude exhausted and falls back via ExecutorPool without legacy getNextFallbackCli', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5-codex', 'GPT 5 Codex', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'multi-candidate-profile',
      name: 'Multi Candidate',
      description: 'Fallback profile',
      executors: [
        { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
        { cli_model_id: codex.id, effort_value: 'high', priority: 2 },
      ],
    });

    const project = queries.createProject('Profile Quota Proj', 'C:/prof-proj');
    queries.updateProject(project.id, { fallback_cli: 'raw-shell' });
    const todo = queries.createTodo(
      project.id,
      'Profile Quota Task',
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
        pid: 2001,
        stdout: stdout1,
        stderr: stderr1,
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit1 = resolve; }),
        command: 'claude',
        args: [],
      }))
      .mockImplementationOnce(async () => ({
        pid: 2002,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit2 = resolve; }),
        command: 'codex',
        args: [],
      }));

    await orchestrator.startTodo(todo.id);

    // Stream repeated quota errors
    queries.createTaskLog(todo.id, 'error', 'Error: You have exhausted your capacity on Claude.');
    queries.createTaskLog(todo.id, 'error', 'Error: 429 quota exceeded.');
    resolveExit1(1);

    await new Promise((r) => setTimeout(r, 60));

    // Claude is marked exhausted
    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');

    // Switched to Codex (candidate 2 in profile), NOT raw-shell (project fallback_cli)
    const refreshed = queries.getTodoById(todo.id);
    expect(refreshed?.status).toBe('running');
    expect(refreshed?.process_pid).toBe(2002);
    expect(startClaudeSpy).toHaveBeenCalledTimes(2);

    resolveExit2(0);
  });

  it('21. manual Todo emits repeated quota errors -> fails clearly and does not silently change cli_tool', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Manual Quota Proj', 'C:/man-proj');
    queries.updateProject(project.id, { fallback_cli: 'codex' });
    const todo = queries.createTodo(
      project.id,
      'Manual Quota Task',
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
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce({
      pid: 2101,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    await orchestrator.startTodo(todo.id);

    queries.createTaskLog(todo.id, 'error', 'Error: You have exhausted your capacity on Claude.');
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 60));

    const refreshed = queries.getTodoById(todo.id);
    expect(refreshed?.status).toBe('failed');
    expect(refreshed?.cli_tool).toBe('claude'); // NOT changed to codex
    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');
  });

  it('22. genuine context-window exhaustion still triggers context fallback and does not mark quota exhausted', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const codex = queries.addModel('codex', 'gpt-5-codex', 'GPT 5 Codex', ['high']);
    const project = queries.createProject('Context Fallback Proj', 'C:/ctx-proj');
    queries.updateProject(project.id, { cli_fallback_chain: JSON.stringify(['claude', 'codex']) });
    const todo = queries.createTodo(
      project.id,
      'Context Fallback Task',
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

    const restartSpy = vi.spyOn(orchestrator as any, 'restartWithNextCli').mockResolvedValue(undefined);

    let resolveExit: (code: number) => void = () => {};
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce({
      pid: 2201,
      stdout,
      stderr,
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    await orchestrator.startTodo(todo.id);

    // Stream genuine context exhaustion error
    stderr.emit('data', 'Error: Conversation is too long and exceeds the maximum context length.\n');
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 60));

    // Context restart triggered with next CLI fallback in chain
    expect(restartSpy).toHaveBeenCalledWith(
      todo.id,
      project.id,
      'claude',
      { cliTool: 'codex', cliModel: null },
      true,
    );

    // Quota remains unknown (genuine context exhaustion does not mark quota exhausted)
    expect(providerQuotaService.getQuotaState('claude').state).toBe('unknown');
  });

  it('23. PTY emits quota error before SessionManager installs subscriber -> quota is detected on exit', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('PTY Early Quota Proj', 'C:/pty-early-proj');
    const session = queries.createSession(
      project.id,
      'PTY Early Session',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    const pid = 2301;
    let resolveExit: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      // Simulate PTY emitting bytes BEFORE startClaude resolves/SessionManager subscribes
      (claudeManager as any).rawRingBuffers.set(pid, {
        chunks: ['\x1b[31mError: 429 Too Many Requests: usage limit reached\x1b[0m\r\n'],
        bytes: 60,
        max: 256 * 1024,
      });

      return {
        pid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
        command: 'claude',
        args: [],
      };
    });

    await sessionManager.startSession(session.id);
    resolveExit(1);

    await new Promise((r) => setTimeout(r, 60));

    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');
    expect(providerQuotaService.getQuotaState('claude').source).toBe('runtime_rejection');
  });

  it('24. output emitted around replay/subscription boundary is persisted exactly once without duplicates', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('PTY Boundary Proj', 'C:/pty-bound-proj');
    const session = queries.createSession(
      project.id,
      'PTY Boundary Session',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    const pid = 2401;
    let resolveExit: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      (claudeManager as any).rawRingBuffers.set(pid, {
        chunks: ['initial banner\n'],
        bytes: 15,
        max: 256 * 1024,
      });

      return {
        pid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
        command: 'claude',
        args: [],
      };
    });

    await sessionManager.startSession(session.id);

    // Later chunk emitted after subscription
    const subs = (claudeManager as any).rawSubscribers.get(pid);
    if (subs) {
      for (const cb of subs) cb('second chunk\n');
    }

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 60));

    const chunks = queries.getSessionRawChunks(session.id);
    const text = chunks.map((c) => c.bytes.toString('utf8')).join('');
    expect(text).toBe('initial banner\nsecond chunk\n');
  });

  it('25. normal later PTY output is still persisted correctly', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('PTY Normal Proj', 'C:/pty-norm-proj');
    const session = queries.createSession(
      project.id,
      'PTY Normal Session',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    const pid = 2501;
    let resolveExit: (code: number) => void = () => {};

    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce({
      pid,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitPromise: new Promise<number>((resolve) => { resolveExit = resolve; }),
      command: 'claude',
      args: [],
    });

    await sessionManager.startSession(session.id);

    const subs = (claudeManager as any).rawSubscribers.get(pid);
    if (subs) {
      for (const cb of subs) cb('hello from pty\n');
    }

    resolveExit(0);
    await new Promise((r) => setTimeout(r, 60));

    const text = queries.getRecentSessionRawText(session.id, 1024);
    expect(text).toContain('hello from pty');
  });

  it('26. very fast process exit does not lose the quota message', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('PTY Fast Exit Proj', 'C:/pty-fast-proj');
    const session = queries.createSession(
      project.id,
      'PTY Fast Exit Session',
      'Session description',
      'claude',
      'claude-3.7-sonnet',
      false,
      null,
      null,
      null,
      null,
      null,
      'high',
      claude.id,
    );

    const pid = 2601;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      // Fast exit: ring buffer populated and exitPromise already resolved
      (claudeManager as any).rawRingBuffers.set(pid, {
        chunks: ['Error: 429 You have exceeded your current quota.\n'],
        bytes: 50,
        max: 256 * 1024,
      });

      return {
        pid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        exitPromise: Promise.resolve(1),
        command: 'claude',
        args: [],
      };
    });

    await sessionManager.startSession(session.id);
    await new Promise((r) => setTimeout(r, 60));

    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');
  });

  it('27. lazy quota expiry broadcasts quota:updated once when transitioning exhausted -> unknown', () => {
    providerQuotaService.setCooldownMs(50);
    providerQuotaService.markExhausted('claude', { source: 'runtime_rejection' });

    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast');
    broadcastSpy.mockClear();

    // Before cooldown expires: remains exhausted, no extra broadcast
    const state1 = providerQuotaService.getQuotaState('claude');
    expect(state1.state).toBe('exhausted');
    expect(broadcastSpy).not.toHaveBeenCalled();

    // Advance time past cooldown
    vi.setSystemTime(Date.now() + 100);

    // First call after expiration: transitions exhausted -> unknown and broadcasts
    const state2 = providerQuotaService.getQuotaState('claude');
    expect(state2.state).toBe('unknown');
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: 'quota:updated',
      tool: 'claude',
      state: 'unknown',
      source: 'cooldown_expired',
      reason: null,
      resetAt: null,
    });

    // Subsequent calls: already unknown, no duplicate broadcast
    broadcastSpy.mockClear();
    const state3 = providerQuotaService.getQuotaState('claude');
    expect(state3.state).toBe('unknown');
    expect(broadcastSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

