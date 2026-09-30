import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';
import { initDatabase } from '../../db/schema.js';
import { createChildEnvironment } from '../../utils/child-environment.js';
import { redactString, registerScopedLogSecret } from '../../logging/redact.js';
import { AccountOutputRedactor } from '../account-output-redactor.js';

let db: Database.Database;
let workspace: TestWorkspace;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
vi.mock('../cli-status.js', () => ({ getToolStatus: async (tool: string) => ({ tool, installed: true, version: 'test' }) }));
const accounts = await import('../provider-account-service.js');
const queries = await import('../../db/queries.js');
const { ExecutorPool } = await import('../executor-pool.js');
const { executionSnapshot, launchSelection, resolveExecutionConfig } = await import('../execution-config.js');

describe('Provider Accounts V1', () => {
  beforeEach(() => { workspace = createTestWorkspace('provider-accounts'); db = new Database(':memory:'); initDatabase(db); });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); workspace.cleanup(); });
  const create = (slug: string, max = 1) => accounts.saveProviderAccount({ provider: 'claude', slug, label: slug,
    auth_strategy: 'environment_reference', auth_config: { variable: `ACCOUNT_${slug.toUpperCase()}` }, max_concurrency: max });
  function profile(policy: 'automatic' | 'fixed' | 'inherited_default', id?: string, tool: 'claude' | 'opencode' = 'claude') {
    const model = queries.addModel(tool, tool === 'opencode' ? 'test/model' : 'test-model', 'Test model', null);
    return queries.createExecutionProfile({ slug: `profile-${Math.random()}`, name: 'Test', description: '',
      executors: [{ cli_model_id: model.id, effort_value: null, priority: 0, account_policy: policy, provider_account_id: id }] });
  }
  function disableDefault() {
    const account = accounts.listProviderAccounts().find(account => account.provider === 'claude' && account.auth_strategy === 'inherited')!;
    accounts.saveProviderAccount({ is_enabled: false }, account.id);
  }
  it('preserves compatibility IDs and old history across repeated startup', () => {
    const ids = accounts.listProviderAccounts().map(account => account.id).sort();
    const project = queries.createProject('Migration', workspace.createSubdir('migration'));
    const todo = queries.createTodo(project.id, 'History');
    const saved = '{"agent":"claude","model":"legacy"}';
    queries.updateTodo(todo.id, { execution_snapshot: saved });
    const existingProfile = profile('inherited_default');
    initDatabase(db);
    expect(accounts.listProviderAccounts().map(account => account.id).sort()).toEqual(ids);
    expect(queries.getTodoById(todo.id)?.execution_snapshot).toBe(saved);
    expect(queries.getExecutionProfileById(existingProfile.id)?.executors[0].account_policy).toBe('inherited_default');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('validates immutable identity, uniqueness, strategies, references and bounds', () => {
    const account = create('a');
    expect(() => create('a')).toThrow();
    expect(() => accounts.saveProviderAccount({ slug: 'changed' }, account.id)).toThrow('immutable');
    expect(() => accounts.saveProviderAccount({ max_concurrency: 33 }, account.id)).toThrow();
    expect(() => accounts.saveProviderAccount({ auth_config: { variable: 'SESSION_SECRET' } }, account.id)).toThrow();
    expect(() => accounts.saveProviderAccount({ auth_config: { variable: 'ACCOUNT_A', value: 'secret' } }, account.id)).toThrow();
    expect(() => accounts.saveProviderAccount({ provider: 'opencode', slug: 'x', label: 'x' })).toThrow();
    expect(() => accounts.saveProviderAccount({ provider: 'codex', slug: 'x', label: 'x', auth_strategy: 'environment_reference', auth_config: { variable: 'ACCOUNT_A' } })).toThrow();
    accounts.deleteProviderAccount(account.id);
    expect(accounts.getProviderAccount(account.id)).toBeUndefined();
  });
  it('preserves history labels while edits invalidate health', () => {
    const account = create('a'); accounts.setAccountHealth(account.id, 'available');
    const snapshot = executionSnapshot(resolveExecutionConfig({ cliTool: 'claude', providerAccountId: account.id }));
    accounts.saveProviderAccount({ label: 'Renamed', auth_config: { variable: 'ROTATED_KEY' } }, account.id);
    expect(snapshot.providerAccountLabel).toBe('a');
    expect(accounts.getProviderAccount(account.id)).toMatchObject({ health_state: 'unknown', last_health_at: null });
  });
  it('automatic ordering prefers available and skips disabled/auth-error accounts', async () => {
    disableDefault(); const a = create('a'), b = create('b');
    accounts.setAccountHealth(b.id, 'available');
    const p = profile('automatic'), pool = new ExecutorPool();
    expect((await pool.selectExecutor({ executionProfileId: p.id })).selectedConfig?.providerAccountId).toBe(b.id);
    accounts.setAccountHealth(b.id, 'auth_error');
    expect((await pool.selectExecutor({ executionProfileId: p.id })).selectedConfig?.providerAccountId).toBe(a.id);
    accounts.saveProviderAccount({ is_enabled: false }, a.id);
    expect((await pool.selectExecutor({ executionProfileId: p.id })).status).toBe('no_candidates');
  });
  it('fixed disabled account never falls back and profile reference blocks deletion', async () => {
    const a = create('a'), p = profile('fixed', a.id), pool = new ExecutorPool();
    accounts.saveProviderAccount({ is_enabled: false }, a.id);
    expect((await pool.selectExecutor({ executionProfileId: p.id })).status).toBe('no_candidates');
    expect(() => accounts.deleteProviderAccount(a.id)).toThrow('in use');
    accounts.saveProviderAccount({ is_enabled: true }, a.id);
    expect((await pool.selectExecutor({ executionProfileId: p.id })).selectedConfig?.providerAccountId).toBe(a.id);
  });
  it('atomic admissions enforce account caps and provider aggregate cap', async () => {
    disableDefault(); const a = create('a'), b = create('b', 2); const p = profile('automatic');
    const pool = new ExecutorPool(); pool.setLimit('claude', 3);
    const results = await Promise.all(['one','two','three','four'].map(reserveOwnerId => pool.selectExecutor({ executionProfileId: p.id, reserveOwnerId })));
    expect(results.map(result => result.status)).toEqual(['selected','selected','selected','waiting_executor']);
    expect(pool.getActiveAccountUsage(a.id)).toBe(1); expect(pool.getActiveAccountUsage(b.id)).toBe(2);
    const onRelease = vi.fn(); pool.setAvailabilityCallback(onRelease); pool.releaseReservation('two', true); await Promise.resolve(); expect(onRelease).toHaveBeenCalledOnce();
    expect((await pool.selectExecutor({ executionProfileId: p.id, reserveOwnerId: 'four' })).status).toBe('selected');
    pool.resetReservations(); pool.setLimit('claude', 2);
    const capped = await Promise.all(['one','two','three'].map(reserveOwnerId => pool.selectExecutor({ executionProfileId: p.id, reserveOwnerId })));
    expect(capped.filter(result => result.status === 'selected')).toHaveLength(2);
  });
  it('counts unresolved PID owners regardless of status and does not double-count reservations', async () => {
    const account = create('a'), p = profile('fixed', account.id), project = queries.createProject('Usage', workspace.createSubdir('usage'));
    const todo = queries.createTodo(project.id, 'Retained');
    queries.updateTodo(todo.id, { process_pid: 12345, execution_snapshot: JSON.stringify({ agent: 'claude', providerAccountId: account.id }) });
    const pool = new ExecutorPool();
    expect(pool.getActiveAccountUsage(account.id)).toBe(1);
    expect((await pool.selectExecutor({ executionProfileId: p.id, reserveOwnerId: 'other' })).status).toBe('waiting_executor');
    expect(() => accounts.deleteProviderAccount(account.id)).toThrow('in use');
  });
  it('OpenCode stays accountless', async () => {
    const pool = new ExecutorPool(); const p = profile('inherited_default', undefined, 'opencode');
    const result = await pool.selectExecutor({ executionProfileId: p.id, reserveOwnerId: 'open' });
    expect(executionSnapshot(result.selectedConfig!)).toMatchObject({ providerAccountId: null, accountPolicy: null });
  });
  it('maps references only near launch, sanitizes server secrets and redacts split credentials', async () => {
    const account = create('a');
    vi.stubEnv('ACCOUNT_A', 'private-test-credential'); vi.stubEnv('SESSION_SECRET', 'server-secret');
    vi.stubEnv('AUTH_PASSWORD', 'server-password'); vi.stubEnv('TUNNEL_TOKEN', 'server-tunnel');
    const runtime = accounts.buildAccountRuntime(account.id); const env = createChildEnvironment(runtime.env);
    expect(env.ANTHROPIC_API_KEY).toBe('private-test-credential');
    expect(env.SESSION_SECRET).toBeUndefined(); expect(env.AUTH_PASSWORD).toBeUndefined(); expect(env.TUNNEL_TOKEN).toBeUndefined();
    expect(env.ACCOUNT_A).toBeUndefined();
    expect(JSON.stringify(accounts.getProviderAccount(account.id))).not.toContain('private-test-credential');
    const config = resolveExecutionConfig({ cliTool: 'claude', providerAccountId: account.id });
    expect(JSON.stringify(executionSnapshot(config))).not.toContain('ACCOUNT_A');
    expect(launchSelection(config).providerAccountId).toBe(account.id);
    const unregister = registerScopedLogSecret(runtime.secrets[0]);
    expect(redactString('private-test-credential')).not.toContain('private-test-credential'); unregister();
    for (let index = 1; index < runtime.secrets[0].length; index++) {
      const redactor = new AccountOutputRedactor(runtime.secrets);
      const output = redactor.write(runtime.secrets[0].slice(0, index)) + redactor.write(runtime.secrets[0].slice(index)) + redactor.write('', true);
      expect(output).toBe('***redacted***');
    }
    vi.stubEnv('ACCOUNT_A', 'rotated-private-credential');
    expect(accounts.buildAccountRuntime(account.id).env.ANTHROPIC_API_KEY).toBe('rotated-private-credential');
  });
  it('synthetic A/B processes stay isolated and pinned after disable', async () => {
    const a = create('a'), b = create('b'); vi.stubEnv('ACCOUNT_A', 'A-marker'); vi.stubEnv('ACCOUNT_B', 'B-marker');
    const launch = (id: string) => {
      const env = createChildEnvironment(accounts.buildAccountRuntime(id).env);
      const child = spawn(process.execPath, ['-e', "setTimeout(() => process.stdout.write(process.env.ANTHROPIC_API_KEY), 30)"], { env, windowsHide: true });
      return new Promise<string>((resolve, reject) => { let output = ''; child.stdout.on('data', part => output += part); child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error('Synthetic CLI failed'))); });
    };
    const output = launch(a.id); accounts.saveProviderAccount({ is_enabled: false }, a.id);
    expect(await output).toBe('A-marker'); expect(await launch(b.id)).toBe('B-marker');
  });
});
