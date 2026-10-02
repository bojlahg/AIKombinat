import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../../db/schema.js';
import { parseOptions, installProcessEvidence, captureReviewStartHashes } from '../../../../scripts/evaluation-campaign-real-ai-support.js';
import { bootstrapProfiles } from '../../../../scripts/evaluation-campaign-disposable-bootstrap.js';

let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
vi.mock('../cli-status.js', () => ({ getToolStatus: vi.fn(async () => ({ installed: true, usable: true, version: 'synthetic' })) }));
const q = await import('../../db/queries.js');
const sync = await import('../model-sync.js');
const accounts = await import('../provider-account-service.js');
const { providerQuotaService } = await import('../provider-quota.js');
const { getToolStatus } = await import('../cli-status.js');
const args = ['--bootstrap-disposable', '--bootstrap-provider=claude', '--implementation-model=current', '--review-model=current'];

describe('disposable campaign bootstrap without inference', () => {
  beforeEach(() => {
    db = new Database(':memory:'); initDatabase(db);
    const refresh = sync.refreshModelCatalog;
    vi.spyOn(sync, 'refreshModelCatalog').mockImplementation((tool, options) => refresh(tool, { ...options, discover: async () => ({
      models: [{ value: 'current', label: 'Current', supportedEfforts: ['high'] }], source: 'synthetic', authoritative: false, primarySucceeded: true,
    }) }));
    vi.spyOn(accounts, 'probeProviderAccount').mockImplementation(async id => { accounts.setAccountHealth(id, 'available'); return accounts.getProviderAccount(id)!; });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  it('persists review PID without nested connection reads and captures the actual config hash outside the trigger', async () => {
    installProcessEvidence(db);
    const project = q.createProject('Smoke', process.cwd(), 'main');
    const todo = q.createTodo(project.id, 'Synthetic');
    const round = q.createExecutionRound(todo.id, 'review', 2, 'synthetic-run', { status: 'running' });
    expect(() => db.prepare('UPDATE todos SET process_pid=42,process_identity=? WHERE id=?').run(JSON.stringify({ pid: 42 }), todo.id)).not.toThrow();
    expect(db.prepare('SELECT pid,round_id FROM smoke_processes').get()).toEqual({ pid: 42, round_id: round.id });
    const { hashReviewExperimentConfig } = await import('../evaluation-campaign-definition.js');
    captureReviewStartHashes(db, id => hashReviewExperimentConfig(q.getTodoById(id)!));
    const original = hashReviewExperimentConfig(q.getTodoById(todo.id)!);
    expect(db.prepare('SELECT hash FROM smoke_review_hashes').get()).toEqual({ hash: original });
    q.updateTodo(todo.id, { max_review_rounds: 2 });
    captureReviewStartHashes(db, id => hashReviewExperimentConfig(q.getTodoById(id)!));
    expect(db.prepare('SELECT hash FROM smoke_review_hashes').get()).toEqual({ hash: original });
  });
  it('ignores stale production profiles, creates ready profiles and selects exact candidates without reservations', async () => {
    const old = q.addModel('claude', 'old', 'Old');
    const source = q.createExecutionProfile({ slug: 'source', name: 'Source', description: '', executors: [{ cli_model_id: old.id, effort_value: null, priority: 0 }] });
    const before = q.getExecutionProfileById(source.id);
    const evidence: Record<string, any> = {};
    const result = await bootstrapProfiles(parseOptions(args), evidence);
    expect(q.getExecutionProfileById(source.id)).toEqual(before);
    expect(result.implementation.executors).toHaveLength(1);
    expect(result.reviewer.executors).toHaveLength(1);
    expect(evidence.preflight.profiles.map((profile: any) => profile.health)).toEqual(['ready', 'ready']);
    expect(evidence.preflight.selections.map((selection: any) => selection.candidateId)).toEqual([result.implementation.executors[0].id, result.reviewer.executors[0].id]);
    expect(evidence.preflight.reservationCount).toBe(0);
    expect(evidence.preflight.selections[0].config.effort.resolution).toBe('provider-default');
    expect(sync.refreshModelCatalog).toHaveBeenCalledWith('claude', expect.objectContaining({ explicitRefresh: true }));
  });
  it('rejects retained available rows and provider model mismatch', async () => {
    q.addModel('claude', 'old', 'Old'); q.addModel('codex', 'foreign', 'Foreign');
    for (const value of ['old', 'foreign']) await expect(bootstrapProfiles(parseOptions(args.map(arg => arg === '--review-model=current' ? `--review-model=${value}` : arg)), {}))
      .rejects.toMatchObject({ status: 'CONFIG_ERROR', reason: 'exact_model_not_current' });
  });
  it('rejects unsupported effort', async () => {
    await expect(bootstrapProfiles(parseOptions([...args, '--review-effort=invalid']), {})).rejects.toMatchObject({ status: 'CONFIG_ERROR', reason: 'effort_unsupported' });
  });
  it('skips unavailable accounts before profile creation', async () => {
    vi.mocked(accounts.probeProviderAccount).mockImplementation(async id => { accounts.setAccountHealth(id, 'auth_error'); return accounts.getProviderAccount(id)!; });
    await expect(bootstrapProfiles(parseOptions(args), {})).rejects.toMatchObject({ reason: 'provider_account_unavailable' });
    expect(q.getExecutionProfiles()).toHaveLength(0);
  });
  it('skips unavailable CLI', async () => {
    vi.mocked(getToolStatus).mockResolvedValueOnce({ tool: 'claude', installed: false, version: null });
    await expect(bootstrapProfiles(parseOptions(args), {})).rejects.toMatchObject({ reason: 'cli_unavailable' });
  });
  it('requires primary discovery success even when a retained model exists', async () => {
    q.addModel('claude', 'current', 'Current');
    vi.mocked(sync.refreshModelCatalog).mockResolvedValueOnce({ models: [{ value: 'current', label: 'Current' }],
      source: 'synthetic-failed', primarySucceeded: false, authoritative: false });
    await expect(bootstrapProfiles(parseOptions(args), {})).rejects.toMatchObject({ reason: 'discovery_unavailable' });
    expect(q.getExecutionProfiles()).toHaveLength(0);
  });
  it('blocks known exhaustion and permits unknown quota', async () => {
    const quota = vi.spyOn(providerQuotaService, 'getAccountQuotaState');
    const unknown = providerQuotaService.getAccountQuotaState(accounts.listProviderAccounts()[0].id);
    quota.mockReturnValue({ ...unknown, state: 'exhausted' });
    await expect(bootstrapProfiles(parseOptions(args), {})).rejects.toMatchObject({ reason: 'quota_exhausted' });
    db.prepare("DELETE FROM execution_profile_executors WHERE profile_id IN (SELECT id FROM execution_profiles WHERE slug LIKE 'smoke-bootstrap-%')").run();
    db.prepare("DELETE FROM execution_profiles WHERE slug LIKE 'smoke-bootstrap-%'").run();
    quota.mockReturnValue({ ...unknown, state: 'unknown' });
    await expect(bootstrapProfiles(parseOptions(args), {})).resolves.toHaveProperty('implementation');
  });
});
