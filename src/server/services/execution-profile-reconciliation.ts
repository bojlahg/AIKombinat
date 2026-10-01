import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import * as queries from '../db/queries.js';
import { executorPool, type CandidateEvaluation } from './executor-pool.js';
import { broadcaster } from '../websocket/broadcaster.js';

export type CatalogState = 'current' | 'unconfirmed' | 'stale' | 'invalid' | 'orphaned' | 'disabled';
export type ProfileHealth = 'ready' | 'degraded' | 'unknown' | 'blocked' | 'disabled';
export interface ProviderRefresh {
  provider: string; refreshId: string | null; source: string | null; authoritative: boolean;
  primarySucceeded: boolean; lastRefreshedAt: string | null; modelsSeen: number;
}
type Account = { id: string; provider: string; health_state: string; is_enabled: number };
function parse<T>(value: string | null, fallback: T): T {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
export function assessEffort(model: queries.CliModel, configured: string | null) {
  const raw = parse<unknown>(model.supported_efforts, null);
  const supported = Array.isArray(raw) && raw.every(value => typeof value === 'string') ? raw as string[] : null;
  const variants = parse<Record<string, string> | null>(model.provider_variants, null);
  const effort = configured === 'provider-default' ? null : configured;
  let reasonCode = !effort ? 'provider_default' : supported ? 'effort_supported' : 'capability_unknown';
  if (model.cli_tool === 'opencode' && effort) reasonCode = 'effort_unsupported';
  else if (model.cli_tool === 'antigravity') {
    if (variants && Object.keys(variants).length) {
      if (!effort) reasonCode = 'effort_required';
      else if (supported && !supported.includes(effort)) reasonCode = 'effort_unsupported';
      else if (typeof variants[effort] !== 'string' || !variants[effort]) reasonCode = 'invalid_provider_variant';
    }
  } else if (effort && supported && !supported.includes(effort)) reasonCode = 'effort_unsupported';
  return { configured, supported, state: reasonCode, valid: !['effort_unsupported', 'effort_required', 'invalid_provider_variant'].includes(reasonCode) };
}
export function assessExecutionCandidate(candidate: queries.ExecutionProfileExecutor, model: queries.CliModel | undefined,
  refresh: ProviderRefresh | undefined, accounts: readonly Account[] = []) {
  const policy = candidate.account_policy ?? 'inherited_default';
  const fixed = accounts.find(account => account.id === candidate.provider_account_id);
  const invalidAccount = !['inherited_default', 'automatic', 'fixed'].includes(policy)
    || (policy === 'fixed' ? !fixed || fixed.provider !== candidate.cli_tool : !!candidate.provider_account_id)
    || (candidate.cli_tool === 'opencode' && (policy !== 'inherited_default' || !!candidate.provider_account_id));
  const effort = model ? assessEffort(model, candidate.effort_value) : { configured: candidate.effort_value, supported: null, state: 'capability_unknown', valid: true };
  let catalogState: CatalogState = 'unconfirmed', catalogReasonCode = 'refresh_unconfirmed';
  if (!candidate.is_enabled) { catalogState = 'disabled'; catalogReasonCode = 'candidate_disabled'; }
  else if (!model) { catalogState = 'orphaned'; catalogReasonCode = 'model_not_found'; }
  else if (model.cli_tool !== candidate.cli_tool) { catalogState = 'invalid'; catalogReasonCode = 'provider_mismatch'; }
  else if (invalidAccount) { catalogState = 'invalid'; catalogReasonCode = 'invalid_account_policy'; }
  else if (!effort.valid) { catalogState = 'invalid'; catalogReasonCode = effort.state; }
  else if (refresh?.primarySucceeded && refresh.refreshId && model.last_seen_refresh_id === refresh.refreshId && model.status === 'available') {
    catalogState = 'current'; catalogReasonCode = 'latest_refresh_seen';
  } else if (refresh?.primarySucceeded && refresh.authoritative) { catalogState = 'stale'; catalogReasonCode = 'authoritative_omission'; }
  else if (model.status === 'missing' && refresh?.primarySucceeded) { catalogState = 'stale'; catalogReasonCode = 'model_missing'; }
  else catalogReasonCode = refresh?.primarySucceeded ? 'weak_omission' : 'refresh_unconfirmed';
  return { candidateId: candidate.id, priority: candidate.priority, enabled: !!candidate.is_enabled, provider: candidate.cli_tool,
    currentModel: model ? { id: model.id, value: model.model_value, label: model.model_label, status: model.status, source: model.source, lastSeenAt: model.last_seen_at } : null,
    catalogState, catalogReasonCode, effort,
    account: { policy, accountId: candidate.provider_account_id ?? null, state: invalidAccount ? 'invalid' : fixed?.health_state ?? 'runtime_managed' } };
}
export function assessExecutionProfile(enabled: boolean, candidates: Array<{ catalogState: CatalogState; runtimeState?: string }>): ProfileHealth {
  if (!enabled) return 'disabled';
  const active = candidates.filter(candidate => candidate.catalogState !== 'disabled');
  if (active.some(candidate => candidate.catalogState === 'current'))
    return active.some(candidate => ['stale', 'invalid', 'orphaned'].includes(candidate.catalogState)) ? 'degraded' : 'ready';
  return active.some(candidate => candidate.catalogState === 'unconfirmed') ? 'unknown' : 'blocked';
}
function family(provider: string, value: string) {
  return provider === 'claude' ? /(?:^|-)(opus|sonnet|haiku|fable)(?:-|$)/i.exec(value)?.[1]?.toLowerCase() : undefined;
}
export function buildModelReplacementSuggestions(candidate: queries.ExecutionProfileExecutor, models: readonly queries.CliModel[], refresh?: ProviderRefresh) {
  return models.filter(model => model.cli_tool === candidate.cli_tool && model.status === 'available' && !model.superseded_by_model_id
    && refresh?.primarySucceeded && !!refresh.refreshId && model.last_seen_refresh_id === refresh.refreshId)
    .map(model => {
      const tier = model.model_value === candidate.model_value ? 'exact_identity'
        : family(candidate.cli_tool, candidate.model_value) && family(candidate.cli_tool, candidate.model_value) === family(model.cli_tool, model.model_value) ? 'same_family' : 'other_current';
      return { modelId: model.id, modelValue: model.model_value, label: model.model_label, reasonCode: tier,
        confidence: tier === 'exact_identity' ? 'exact' : tier === 'same_family' ? 'related' : 'alternative', requiresEffortChoice: !assessEffort(model, candidate.effort_value).valid };
    }).sort((a, b) => ['exact_identity', 'same_family', 'other_current'].indexOf(a.reasonCode) - ['exact_identity', 'same_family', 'other_current'].indexOf(b.reasonCode)
      || a.modelValue.localeCompare(b.modelValue)).slice(0, 10);
}
export function getProviderRefreshMetadata(): ProviderRefresh[] {
  const rows = getDatabase().prepare('SELECT * FROM cli_versions').all() as Array<Record<string, any>>;
  return ['claude', 'codex', 'antigravity', 'opencode'].map(provider => {
    const row = rows.find(item => item.cli_tool === provider);
    return { provider, refreshId: row?.last_refresh_id ?? null, source: row?.last_source ?? null, authoritative: row?.last_authoritative === 1,
      primarySucceeded: row?.last_primary_succeeded === 1, lastRefreshedAt: row?.last_refreshed_at ?? null, modelsSeen: row?.models_seen ?? 0 };
  });
}
export function getProfileReferences() {
  const db = getDatabase();
  const policies = db.prepare(`SELECT DISTINCT p.id,p.name,m.execution_profile_id AS profileId FROM review_policies p JOIN review_policy_members m ON m.review_policy_id=p.id
    UNION SELECT id,name,judge_execution_profile_id FROM review_policies WHERE judge_execution_profile_id IS NOT NULL`).all() as Array<{ id: string; name: string; profileId: string }>;
  const campaigns = db.prepare(`SELECT DISTINCT c.id,c.name,a.review_profile_id,a.rework_profile_id,a.review_policy_id
    FROM evaluation_campaigns c JOIN evaluation_campaign_arms a ON a.campaign_id=c.id WHERE c.status='running'`).all() as Array<{ id: string; name: string; review_profile_id: string | null; rework_profile_id: string | null; review_policy_id: string | null }>;
  const implementations = db.prepare(`SELECT DISTINCT c.id,c.name,t.execution_profile_id AS profileId FROM evaluation_campaigns c
    JOIN evaluation_campaign_assignments a ON a.campaign_id=c.id JOIN todos t ON t.id=a.todo_id
    WHERE c.status='running' AND t.execution_profile_id IS NOT NULL`).all() as Array<{ id: string; name: string; profileId: string }>;
  return (profileId: string) => {
    const reviewPolicies = policies.filter(item => item.profileId === profileId).map(({ id, name }) => ({ id, name }));
    const runningCampaigns = [...campaigns.filter(item => item.review_profile_id === profileId || item.rework_profile_id === profileId
      || reviewPolicies.some(policy => policy.id === item.review_policy_id)), ...implementations.filter(item => item.profileId === profileId)]
      .filter((item, index, list) => list.findIndex(other => other.id === item.id) === index).map(({ id, name }) => ({ id, name }));
    return { reviewPolicies, runningCampaigns };
  };
}
export async function reconcileExecutionProfiles(options: { cachedOnly?: boolean } = {}) {
  const db = getDatabase(), providers = getProviderRefreshMetadata();
  const models = Object.values(queries.getAllModels(true)).flat();
  const modelMap = new Map(models.map(model => [model.id, model]));
  const accounts = db.prepare('SELECT id,provider,health_state,is_enabled FROM provider_accounts').all() as Account[];
  const rows = db.prepare('SELECT * FROM execution_profiles ORDER BY sort_order,name').all() as queries.ExecutionProfile[];
  const executors = db.prepare(`SELECT e.*,m.cli_tool,m.model_value,m.model_label,m.status AS model_status,m.supported_efforts,m.provider_variants
    FROM execution_profile_executors e LEFT JOIN cli_models m ON m.id=e.cli_model_id ORDER BY e.priority,e.created_at`).all() as queries.ExecutionProfileExecutor[];
  const references = getProfileReferences();
  const profiles = await Promise.all(rows.map(async profile => {
    const candidates = await Promise.all(executors.filter(candidate => candidate.profile_id === profile.id).map(async candidate => {
      const refresh = providers.find(provider => provider.provider === candidate.cli_tool);
      const assessment = assessExecutionCandidate(candidate, modelMap.get(candidate.cli_model_id), refresh, accounts);
      let runtime: CandidateEvaluation | undefined;
      if (candidate.cli_tool && modelMap.has(candidate.cli_model_id)) runtime = await executorPool.evaluateCandidate(candidate, { cachedOnly: options.cachedOnly ?? true });
      const runtimeState = runtime?.reason === 'runtime_unconfirmed' ? 'unknown' : runtime?.status ?? 'invalid';
      return { ...assessment, runtimeState, runtimeReasonCode: runtimeState === 'unknown' ? 'runtime_unconfirmed' : `runtime_${runtimeState}`,
        suggestions: buildModelReplacementSuggestions(candidate, models, refresh) };
    }));
    const refs = references(profile.id);
    return { id: profile.id, name: profile.name, updatedAt: profile.updated_at, health: assessExecutionProfile(!!profile.is_enabled, candidates),
      usable: !!profile.is_enabled && candidates.some(candidate => candidate.enabled && candidate.runtimeState === 'available'),
      candidates, references: refs, runningCampaignReferences: refs.runningCampaigns, reviewPolicyReferences: refs.reviewPolicies };
  }));
  const summary = { profiles: profiles.length, ready: 0, degraded: 0, unknown: 0, blocked: 0, disabled: 0 };
  profiles.forEach(profile => summary[profile.health]++);
  return { generatedAt: new Date().toISOString(), providers, summary, profiles };
}
export class RebindError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export interface RebindInput {
  newModelId: string; newEffort?: string | null; expectedOldModelId: string; expectedProfileUpdatedAt: string;
  confirmActiveCampaignImpact?: boolean; source?: 'manual_ui' | 'manual_api';
}
export function rebindExecutionCandidate(profileId: string, candidateId: string, input: RebindInput) {
  const db = getDatabase();
  const result = db.transaction(() => {
    const profile = db.prepare('SELECT * FROM execution_profiles WHERE id=?').get(profileId) as queries.ExecutionProfile | undefined;
    if (!profile) throw new RebindError('profile_not_found', 404);
    const candidate = db.prepare('SELECT * FROM execution_profile_executors WHERE id=? AND profile_id=?').get(candidateId, profileId) as queries.ExecutionProfileExecutor | undefined;
    if (!candidate) throw new RebindError('candidate_not_found', 404);
    if (candidate.cli_model_id !== input.expectedOldModelId || profile.updated_at !== input.expectedProfileUpdatedAt) throw new RebindError('reconciliation_stale', 409);
    const oldModel = queries.getModelById(candidate.cli_model_id), newModel = queries.getModelById(input.newModelId);
    if (!newModel) throw new RebindError('model_not_found', 404);
    if (!oldModel) throw new RebindError('model_not_found', 404);
    if (oldModel.cli_tool !== newModel.cli_tool) throw new RebindError('provider_mismatch');
    const refresh = getProviderRefreshMetadata().find(provider => provider.provider === newModel.cli_tool);
    if (newModel.status !== 'available' || !refresh?.primarySucceeded || !refresh.refreshId || newModel.last_seen_refresh_id !== refresh.refreshId) throw new RebindError('reconciliation_stale', 409);
    if (input.newEffort !== undefined && input.newEffort !== null && (typeof input.newEffort !== 'string' || !input.newEffort.trim())) throw new RebindError('effort_unsupported');
    const chosenEffort = typeof input.newEffort === 'string' ? input.newEffort.trim() : input.newEffort;
    const effort = chosenEffort === undefined ? candidate.effort_value : chosenEffort === 'provider-default' ? null : chosenEffort;
    const assessment = assessEffort(newModel, effort);
    if (!assessment.valid) throw new RebindError(input.newEffort === undefined || assessment.state === 'effort_required' ? 'effort_required' : 'effort_unsupported');
    const references = getProfileReferences()(profileId);
    if (references.runningCampaigns.length && input.confirmActiveCampaignImpact !== true) throw new RebindError('active_campaign_impact', 409);
    const now = new Date(Math.max(Date.now(), Date.parse(profile.updated_at) + 1)).toISOString();
    db.prepare('UPDATE execution_profile_executors SET cli_model_id=?,effort_value=?,updated_at=? WHERE id=?').run(newModel.id, effort, now, candidate.id);
    db.prepare(`INSERT INTO execution_profile_rebind_audit(id,profile_id,executor_candidate_id,provider,old_model_id,old_model_value,old_model_label,
      new_model_id,new_model_value,new_model_label,old_effort,new_effort,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), profileId, candidate.id, oldModel.cli_tool, oldModel.id, oldModel.model_value, oldModel.model_label,
        newModel.id, newModel.model_value, newModel.model_label, candidate.effort_value, effort, input.source === 'manual_ui' ? 'manual_ui' : 'manual_api', now);
    db.prepare('UPDATE execution_profiles SET updated_at=? WHERE id=?').run(now, profileId);
    return { profileId, candidateId, updatedAt: now };
  })();
  broadcaster.broadcast({ type: 'execution-profile:updated', profileId });
  return result;
}
