import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { initDatabase } from '../../db/schema.js';
import { smokeProfileEligible } from '../../../../scripts/evaluation-campaign-real-ai-support.js';
let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
vi.mock('../cli-status.js', () => ({ getToolStatus: vi.fn(async (_tool: string, _cached?: boolean) => ({ installed: true, tool: 'claude', usable: true })) }));
const q = await import('../../db/queries.js');
const s = await import('../execution-profile-reconciliation.js');
const { refreshModelCatalog } = await import('../model-sync.js');
const { executorPool } = await import('../executor-pool.js');
const { getToolStatus } = await import('../cli-status.js');
const router = (await import('../../routes/execution-profiles.js')).default;
const campaigns = await import('../evaluation-campaign-service.js');
const { hashReviewExperimentConfig } = await import('../evaluation-campaign-definition.js');
const { saveReviewPolicy } = await import('../review-policy.js');
async function refresh(tool: 'claude' | 'codex', values: string[], authoritative = true, primarySucceeded = true) {
  await refreshModelCatalog(tool, { discover: async () => ({ models: values.map(value => ({ value, label: value, supportedEfforts: ['high', 'medium'] })),
    source: tool === 'claude' ? 'claude-documented' : 'codex-app-server', authoritative, primarySucceeded }) });
}
function fixture(tool: 'claude' | 'codex' = 'claude', values = ['claude-sonnet-old', 'claude-sonnet-current']) {
  const models = values.map(value => q.addModel(tool, value, value, ['high']));
  const profile = q.createExecutionProfile({ slug: 'test', name: 'Test', description: '', executors: models.map((model, priority) => ({ cli_model_id: model.id, effort_value: 'high', priority })) });
  return { models, profile };
}
function input(profile: q.ExecutionProfile, newModelId: string) {
  return { newModelId, expectedOldModelId: profile.executors[0].cli_model_id, expectedProfileUpdatedAt: profile.updated_at };
}
async function api(path: string, body?: unknown) {
  const app = express(); app.use(express.json()); app.use('/api', router); const server = app.listen(0);
  try {
    const address = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
describe('execution profile reconciliation', () => {
  beforeEach(() => { db = new Database(':memory:'); initDatabase(db); vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  it.each([0, 1])('keeps current plus stale usable in order %i without reservations', async staleIndex => {
    const { models, profile } = fixture('codex', ['old', 'current']);
    db.prepare("UPDATE cli_models SET source='cli' WHERE id=?").run(models[staleIndex].id);
    await refresh('codex', [models[1 - staleIndex].model_value]);
    const result = (await s.reconcileExecutionProfiles()).profiles[0];
    expect(result.health).toBe('degraded'); expect(result.usable).toBe(true);
    const selected = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selected.selectedCandidate?.id).toBe(profile.executors[1 - staleIndex].id);
    expect(smokeProfileEligible(result.candidates.map(candidate => ({ enabled: candidate.enabled, current: candidate.catalogState === 'current', runtimeState: candidate.runtimeState, authorized: true })))).toBe(true);
    expect(executorPool.getReservations()).toEqual([]);
  });
  it('derives ready, unknown, blocked and disabled', async () => {
    const { models, profile } = fixture('codex', ['old', 'current']);
    await refresh('codex', ['old', 'current']); expect((await s.reconcileExecutionProfiles()).profiles[0].health).toBe('ready');
    await refresh('codex', [], false, false); expect((await s.reconcileExecutionProfiles()).profiles[0].health).toBe('unknown');
    db.prepare("UPDATE cli_models SET source='cli' WHERE id IN (?,?)").run(...models.map(model => model.id));
    await refresh('codex', ['different']); const blocked = (await s.reconcileExecutionProfiles()).profiles[0];
    expect(blocked.health).toBe('blocked'); expect(blocked.usable).toBe(false);
    expect(smokeProfileEligible(blocked.candidates.map(candidate => ({ enabled: true, current: false, runtimeState: candidate.runtimeState, authorized: true })))).toBe(false);
    q.updateExecutionProfile(profile.id, { is_enabled: 0 }); expect((await s.reconcileExecutionProfiles()).profiles[0].health).toBe('disabled');
  });
  it('weak and failed omissions do not create stale; refresh never mutates profiles', async () => {
    const { models, profile } = fixture(); const before = JSON.stringify(db.prepare('SELECT * FROM execution_profile_executors').all());
    await refresh('claude', [models[1].model_value], false);
    expect((await s.reconcileExecutionProfiles()).profiles[0].candidates.map(candidate => candidate.catalogState)).toEqual(['unconfirmed', 'current']);
    const id = s.getProviderRefreshMetadata()[0].refreshId;
    await refresh('claude', [models[0].model_value], false); expect(s.getProviderRefreshMetadata()[0].refreshId).not.toBe(id);
    await refresh('claude', [], false, false); expect((await s.reconcileExecutionProfiles()).profiles[0].health).toBe('unknown');
    expect(JSON.stringify(db.prepare('SELECT * FROM execution_profile_executors').all())).toBe(before);
    expect(q.getExecutionProfileById(profile.id)?.updated_at).toBe(profile.updated_at);
  });
  it('reports disabled, orphaned, provider mismatch, effort, account and variant errors', () => {
    const { models, profile } = fixture(); const c = profile.executors[0];
    const assess = (change: Partial<q.ExecutionProfileExecutor>) => s.assessExecutionCandidate({ ...c, ...change }, models[0], undefined);
    expect(assess({ is_enabled: 0 }).catalogState).toBe('disabled');
    expect(s.assessExecutionCandidate(c, undefined, undefined).catalogState).toBe('orphaned');
    expect(assess({ cli_tool: 'codex' }).catalogReasonCode).toBe('provider_mismatch');
    expect(assess({ effort_value: 'max' }).catalogReasonCode).toBe('effort_unsupported');
    expect(assess({ account_policy: 'fixed', provider_account_id: 'missing' }).catalogState).toBe('invalid');
    expect(s.assessExecutionCandidate({ ...c, cli_tool: 'antigravity' }, { ...models[0], cli_tool: 'antigravity', provider_variants: '{"medium":"variant"}' }, undefined).catalogReasonCode).toBe('invalid_provider_variant');
  });
  it('suggestions are exact-first, Claude-family related, same-provider only and bounded', async () => {
    const { profile } = fixture(); await refresh('claude', ['claude-sonnet-old', 'claude-sonnet-new', 'claude-opus-new', ...Array.from({ length: 12 }, (_, index) => `alternative-${index}`)], false);
    await refresh('codex', ['claude-sonnet-old']);
    const suggestions = s.buildModelReplacementSuggestions(profile.executors[0], Object.values(q.getAllModels()).flat(), s.getProviderRefreshMetadata()[0]);
    expect(suggestions).toHaveLength(10); expect(suggestions[0].reasonCode).toBe('exact_identity'); expect(suggestions[1].reasonCode).toBe('same_family');
    expect(suggestions.every(item => q.getModelById(item.modelId)?.cli_tool === 'claude')).toBe(true);
    expect(s.assessEffort({ ...q.getModelById(suggestions[0].modelId)!, supported_efforts: null }, 'high')).toMatchObject({ valid: true, state: 'capability_unknown' });
  });
  it('rebind preserves other fields, audits snapshots and leaves resolved history unchanged', async () => {
    const { profile } = fixture(); await refresh('claude', ['replacement'], false); const model = q.getModelByValue('claude', 'replacement')!;
    const selectedBefore = await executorPool.selectExecutor({ executionProfileId: profile.id });
    const project = q.createProject('History', '/tmp/history');
    const todo = q.createTodo(project.id, 'Running', '', 0);
    const snapshot = JSON.stringify(selectedBefore.selectedConfig);
    db.prepare("UPDATE todos SET status='running',execution_snapshot=?,execution_profile_id=? WHERE id=?").run(snapshot, profile.id, todo.id);
    s.rebindExecutionCandidate(profile.id, profile.executors[0].id, input(profile, model.id));
    const c = q.getExecutionProfileById(profile.id)!.executors[0];
    expect(c).toMatchObject({ cli_model_id: model.id, effort_value: 'high', account_policy: 'inherited_default', provider_account_id: null, priority: 0, is_enabled: 1 });
    expect(db.prepare('SELECT * FROM execution_profile_rebind_audit').get()).toMatchObject({ old_model_value: 'claude-sonnet-old', new_model_value: 'replacement', old_effort: 'high', new_effort: 'high', source: 'manual_api' });
    expect(selectedBefore.selectedConfig?.model).toBe('claude-sonnet-old');
    expect(q.getTodoById(todo.id)?.execution_snapshot).toBe(snapshot);
    db.prepare("UPDATE todos SET status='completed' WHERE id=?").run(todo.id);
    expect((await executorPool.selectExecutor({ executionProfileId: profile.id })).selectedConfig?.model).toBe('replacement');
    expect(() => s.rebindExecutionCandidate(profile.id, c.id, input(profile, model.id))).toThrow('reconciliation_stale');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('rolls the candidate and profile timestamp back on audit insert failure', async () => {
    const { profile } = fixture(); await refresh('claude', ['replacement'], false);
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON execution_profile_rebind_audit BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    expect(() => s.rebindExecutionCandidate(profile.id, profile.executors[0].id, input(profile, q.getModelByValue('claude', 'replacement')!.id))).toThrow('injected failure');
    expect(q.getExecutionProfileById(profile.id)).toEqual(profile); expect(db.prepare('SELECT * FROM execution_profile_rebind_audit').all()).toEqual([]);
  });
  it('requires effort choice, accepts provider-default, and rejects cross-provider', async () => {
    const { profile } = fixture(); await refresh('claude', ['replacement'], false); await refresh('codex', ['other']);
    const model = q.getModelByValue('claude', 'replacement')!; q.updateModel(model.id, { supported_efforts: ['medium'] });
    const rebind = (change = {}) => s.rebindExecutionCandidate(profile.id, profile.executors[0].id, { ...input(profile, model.id), ...change });
    expect(() => rebind()).toThrow('effort_required'); expect(() => rebind({ newEffort: 'max' })).toThrow('effort_unsupported');
    expect(() => rebind({ newModelId: q.getModelByValue('codex', 'other')!.id })).toThrow('provider_mismatch');
    rebind({ newEffort: 'provider-default' }); expect(q.getExecutionProfileById(profile.id)!.executors[0].effort_value).toBeNull();
  });
  it('GET requests evaluate cache-only and return stable ownership/concurrency errors', async () => {
    const { profile } = fixture(); await refresh('claude', ['replacement'], false);
    expect((await api('/execution-profiles/reconciliation')).status).toBe(200);
    expect(vi.mocked(getToolStatus).mock.calls.every(call => call[1] === true)).toBe(true);
    expect((await api(`/execution-profiles/${profile.id}/reconciliation`)).body.profile.id).toBe(profile.id);
    expect((await api('/execution-profiles/missing/reconciliation')).body.error).toBe('profile_not_found');
    expect(await api(`/execution-profiles/${profile.id}/executors/${profile.executors[0].id}/rebind`, { ...input(profile, 'missing'), expectedOldModelId: 'changed' })).toMatchObject({ status: 409, body: { error: 'reconciliation_stale' } });
    expect(await api(`/execution-profiles/${profile.id}/executors/missing/rebind`, {})).toMatchObject({ status: 404, body: { error: 'candidate_not_found' } });
  });
  it('running campaign confirmation preserves ordinary configuration drift detection', async () => {
    const { profile } = fixture(); await refresh('claude', ['replacement'], false);
    const project = q.createProject('Campaign', '/tmp/campaign');
    const policy = saveReviewPolicy({ name: 'Policy', members: [0, 1].map(priority => ({ execution_profile_id: profile.id, label: 'Reviewer', priority })) });
    const campaign = campaigns.saveEvaluationCampaign(project.id, { name: 'Campaign', arms: [
      { name: 'Single', is_control: 1, weight: 1, sort_order: 0, review_mode: 'single', review_profile_id: profile.id },
      { name: 'Consensus', is_control: 0, weight: 1, sort_order: 1, review_mode: 'consensus', review_policy_id: policy.id },
    ] });
    campaigns.transitionEvaluationCampaign(campaign.id, project.id, 'start');
    expect(s.getProfileReferences()(profile.id)).toMatchObject({ runningCampaigns: [{ id: campaign.id }], reviewPolicies: [{ id: policy.id }] });
    const config = { review_mode: 'single' as const, review_profile_id: profile.id, review_policy_id: null, rework_profile_id: null, max_review_rounds: 2 };
    const before = hashReviewExperimentConfig(config);
    const rebind = () => s.rebindExecutionCandidate(profile.id, profile.executors[0].id, input(profile, q.getModelByValue('claude', 'replacement')!.id));
    expect(rebind).toThrow('active_campaign_impact');
    s.rebindExecutionCandidate(profile.id, profile.executors[0].id, { ...input(profile, q.getModelByValue('claude', 'replacement')!.id), confirmActiveCampaignImpact: true });
    expect(hashReviewExperimentConfig(config)).not.toBe(before);
  });
  it('migration is idempotent and leaves profile rows untouched', () => {
    const { profile } = fixture(); initDatabase(db); initDatabase(db); expect(q.getExecutionProfileById(profile.id)).toEqual(profile); expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('discovery exceptions leave old rows unconfirmed without mutating profiles', async () => {
    const { profile } = fixture(); await refresh('claude', ['claude-sonnet-old'], false);
    await expect(refreshModelCatalog('claude', { discover: async () => { throw new Error('discovery failed'); } })).rejects.toThrow('discovery failed');
    expect((await s.reconcileExecutionProfiles()).profiles[0].health).toBe('unknown');
    expect(q.getExecutionProfileById(profile.id)).toEqual(profile);
  });
  it('reports unknown runtime with a cold cache and evaluates cache-only', async () => {
    fixture(); vi.mocked(getToolStatus).mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never);
    expect((await s.reconcileExecutionProfiles()).profiles[0].candidates.every(candidate => candidate.runtimeState === 'unknown')).toBe(true);
    expect(vi.mocked(getToolStatus).mock.calls.every(call => call[1] === true)).toBe(true);
  });
  it('preserves fixed account, disabled candidate and nonzero priority through repair', async () => {
    const { profile } = fixture(); await refresh('claude', ['replacement'], false);
    const account = db.prepare("SELECT id FROM provider_accounts WHERE provider='claude'").get() as { id: string };
    db.prepare("UPDATE execution_profile_executors SET account_policy='fixed',provider_account_id=?,priority=7,is_enabled=0 WHERE id=?").run(account.id, profile.executors[0].id);
    s.rebindExecutionCandidate(profile.id, profile.executors[0].id, input(profile, q.getModelByValue('claude','replacement')!.id));
    expect(q.getExecutionProfileById(profile.id)!.executors.find(candidate => candidate.id === profile.executors[0].id)).toMatchObject({ account_policy: 'fixed', provider_account_id: account.id, priority: 7, is_enabled: 0 });
    expect(s.assessExecutionCandidate({ ...profile.executors[0], account_policy: 'fixed', provider_account_id: 'wrong' }, q.getModelById(profile.executors[0].cli_model_id), undefined,
      [{ id: 'wrong', provider: 'codex', health_state: 'available', is_enabled: 1 }]).catalogState).toBe('invalid');
  });
});
