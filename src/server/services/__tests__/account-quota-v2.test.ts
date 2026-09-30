import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';
import { createChildEnvironment } from '../../utils/child-environment.js';

let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
const queries = await import('../../db/queries.js');
const accounts = await import('../provider-account-service.js');
const { providerQuotaService: quota } = await import('../provider-quota.js');
const { executorPool } = await import('../executor-pool.js');
const { orchestrator } = await import('../orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const cliStatus = await import('../cli-status.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');
const failover = await import('../account-failover.js');
const store = await import('../../orchestration/store.js');
const { OrchestratorAgentService } = await import('../../orchestration/service.js');
const { callTool } = await import('../../orchestration/tools.js');
const { sessionManager } = await import('../session-manager.js');
let workspace: TestWorkspace;
let project: queries.Project;
let services: InstanceType<typeof OrchestratorAgentService>[];
let spawned: ReturnType<typeof spawn>[];

beforeEach(() => {
  workspace = createTestWorkspace('account-quota-v2'); db = new Database(':memory:'); initDatabase(db);
  project = queries.createProject('Disposable quota smoke', workspace.createSubdir('project'));
  quota.resetForTesting(); executorPool.resetReservations(); executorPool.resetLimits(); services = []; spawned = [];
  vi.spyOn(cliStatus, 'getToolStatus').mockImplementation(async tool => ({ tool, installed: true, version: 'synthetic' }));
  vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
  const inherited = accounts.accountCandidates('claude')[0]; accounts.saveProviderAccount({ is_enabled: false }, inherited.id);
});
afterEach(async () => {
  await Promise.all(services.map(service => service.shutdown()));
  await new Promise(resolve => setImmediate(resolve));
  for (const child of spawned) if (child.exitCode === null) child.kill();
  quota.resetForTesting(); executorPool.resetReservations(); executorPool.resetLimits(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  db.close(); workspace.cleanup();
});
const createAccount = (slug: string) => accounts.saveProviderAccount({ provider: 'claude', slug, label: slug,
  auth_strategy: 'environment_reference', auth_config: { variable: `QUOTA_ACCOUNT_${slug.toUpperCase()}` }, max_concurrency: 1, sort_order: slug.charCodeAt(0) });
function profile(policy: 'automatic' | 'fixed' | 'inherited_default' = 'automatic', id?: string) {
  const model = queries.addModel('claude', `quota-model-${Math.random()}`, 'Quota model');
  return queries.createExecutionProfile({ slug: `quota-${Math.random()}`, name: 'Quota smoke', description: '',
    executors: [{ cli_model_id: model.id, effort_value: null, priority: 0, account_policy: policy, provider_account_id: id }] });
}
function todo(profileId: string, review = false) {
  const item = queries.createTodo(project.id, 'Implement a fixture', 'Create a fixture file', 0, undefined, undefined,
    undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, profileId);
  if (review) queries.updateTodo(item.id, { review_enabled: 1, review_profile_id: profileId, rework_profile_id: profileId });
  return queries.getTodoById(item.id)!;
}
function mockProcess(pid: number) {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let resolve!: (code: number) => void;
  const exitPromise = new Promise<number>(done => { resolve = code => { stdout.end(); stderr.end(); done(code); }; });
  return { pid, stdout, stderr, stdin: null, command: 'synthetic', args: [], exitPromise, resolve };
}
async function until(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 10 });
}

describe('Account quota V2', () => {
  it('migrates legacy exhaustion without assigning it to accounts; preserves identities, snapshots and FKs', () => {
    const a = createAccount('a'), b = createAccount('b'), p = profile(), item = todo(p.id);
    queries.updateTodo(item.id, { execution_snapshot: '{"agent":"claude","legacy":true}' });
    queries.upsertProviderQuotaState({ tool: 'claude', state: 'exhausted', source: 'legacy', observed_at: new Date().toISOString(), reason: 'legacy quota', reset_at: null });
    db.exec('DROP TABLE provider_account_quota_state'); initDatabase(db); initDatabase(db);
    expect(quota.getAccountQuotaState(a.id).state).toBe('unknown'); expect(quota.getAccountQuotaState(b.id).state).toBe('unknown');
    expect(queries.getTodoById(item.id)?.execution_snapshot).toBe('{"agent":"claude","legacy":true}');
    expect(accounts.getProviderAccount(a.id)?.id).toBe(a.id); expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(quota.getQuotaState('claude').state).toBe('unknown');
  });
  it('derives aggregate from runnable accounts and real success overrides exhaustion without cross-account changes', () => {
    const a = createAccount('a'), b = createAccount('b');
    quota.markAccountExhausted(a.id, { source: 'runtime_rejection' }); quota.markAccountExhausted(b.id, { source: 'runtime_rejection' });
    expect(quota.getQuotaState('claude').state).toBe('exhausted');
    quota.markAccountUnknown(a.id); expect(quota.getQuotaState('claude').state).toBe('unknown');
    quota.markAccountAvailable(a.id); expect(quota.getQuotaState('claude').state).toBe('available');
    accounts.saveProviderAccount({ is_enabled: false }, a.id); expect(quota.getQuotaState('claude').state).toBe('exhausted');
    accounts.saveProviderAccount({ is_enabled: true }, a.id); accounts.setAccountHealth(a.id, 'auth_error'); expect(quota.getQuotaState('claude').state).toBe('exhausted');
    accounts.setAccountHealth(a.id, 'available'); quota.markAccountExhausted(a.id, { source: 'runtime_rejection' }); quota.markAccountAvailable(a.id);
    expect(quota.getAccountQuotaState(a.id).state).toBe('available'); expect(quota.getAccountQuotaState(b.id).state).toBe('exhausted');
  });
  it('expires account cooldowns independently, coalesces wakeups, retains multiple subscribers, bounds reasons and rejects malformed reset', async () => {
    vi.useFakeTimers();
    try {
      const a = createAccount('a'), b = createAccount('b'); quota.setCooldownMs(1000);
      await Promise.resolve();
      const first = vi.fn(), second = vi.fn(); quota.setAvailabilityCallback(first); quota.onAvailability(second);
      quota.markAccountExhausted(a.id, { source: 'runtime_rejection', reason: 'x\n'.repeat(2000), resetAt: '9999-01-01T00:00:00Z' });
      quota.markAccountExhausted(b.id, { source: 'runtime_rejection', resetAt: new Date(Date.now() + 2000).toISOString() });
      expect(Buffer.byteLength(quota.getAccountQuotaState(a.id).reason!)).toBeLessThanOrEqual(1024);
      await vi.advanceTimersByTimeAsync(1001);
      expect(quota.getAccountQuotaState(a.id)).toMatchObject({ state: 'unknown', source: 'cooldown_expired' });
      expect(quota.getAccountQuotaState(b.id).state).toBe('exhausted'); expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000); expect(first).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('redacts configured credential references from normalized quota reasons outside process redaction lifetime', () => {
    const a = createAccount('a'); vi.stubEnv('QUOTA_ACCOUNT_A', 'reference-value-private');
    const observed = quota.markAccountExhausted(a.id, { source: 'runtime_rejection', reason: 'rate limit reference-value-private exceeded\n' });
    expect(observed.reason).not.toContain('reference-value-private'); expect(observed.reason).toContain('***redacted***');
  });
  it('distinguishes quota, busy, unhealthy and exclusion diagnostics while enforcing provider capacity', async () => {
    const a = createAccount('a'), b = createAccount('b'), p = profile();
    quota.markAccountExhausted(a.id, { source: 'runtime_rejection' }); executorPool.reserveSlot('busy', 'claude', { providerAccountId: b.id });
    expect((await executorPool.selectExecutor({ executionProfileId: p.id })).status).toBe('waiting_executor');
    executorPool.releaseReservation('busy');
    expect((await executorPool.selectExecutor({ executionProfileId: p.id })).selectedConfig?.providerAccountId).toBe(b.id);
    quota.markAccountExhausted(b.id, { source: 'runtime_rejection' });
    expect((await executorPool.selectExecutor({ executionProfileId: p.id })).status).toBe('waiting_quota');
    quota.markAccountUnknown(a.id);
    const excluded = await executorPool.selectExecutor({ executionProfileId: p.id, excludedProviderAccountIds: [a.id] });
    expect(excluded.status).toBe('waiting_quota'); expect(excluded.rejectionSummary).toContain('already_attempted');
    accounts.setAccountHealth(a.id, 'auth_error'); accounts.setAccountHealth(b.id, 'unavailable');
    expect((await executorPool.selectExecutor({ executionProfileId: p.id })).status).toBe('no_candidates');
  });
  it('runs executable synthetic A → B smoke with real child PIDs, workspace preservation, fresh arguments, isolated credentials and durable lineage', async () => {
    const a = createAccount('a'), b = createAccount('b'), p = profile(), item = todo(p.id);
    const git = (args: string[]) => execFileSync('git', args, { cwd: project.path, windowsHide: true, stdio: 'pipe' });
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Quota Smoke']); git(['config', 'user.email', 'quota@example.invalid']);
    fs.writeFileSync(path.join(project.path, 'README.md'), 'Disposable quota workspace'); git(['add', '.']); git(['commit', '-m', 'fixture']);
    queries.updateProject(project.id, { is_git_repo: 1, use_worktree: 1, npm_auto_install: 0 }); queries.updateTodo(item.id, { use_worktree: 1 });
    vi.stubEnv('QUOTA_ACCOUNT_A', 'synthetic-a-secret'); vi.stubEnv('QUOTA_ACCOUNT_B', 'synthetic-b-secret');
    const launches: { account: string | null | undefined; pid: number; workDir: string; prompt: string; resume: unknown }[] = [];
    const spy = vi.spyOn(claudeManager, 'startClaude').mockImplementation(async (workDir, prompt, launch, ...args) => {
      const accountId = typeof launch === 'string' ? null : launch?.providerAccountId;
      const runtime = accounts.buildAccountRuntime(accountId);
      const code = accountId === a.id
        ? "require('fs').writeFileSync('partial.txt','from A'); process.stderr.write('usage limit reached'); process.exitCode=1"
        : "if(require('fs').readFileSync('partial.txt','utf8')!=='from A') process.exit(4); require('fs').writeFileSync('done.txt','B completed')";
      const env = createChildEnvironment(runtime.env);
      expect(env.SESSION_SECRET).toBeUndefined(); expect(env.TUNNEL_TOKEN).toBeUndefined();
      expect(env.QUOTA_ACCOUNT_A).toBeUndefined(); expect(env.QUOTA_ACCOUNT_B).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe(accountId === a.id ? 'synthetic-a-secret' : 'synthetic-b-secret');
      const child = spawn(process.execPath, ['-e', code], { cwd: workDir, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] }); spawned.push(child);
      const exitPromise = new Promise<number>(resolve => child.once('close', code => resolve(code ?? -1)));
      launches.push({ account: accountId, pid: child.pid!, workDir, prompt, resume: args[6] });
      return { pid: child.pid!, stdout: child.stdout!, stderr: child.stderr!, stdin: child.stdin!, command: process.execPath, args: ['-e'], exitPromise };
    });
    await orchestrator.startTodo(item.id); await until(() => queries.getTodoById(item.id)?.status === 'completed');
    expect(spy).toHaveBeenCalledTimes(2); expect(launches.map(row => row.account)).toEqual([a.id,b.id]); expect(launches[0].pid).not.toBe(launches[1].pid);
    expect(launches[0].workDir).toBe(launches[1].workDir); expect(launches[0].workDir).not.toBe(project.path); expect(launches[1].prompt).toContain('Inspect current files/tests first'); expect(launches[1].resume).toBe(false);
    expect(fs.readFileSync(path.join(launches[1].workDir, 'done.txt'), 'utf8')).toBe('B completed');
    const rounds = queries.getExecutionRoundsByTodoId(item.id); expect(rounds.map(row => row.status)).toEqual(['failed','completed']);
    expect(rounds[0].run_token).not.toBe(rounds[1].run_token); expect(rounds[1].retry_of_round_id).toBe(rounds[0].id);
    expect(JSON.parse(rounds[0].execution_snapshot!).providerAccountId).toBe(a.id); expect(JSON.parse(rounds[1].execution_snapshot!).providerAccountId).toBe(b.id);
    expect(quota.getAccountQuotaState(a.id).state).toBe('exhausted'); expect(quota.getAccountQuotaState(b.id).state).toBe('available');
    const audit = db.prepare('SELECT * FROM account_failover_events WHERE owner_id=?').all(item.id); expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ from_account_id: a.id, to_account_id: b.id });
    expect(JSON.stringify(audit)).not.toContain('synthetic-a-secret'); expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('fixed account waits and wakes on the same account without rotating to B', async () => {
    const a = createAccount('a'); createAccount('b'); const p = profile('fixed', a.id), item = todo(p.id);
    const first = mockProcess(20001), second = mockProcess(20002);
    const spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    quota.setAvailabilityCallback(() => { void orchestrator.wakeWaitingQuota(); });
    await orchestrator.startTodo(item.id); first.stderr.write('usage limit reached'); first.resolve(1);
    await until(() => queries.getTodoById(item.id)?.status === 'waiting_quota'); expect(spy).toHaveBeenCalledTimes(1);
    quota.markAccountUnknown(a.id); await until(() => spy.mock.calls.length === 2);
    expect((spy.mock.calls[1][2] as { providerAccountId: string }).providerAccountId).toBe(a.id);
    second.resolve(0); await until(() => queries.getTodoById(item.id)?.status === 'completed');
  });
  it.each(['test failed: permission denied', 'authentication failed', 'transport error', 'context exhausted', '429'])('does not rotate for ordinary/auth/ambiguous rejection: %s', async output => {
    const a = createAccount('a'); createAccount('b'); const p = profile(), item = todo(p.id), process = mockProcess(21001);
    const spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(process);
    await orchestrator.startTodo(item.id); process.stderr.write(output); process.resolve(1);
    await until(() => queries.getTodoById(item.id)?.status === 'failed'); expect(spy).toHaveBeenCalledTimes(1); expect(quota.getAccountQuotaState(a.id).state).toBe('unknown');
  });
  it('persists exclusions and enforces the hard failover budget across restart', () => {
    const a = createAccount('a'), b = createAccount('b'), p = profile(), item = todo(p.id);
    const round = queries.createExecutionRound(item.id, 'implementation', 1, 'run-a', { status: 'running', inputPayload: 'Create fixture' });
    const config = { ...(awaitConfig(a.id)), accountPolicy: 'automatic' as const };
    queries.updateTodoStatus(item.id, 'running'); vi.stubEnv('MAX_ACCOUNT_FAILOVERS_PER_PHASE', '1');
    const next = failover.prepareTodoQuotaRetry(item.id, round, config, { category: 'quota_exhausted', reason: 'usage limit reached' })!;
    quota.resetForTesting(); initDatabase(db); quota.markAccountUnknown(a.id);
    expect(failover.attemptedAccounts('todo', item.id, failover.quotaChain('todo', item.id))).toEqual([a.id]);
    queries.updateTodoStatus(item.id, 'running'); queries.updateExecutionRound(next.id, { status: 'running' });
    expect(failover.prepareTodoQuotaRetry(item.id, next, { ...config, providerAccountId: b.id }, { category: 'quota_exhausted', reason: 'usage limit reached' })).toBeNull();
    expect(queries.getTodoById(item.id)?.status).toBe('failed'); expect(queries.getExecutionRoundsByTodoId(item.id)).toHaveLength(2);
  });
  it.each(['review', 'rework'] as const)('retries only the current %s phase and retains earlier completed history', async phase => {
    const a = createAccount('a'), b = createAccount('b'), p = profile(), item = todo(p.id, true);
    const implementation = queries.createExecutionRound(item.id, 'implementation', 1, 'implementation', { status: 'completed', inputPayload: 'Create fixture' });
    if (phase === 'rework') queries.createExecutionRound(item.id, 'review', 2, 'review', { status: 'completed', inputPayload: 'Review fixture' });
    const source = queries.createExecutionRound(item.id, phase, queries.getNextExecutionRoundIndex(item.id), 'phase', { inputPayload: 'Inspect current fixture' });
    queries.updateTodo(item.id, { pipeline_phase: phase, review_baseline: '{"kind":"git","head":"fixture"}' });
    const first = mockProcess(22001), second = mockProcess(22002);
    const spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await orchestrator.startTodo(item.id); first.stderr.write('usage limit reached'); first.resolve(1);
    await until(() => spy.mock.calls.length === 2);
    const rounds = queries.getExecutionRoundsByTodoId(item.id);
    expect(queries.getExecutionRoundById(implementation.id)?.status).toBe('completed');
    expect(rounds.at(-1)).toMatchObject({ phase, retry_of_round_id: source.id, attempt_index: 2 });
    expect(JSON.parse(rounds.at(-1)!.execution_snapshot!).providerAccountId).toBe(b.id);
    expect(quota.getAccountQuotaState(a.id).state).toBe('exhausted');
    await orchestrator.stopTodo(item.id); second.resolve(0);
  });
  it('waits for quota on all accounts and wakes a previously untried account automatically', async () => {
    const a = createAccount('a'), b = createAccount('b'), p = profile(), item = todo(p.id);
    quota.markAccountExhausted(a.id, { source: 'runtime_rejection' }); quota.markAccountExhausted(b.id, { source: 'runtime_rejection' });
    const process = mockProcess(23001), spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(process);
    quota.setAvailabilityCallback(() => { void orchestrator.wakeWaitingQuota(); });
    await orchestrator.startTodo(item.id); expect(queries.getTodoById(item.id)).toMatchObject({ status: 'waiting_quota', process_pid: 0 });
    quota.markAccountUnknown(b.id); await until(() => spy.mock.calls.length === 1);
    expect((spy.mock.calls[0][2] as { providerAccountId: string }).providerAccountId).toBe(b.id);
    process.resolve(0); await until(() => queries.getTodoById(item.id)?.status === 'completed');
  });
  it('Stop wins while B admission is awaiting candidate evaluation', async () => {
    createAccount('a'); createAccount('b'); const p = profile(), item = todo(p.id), first = mockProcess(24001);
    const spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(first);
    await orchestrator.startTodo(item.id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(cliStatus.getToolStatus).mockImplementation(async tool => { await gate; return { tool, installed: true, version: 'synthetic' }; });
    first.stderr.write('usage limit reached'); first.resolve(1);
    await until(() => queries.getTodoById(item.id)?.status === 'pending');
    const stop = orchestrator.stopTodo(item.id); release(); await stop;
    await until(() => queries.getTodoById(item.id)?.status === 'stopped'); expect(spy).toHaveBeenCalledTimes(1);
  });
  it('never retries an account reset during the same A → B chain', async () => {
    const a = createAccount('a'); createAccount('b'); const p = profile(), item = todo(p.id);
    const first = mockProcess(24101), second = mockProcess(24102);
    const spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await orchestrator.startTodo(item.id); first.stderr.write('usage limit reached'); first.resolve(1);
    await until(() => spy.mock.calls.length === 2); quota.markAccountUnknown(a.id);
    second.stderr.write('usage limit reached'); second.resolve(1);
    await until(() => queries.getTodoById(item.id)?.status === 'waiting_quota'); expect(spy).toHaveBeenCalledTimes(2);
    await orchestrator.wakeWaitingQuota(); expect(spy).toHaveBeenCalledTimes(2);
    const evaluations = await executorPool.selectExecutor({ executionProfileId: p.id, excludedProviderAccountIds: failover.attemptedAccounts('todo', item.id, failover.quotaChain('todo', item.id)) });
    expect(evaluations.rejectionSummary).toContain('already_attempted_in_failover_chain');
  });
  it('unconfirmed old PID retains ownership and blocks retry intent', () => {
    const a = createAccount('a'); createAccount('b'); const p = profile(), item = todo(p.id);
    const round = queries.createExecutionRound(item.id, 'implementation', 1, 'owned', { status: 'running', inputPayload: 'Create fixture' });
    queries.updateTodoStatus(item.id, 'running'); queries.updateTodo(item.id, { process_pid: 999999 });
    expect(failover.prepareTodoQuotaRetry(item.id, round, awaitConfig(a.id), { category: 'quota_exhausted', reason: 'usage limit reached' })).toBeNull();
    expect(queries.getTodoById(item.id)?.process_pid).toBe(999999); expect(queries.getExecutionRoundsByTodoId(item.id)).toHaveLength(1);
    expect(db.prepare('SELECT * FROM account_failover_events').all()).toEqual([]);
  });
  it('interactive Session marks A exhausted without failover; resume stays pinned and rejects A quota even with healthy B', async () => {
    const a = createAccount('a'); createAccount('b'); const p = profile();
    const session = queries.createSession(project.id, 'Quota session', 'Create fixture', 'claude');
    queries.updateSession(session.id, { execution_profile_id: p.id });
    const process = mockProcess(24201), spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(process);
    await sessionManager.startSession(session.id);
    queries.appendSessionRawChunk(session.id, Buffer.from('usage limit reached')); process.resolve(1);
    await until(() => quota.getAccountQuotaState(a.id).state === 'exhausted');
    expect(spy).toHaveBeenCalledTimes(1); expect(JSON.parse(queries.getSessionById(session.id)!.execution_snapshot!).providerAccountId).toBe(a.id);
    await expect(sessionManager.startSession(session.id, { continueSession: true })).rejects.toThrow('quota exhausted');
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('restart with persisted retry intent resumes exactly one B attempt and duplicate failure callbacks are inert', async () => {
    const a = createAccount('a'), b = createAccount('b'), p = profile(), item = todo(p.id);
    const round = queries.createExecutionRound(item.id, 'implementation', 1, 'run-before-crash', { status: 'running', inputPayload: 'Create fixture' });
    queries.updateTodoStatus(item.id, 'running');
    const next = failover.prepareTodoQuotaRetry(item.id, round, awaitConfig(a.id), { category: 'quota_exhausted', reason: 'usage limit reached' });
    expect(failover.prepareTodoQuotaRetry(item.id, round, awaitConfig(a.id), { category: 'quota_exhausted', reason: 'usage limit reached' })).toBeNull();
    quota.resetForTesting(); initDatabase(db); quota.initialize();
    const process = mockProcess(25001), spy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(process);
    await Promise.all([orchestrator.startTodo(item.id), orchestrator.startTodo(item.id)]);
    expect(spy).toHaveBeenCalledTimes(1); expect((spy.mock.calls[0][2] as { providerAccountId: string }).providerAccountId).toBe(b.id);
    expect(queries.getActiveExecutionRound(item.id)?.id).toBe(next?.id); expect(queries.getExecutionRoundsByTodoId(item.id)).toHaveLength(2);
    process.resolve(0); await until(() => queries.getTodoById(item.id)?.status === 'completed');
  });
  it('Orchestrator fails over without consuming events, duplicating a child, or spending another planning turn', async () => {
    const a = createAccount('a'), b = createAccount('b'), p = profile();
    const parent = store.createOrchestration(project.id, { title: 'Quota primary', objective: 'Create utility', primary_execution_profile_id: p.id, max_turns: 1 });
    const calls: string[] = [], children: unknown[] = [], contexts: string[] = [];
    const mutation = { idempotency_key: 'same-child', title: 'Create fixture', instructions: 'Create fixture and tests', execution_profile_id: p.id };
    vi.spyOn(orchestrator, 'startTodo').mockResolvedValue(undefined);
    const service = new OrchestratorAgentService(async input => {
      calls.push(input.config.providerAccountId!); contexts.push(input.context);
      let resolve!: (value: { code: number; output: string; error: string }) => void;
      const exit = new Promise<{ code: number; output: string; error: string }>(done => { resolve = done; });
      setImmediate(() => { void (async () => {
        children.push(await callTool(input.orchestratorId, input.turnId, 'delegate_task', mutation));
        if (input.config.providerAccountId === a.id) resolve({ code: 1, output: '', error: 'usage limit reached' });
        else {
          expect(store.events(parent.id).every(event => !event.consumed_at)).toBe(true);
          await callTool(parent.id, input.turnId, 'yield', { idempotency_key: 'yield-once', reason: 'Wait', state_summary: '', current_plan: '', wake_on: { any: [{ type: 'user_message' }] } });
          resolve({ code: 0, output: '{}', error: '' });
        }
      })(); });
      return { pid: 0, exit, revoke: async () => undefined };
    }); services.push(service);
    await service.initialize(); await service.start(parent.id);
    await until(() => store.getOrchestration(parent.id).status === 'waiting_event');
    expect(calls).toEqual([a.id,b.id]); expect(children[0]).toEqual(children[1]); expect(store.children(parent.id)).toHaveLength(1);
    expect(store.getOrchestration(parent.id).turn_count).toBe(1); expect(store.turns(parent.id).map(turn => turn.status)).toEqual(['failed','completed']);
    expect(contexts[1]).toContain('quota was exhausted'); expect(quota.getAccountQuotaState(a.id).state).toBe('exhausted'); expect(quota.getAccountQuotaState(b.id).state).toBe('available');
  });
});

function awaitConfig(id: string) {
  return { cliTool: 'claude' as const, source: 'manual' as const, model: 'fixture', effectiveModel: 'fixture', requestedModel: 'fixture', modelAvailability: 'available' as const,
    providerAccountId: id, accountPolicy: 'automatic' as const, effort: { resolution: 'provider-default' as const, supportedEfforts: null }, warnings: [], resolvedAt: new Date().toISOString() };
}
