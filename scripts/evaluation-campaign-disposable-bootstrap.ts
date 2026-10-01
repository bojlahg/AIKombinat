import type { parseOptions } from './evaluation-campaign-real-ai-support.js';

export class BootstrapError extends Error {
  constructor(readonly status: 'CONFIG_ERROR' | 'SKIPPED_ENVIRONMENT', readonly reason: string) { super(reason); }
}

export async function bootstrapProfiles(options: ReturnType<typeof parseOptions>, evidence: Record<string, any>) {
  const q = await import('../src/server/db/queries.js');
  const { getToolStatus } = await import('../src/server/services/cli-status.js');
  const { refreshModelCatalog } = await import('../src/server/services/model-sync.js');
  const { accountCandidates, probeProviderAccount } = await import('../src/server/services/provider-account-service.js');
  const { assessEffort, getProviderRefreshMetadata, reconcileExecutionProfiles } = await import('../src/server/services/execution-profile-reconciliation.js');
  const { executorPool } = await import('../src/server/services/executor-pool.js');
  const { providerQuotaService } = await import('../src/server/services/provider-quota.js');
  const provider = options.bootstrapProvider as 'claude' | 'codex' | 'opencode';
  const config = evidence.bootstrap = { enabled: true, provider, implementationModel: options.implementationModel,
    reviewModel: options.reviewModel, implementationEffort: options.implementationEffort === 'provider-default' ? null : options.implementationEffort,
    reviewEffort: options.reviewEffort === 'provider-default' ? null : options.reviewEffort,
    accountPolicy: 'inherited_default', sourceProfileMutation: false };
  const preflight = evidence.preflight = { cli: await getToolStatus(provider) } as Record<string, any>;
  if (preflight.cli?.installed) preflight.cli.usable = preflight.cli.usable !== false;
  if (!preflight.cli?.installed || preflight.cli.usable === false) throw new BootstrapError('SKIPPED_ENVIRONMENT', 'cli_unavailable');
  const discovery = await refreshModelCatalog(provider, { version: preflight.cli.version ?? '', explicitRefresh: true });
  const refresh = getProviderRefreshMetadata().find(item => item.provider === provider)!;
  preflight.catalog = { source: discovery.source, primarySucceeded: discovery.primarySucceeded, authoritative: discovery.authoritative,
    refreshId: refresh.refreshId, modelValues: discovery.models.map(model => model.value) };
  if (!discovery.primarySucceeded) throw new BootstrapError('SKIPPED_ENVIRONMENT', 'discovery_unavailable');
  const models = q.getModelsByTool(provider, true);
  const exact = (value: string, effort: string | null) => {
    const model = models.find(model => model.model_value === value && model.status === 'available' && model.last_seen_refresh_id === refresh.refreshId);
    if (!model) throw new BootstrapError('CONFIG_ERROR', 'exact_model_not_current');
    if (!assessEffort(model, effort).valid) throw new BootstrapError('CONFIG_ERROR', 'effort_unsupported');
    return model;
  };
  const implementationModel = exact(config.implementationModel, config.implementationEffort);
  const reviewModel = exact(config.reviewModel, config.reviewEffort);
  if (provider !== 'opencode') {
    const accounts = accountCandidates(provider, 'inherited_default').filter(account => account.is_enabled);
    preflight.accounts = [];
    for (const account of accounts) {
      const probed = await probeProviderAccount(account.id);
      preflight.accounts.push({ id: probed.id, strategy: probed.auth_strategy, health: probed.health_state,
        quota: providerQuotaService.getAccountQuotaState(probed.id).state });
    }
    if (!preflight.accounts.some((account: any) => account.health === 'available')) throw new BootstrapError('SKIPPED_ENVIRONMENT', 'provider_account_unavailable');
  } else if (![implementationModel, reviewModel].every(model => /(?:-free(?:#|$)|^(?:ollama|lmstudio)\/)/i.test(model.model_value))) {
    throw new BootstrapError('CONFIG_ERROR', 'opencode_requires_free_local_model');
  }
  const create = (role: string, model: typeof implementationModel, effort: string | null) => {
    const base = `smoke-bootstrap-${role}`;
    let slug = base, suffix = 2;
    while (q.getExecutionProfileBySlug(slug)) slug = `${base}-${suffix++}`;
    return q.createExecutionProfile({ slug, name: `Smoke Bootstrap ${role === 'implementation' ? 'Implementation' : 'Reviewer'}`, description: 'Disposable acceptance only',
      executors: [{ cli_model_id: model.id, effort_value: effort, priority: 0, is_enabled: 1, account_policy: 'inherited_default', provider_account_id: null }],
    });
  };
  const implementation = create('implementation', implementationModel, config.implementationEffort);
  const reviewer = create('reviewer', reviewModel, config.reviewEffort);
  Object.assign(config, { implementationProfileId: implementation.id, reviewerProfileId: reviewer.id,
    implementationCandidateId: implementation.executors[0].id, reviewerCandidateId: reviewer.executors[0].id });
  preflight.selections = [];
  for (const profile of [implementation, reviewer]) {
    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id, allowedCliTools: [provider] });
    preflight.selections.push({ profileId: profile.id, status: selection.status, candidateId: selection.selectedCandidate?.id,
      evaluations: selection.evaluations, config: selection.selectedConfig });
    if (selection.status !== 'selected') throw new BootstrapError('SKIPPED_ENVIRONMENT', selection.status === 'waiting_quota' ? 'quota_exhausted' : 'provider_account_unavailable');
    if (selection.selectedCandidate?.id !== profile.executors[0].id) throw new BootstrapError('CONFIG_ERROR', 'unexpected_candidate');
  }
  const reconciliation = await reconcileExecutionProfiles();
  preflight.profiles = reconciliation.profiles.filter(profile => [implementation.id, reviewer.id].includes(profile.id));
  if (preflight.profiles.length !== 2 || preflight.profiles.some((profile: any) => profile.health !== 'ready'
    || profile.candidates.some((candidate: any) => candidate.catalogState !== 'current' || candidate.repairKind !== 'none'))) {
    throw new BootstrapError('CONFIG_ERROR', 'bootstrap_profile_not_ready');
  }
  preflight.reservationCount = executorPool.getReservations().length;
  if (preflight.reservationCount !== 0) throw new BootstrapError('CONFIG_ERROR', 'preflight_reserved_executor');
  const { saveReviewPolicy } = await import('../src/server/services/review-policy.js');
  const policy = saveReviewPolicy({ name: 'Disposable bootstrap unanimous', strategy: 'unanimous', failure_policy: 'require_all', max_parallel_reviewers: 2,
    members: [0, 1].map(priority => ({ label: `Reviewer ${priority + 1}`, execution_profile_id: reviewer.id, priority })) });
  return { implementation, reviewer, policy };
}
