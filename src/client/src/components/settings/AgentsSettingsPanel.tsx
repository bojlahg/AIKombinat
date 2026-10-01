import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import * as profilesApi from '../../api/executionProfiles';
import { type ProviderQuotaState, type CliToolStatus } from '../../api/cli-status';

import type { WsEvent } from '../../hooks/useWebSocket';

import ProviderAccountsPanel from './ProviderAccountsPanel';
import ProviderAccountPicker from '../ProviderAccountPicker';
import { getReconciliation, countNeedsAttention, type Reconciliation, type ReconciledCandidate, type ReconciledProfile } from '../../api/reconciliation';
import ProfileRepairModal from './ProfileRepairModal';
import ProfileRecreateModal from './ProfileRecreateModal';

type Tool = profilesApi.AgentCliTool;
type Model = {
  id: string; value: string; label: string; status: 'available' | 'missing'; source: 'cli' | 'manual';
  supportedEfforts: string[] | null; providerVariants?: Record<string, string> | null; sortOrder: number; lastSeenAt: string | null; lastCheckedAt: string | null;
  lastSeenRefreshId?: string | null;
};
type RefreshResult = { source: string; authoritative: boolean; added: number; updated: number; restored: number; markedMissing: number };

const AGENTS: Array<{ value: Tool; label: string }> = [
  { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'antigravity', label: 'Antigravity' }, { value: 'opencode', label: 'OpenCode' },
];
const FALLBACK_EFFORTS: Record<Tool, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: [],
  opencode: [],
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

const sameModelDraft = (left: Model, right?: Model) => !!right
  && left.label === right.label
  && JSON.stringify(left.supportedEfforts) === JSON.stringify(right.supportedEfforts)
  && left.sortOrder === right.sortOrder;

const VALID_TOOLS: ReadonlySet<string> = new Set<Tool>(['claude', 'codex', 'antigravity']);
const VALID_STATES: ReadonlySet<string> = new Set(['available', 'exhausted', 'unknown']);

export interface AgentsSettingsPanelProps {
  onEvent?: (cb: (event: WsEvent) => void) => () => void;
}

export default function AgentsSettingsPanel({ onEvent }: AgentsSettingsPanelProps = {}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'profiles' | 'models' | 'accounts'>('profiles');
  const [models, setModels] = useState<Record<string, Model[]>>({});
  const [savedModels, setSavedModels] = useState<Record<string, Model[]>>({});
  const [quotas, setQuotas] = useState<Record<string, ProviderQuotaState>>({});
  const [cliStatuses, setCliStatuses] = useState<CliToolStatus[]>([]);
  const [profiles, setProfiles] = useState<profilesApi.ExecutionProfile[]>([]);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Record<Tool, boolean>>({ claude: false, codex: false, antigravity: false, opencode: false });
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState<Tool | null>(null);
  const [saving, setSaving] = useState<Tool | null>(null);
  const [refreshResults, setRefreshResults] = useState<Partial<Record<Tool, RefreshResult | 'failed'>>>({});
  const [error, setError] = useState('');
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [repair, setRepair] = useState<{ profile: ReconciledProfile; candidate: ReconciledCandidate } | null>(null);
  const [attention, setAttention] = useState(0);
  const [recreate, setRecreate] = useState<{ profile: ReconciledProfile; candidate: ReconciledCandidate } | null>(null);
  const accountControls = useRef(new Map<string, HTMLSelectElement>());
  const effortControls = useRef(new Map<string, HTMLSelectElement>());
  const [focusTarget, setFocusTarget] = useState<{ id: string; kind: 'account' | 'effort' } | null>(null);
  useEffect(() => {
    if (!focusTarget || tab !== 'profiles') return;
    const control = (focusTarget.kind === 'account' ? accountControls : effortControls).current.get(focusTarget.id);
    if (control) {
      document.getElementById(`execution-candidate-${focusTarget.id}`)?.scrollIntoView({ block: 'center' });
      control.focus(); setFocusTarget(null);
    }
  }, [focusTarget, expandedProfileId, tab, profiles]);
  const loadHealth = async () => {
    const next = await getReconciliation();
    if (!Array.isArray(next.profiles)) return;
    setAttention(countNeedsAttention(next));
    setReconciliation(next);
  };
  const reloadAfterRepair = async () => {
    setProfiles(await profilesApi.getProfiles(true));
    await loadHealth();
  };

  useEffect(() => {
    if (!onEvent) return;
    return onEvent((event) => {
      if (event.type === 'model-catalog:updated' || event.type === 'execution-profile:updated') {
        void loadHealth().catch(() => setError(t('reconciliation.error.reconciliation_failed')));
        if (event.type === 'execution-profile:updated') void profilesApi.getProfiles(true).then(setProfiles).catch(() => {});
        void json<Record<string, Model[]>>('/api/models').then(setSavedModels).catch(() => {});
      }
      if (event.type === 'quota:updated') {
        const tool = event.tool;
        const state = event.state;
        if (!tool || !VALID_TOOLS.has(tool) || !state || !VALID_STATES.has(state)) {
          return;
        }

        const validTool = tool as ProviderQuotaState['tool'];
        const validState = state as ProviderQuotaState['state'];

        setQuotas((prev) => {
          const existing = prev[validTool];
          let reason: string | null = null;
          let resetAt: string | null = null;

          if (validState === 'exhausted') {
            reason = event.reason !== undefined ? (event.reason ?? null) : (existing?.reason ?? null);
            resetAt = event.resetAt !== undefined ? (event.resetAt ?? null) : (existing?.resetAt ?? null);
          } else if (validState === 'unknown') {
            reason = event.reason !== undefined ? (event.reason ?? null) : null;
            resetAt = null;
          } else if (validState === 'available') {
            reason = null;
            resetAt = null;
          }

          const updated: ProviderQuotaState = {
            tool: validTool,
            state: validState,
            source: event.source ?? existing?.source ?? 'websocket',
            observedAt: new Date().toISOString(),
            reason,
            resetAt,
          };
          return {
            ...prev,
            [validTool]: updated,
          };
        });
      }
    });
  }, [onEvent]);

  useEffect(() => {
    Promise.all([
      json<Record<string, Model[]>>('/api/models'),
      profilesApi.getProfiles(true),
      json<ProviderQuotaState[]>('/api/cli/quota').catch(() => [] as ProviderQuotaState[]),
      json<CliToolStatus[]>('/api/cli/status').catch(() => [] as CliToolStatus[]),
    ])
      .then(([catalog, executionProfiles, quotaList, statuses]) => {
        setCliStatuses(Array.isArray(statuses) ? statuses : []);
        setModels(catalog);
        setSavedModels(catalog);
        setProfiles(executionProfiles);
        const quotaMap: Record<string, ProviderQuotaState> = {};
        if (Array.isArray(quotaList)) {
          for (const q of quotaList) quotaMap[q.tool] = q;
        }
        setQuotas(quotaMap);
        setExpandedProfileId(executionProfiles[0]?.id ?? null);
        void loadHealth().catch(() => setError(t('reconciliation.error.reconciliation_failed')));
      })
      .catch((e) => setError(String(e))).finally(() => setBusy(false));
  }, []);

  const dirtyIds = useMemo(() => Object.fromEntries(AGENTS.map(({ value }) => [value, new Set(
    (models[value] ?? []).filter((model) => !sameModelDraft(model, (savedModels[value] ?? []).find((saved) => saved.id === model.id))).map((model) => model.id),
  )])) as Record<Tool, Set<string>>, [models, savedModels]);

  const refresh = async (tool: Tool) => {
    if (dirtyIds[tool].size > 0) {
      const agent = AGENTS.find((item) => item.value === tool)!;
      if (!window.confirm(t('catalog.refreshDirtyConfirm').replace('{agent}', agent.label))) return;
    }
    setRefreshing(tool); setError('');
    try {
      const result = await json<RefreshResult>(`/api/models/refresh/${tool}`, { method: 'POST' });
      const catalog = await json<Record<string, Model[]>>('/api/models');
      setModels((current) => ({ ...current, [tool]: catalog[tool] ?? [] }));
      setSavedModels((current) => ({ ...current, [tool]: catalog[tool] ?? [] }));
      setRefreshResults((current) => ({ ...current, [tool]: result }));
      await loadHealth();
    } catch (e) {
      setError(String(e)); setRefreshResults((current) => ({ ...current, [tool]: 'failed' }));
    } finally { await loadHealth().catch(() => {}); setRefreshing(null); }
  };

  const addModel = async (tool: Tool) => {
    const value = window.prompt(t('catalog.modelId'))?.trim();
    if (!value) return;
    const label = window.prompt(t('catalog.label'), value)?.trim();
    if (!label) return;
    const efforts = window.prompt(t('catalog.effortsPrompt'), '');
    try {
      const model = await json<Model>('/api/models', { method: 'POST', body: JSON.stringify({ cliTool: tool, modelValue: value, modelLabel: label, supportedEfforts: efforts?.split(',').map((item) => item.trim()).filter(Boolean) || null }) });
      setModels((current) => ({ ...current, [tool]: [...(current[tool] ?? []), model] }));
      setSavedModels((current) => ({ ...current, [tool]: [...(current[tool] ?? []), model] }));
    } catch (e) { setError(String(e)); }
  };

  const saveAgentModels = async (tool: Tool) => {
    const dirty = (models[tool] ?? []).filter((model) => dirtyIds[tool].has(model.id));
    if (!dirty.length) return;
    setSaving(tool); setError('');
    const results = await Promise.allSettled(dirty.map((model) => json<Model>(`/api/models/${model.id}`, {
      method: 'PATCH', body: JSON.stringify({ modelLabel: model.label, supportedEfforts: model.supportedEfforts, sortOrder: model.sortOrder }),
    })));
    const saved = results.flatMap((result, index) => {
      if (result.status !== 'fulfilled') return [];
      const draft = dirty[index];
      const baseline = (savedModels[tool] ?? []).find((model) => model.id === draft.id);
      const contentChanged = !baseline || draft.label !== baseline.label || JSON.stringify(draft.supportedEfforts) !== JSON.stringify(baseline.supportedEfforts);
      return [{ ...draft, source: contentChanged ? 'manual' as const : draft.source }];
    });
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [dirty[index].label] : []);
    setModels((current) => ({ ...current, [tool]: (current[tool] ?? []).map((model) => saved.find((item) => item.id === model.id) ?? model) }));
    setSavedModels((current) => ({ ...current, [tool]: (current[tool] ?? []).map((model) => saved.find((item) => item.id === model.id) ?? model) }));
    if (failed.length) setError(`${t('catalog.saveFailed')}: ${failed.join(', ')}`);
    setSaving(null);
  };

  const deleteModel = async (tool: Tool, model: Model) => {
    if (!window.confirm(`${t('catalog.deleteModel')} "${model.label}"?`)) return;
    try {
      await json(`/api/models/${model.id}`, { method: 'DELETE' });
      setModels((current) => ({ ...current, [tool]: (current[tool] ?? []).filter((item) => item.id !== model.id) }));
      setSavedModels((current) => ({ ...current, [tool]: (current[tool] ?? []).filter((item) => item.id !== model.id) }));
    } catch (e) { setError(String(e)); }
  };

  const updateModelDraft = (tool: Tool, id: string, change: Partial<Model>) => setModels((current) => ({
    ...current, [tool]: (current[tool] ?? []).map((model) => model.id === id ? { ...model, ...change } : model),
  }));
  const moveModel = (tool: Tool, index: number, direction: -1 | 1) => setModels((current) => {
    const next = index + direction;
    const ordered = [...(current[tool] ?? [])];
    if (next < 0 || next >= ordered.length) return current;
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    return { ...current, [tool]: ordered.map((model, sortOrder) => ({ ...model, sortOrder })) };
  });
  const replaceProfile = (profile: profilesApi.ExecutionProfile) => setProfiles((current) => current.map((item) => item.id === profile.id ? profile : item));
  const createProfile = async () => {
    try {
      const created = await profilesApi.createProfile({ name: t('profiles.newProfile'), description: '', isEnabled: true, sortOrder: profiles.length, executors: [] });
      setProfiles((current) => [...current, created]); setExpandedProfileId(created.id);
    } catch (e) { setError(String(e)); }
  };
  const saveProfile = async (profile: profilesApi.ExecutionProfile) => {
    if (reconciliation?.profiles.find(item => item.id === profile.id)?.candidates.some(candidate => !candidate.currentModel)) {
      setError(t('reconciliation.error.candidate_provider_unrecoverable')); return;
    }
    for (const executor of profile.executors ?? []) {
      const model = (models[executor.cliTool] ?? []).find((m) => m.id === executor.cliModelId);
      const isGrouped = executor.cliTool === 'antigravity' && !!model?.providerVariants && Object.keys(model.providerVariants).length > 0;
      if (isGrouped && (!executor.effortValue || !model?.supportedEfforts?.includes(executor.effortValue))) {
        setError(t('reconciliation.error.effort_required'));
        return;
      }
    }
    try {
      const saved = await profilesApi.updateProfile(profile.id, {
        name: profile.name, description: profile.description, isEnabled: profile.isEnabled, sortOrder: profile.sortOrder,
        executors: (profile.executors ?? []).map((executor, index) => ({ id: executor.id, cliModelId: executor.cliModelId, effortValue: executor.effortValue, accountPolicy: executor.accountPolicy ?? 'inherited_default', providerAccountId: executor.providerAccountId ?? null, priority: index, isEnabled: executor.isEnabled })),
      });
      replaceProfile(saved);
      await reloadAfterRepair();
    } catch (e) { setError(String(e)); }
  };
  const deleteProfile = async (profile: profilesApi.ExecutionProfile) => {
    if (!window.confirm(`${t('profiles.deleteProfile')} "${profile.name}"?`)) return;
    try { await profilesApi.deleteProfile(profile.id); setProfiles((current) => current.filter((item) => item.id !== profile.id)); }
    catch (e) { setError(String(e)); }
  };
  const addExecutor = (profile: profilesApi.ExecutionProfile) => {
    const tool = AGENTS.find((agent) => (models[agent.value] ?? []).some((model) => model.status === 'available'))?.value;
    const model = tool ? (models[tool] ?? []).find((item) => item.status === 'available') : undefined;
    if (!tool || !model) { setError(t('profiles.noModels')); return; }
    const isGrouped = tool === 'antigravity' && !!model.providerVariants && Object.keys(model.providerVariants).length > 0;
    const initialEffort = isGrouped ? (model.supportedEfforts?.[0] || 'medium') : null;
    replaceProfile({ ...profile, executors: [...(profile.executors ?? []), {
      id: `new-${Date.now()}`, cliModelId: model.id, cliTool: tool, modelValue: model.value, modelLabel: model.label, modelStatus: model.status,
      supportedEfforts: model.supportedEfforts, providerVariants: model.providerVariants, effortValue: initialEffort, priority: profile.executors?.length ?? 0, isEnabled: true,
    }] });
  };
  const changeExecutor = (profile: profilesApi.ExecutionProfile, index: number, change: Partial<profilesApi.ExecutionProfileExecutor>) => {
    const executors = [...(profile.executors ?? [])]; executors[index] = { ...executors[index], ...change }; replaceProfile({ ...profile, executors });
  };
  const removeExecutor = (profile: profilesApi.ExecutionProfile, index: number) => {
    const executor = profile.executors?.[index];
    if (!executor || !window.confirm(`${t('profiles.removeExecutor')} "${executor.cliTool} / ${executor.modelLabel} / ${executor.effortValue ?? t('profiles.providerDefault')}"?`)) return;
    replaceProfile({ ...profile, executors: profile.executors?.filter((_, itemIndex) => itemIndex !== index) });
  };
  const moveExecutor = (profile: profilesApi.ExecutionProfile, index: number, direction: -1 | 1) => {
    const next = index + direction; if (next < 0 || next >= (profile.executors?.length ?? 0)) return;
    const executors = [...(profile.executors ?? [])]; [executors[index], executors[next]] = [executors[next], executors[index]]; replaceProfile({ ...profile, executors });
  };

  const currentModels = Object.fromEntries(AGENTS.map(({ value }) => [value, (savedModels[value] ?? []).filter(model =>
    model.status === 'available' && !!model.lastSeenRefreshId && reconciliation?.providers.some(provider =>
      provider.provider === value && provider.primarySucceeded && provider.refreshId === model.lastSeenRefreshId))]));
  const runRepair = async (profile: ReconciledProfile, candidate: ReconciledCandidate) => {
    setTab('profiles'); setExpandedProfileId(profile.id);
    if (candidate.repairKind === 'account' || candidate.repairKind === 'effort') {
      setFocusTarget({ id: candidate.candidateId, kind: candidate.repairKind }); return;
    }
    try {
      const latest = await getReconciliation(); setAttention(countNeedsAttention(latest)); setReconciliation(latest);
      const current = latest.profiles.find(item => item.id === profile.id);
      const next = current?.candidates.find(item => item.candidateId === candidate.candidateId);
      if (!current || !next) return;
      if (next.repairKind === 'recreate') setRecreate({ profile: current, candidate: next });
      else if (next.repairKind === 'model' && next.currentModel && next.provider) setRepair({ profile: current, candidate: next });
      else if (next.repairKind === 'account' || next.repairKind === 'effort') setFocusTarget({ id: next.candidateId, kind: next.repairKind });
    } catch { setError(t('reconciliation.error.reconciliation_failed')); }
  };
  const repairAction = (profile: ReconciledProfile, candidate: ReconciledCandidate) => candidate.repairKind && candidate.repairKind !== 'none'
    && !['current', 'disabled'].includes(candidate.catalogState) && <button className="btn-secondary text-xs" onClick={() => void runRepair(profile, candidate)}>{t('reconciliation.action.' + candidate.repairKind)}</button>;

  if (busy) return <div className="flex justify-center p-12"><Loader2 className="animate-spin" /></div>;
  return <div className="space-y-5 p-5 sm:p-6">
    {attention > 0 && <p role="status" className="rounded-xl bg-status-warning/10 p-3 text-sm text-status-warning">{t('reconciliation.attention').replace('{count}', String(attention))}</p>}
    {repair && <ProfileRepairModal key={repair.candidate.candidateId} profile={repair.profile} candidate={repair.candidate}
      models={currentModels[repair.candidate.provider ?? ''] ?? []}
      onClose={() => setRepair(null)} onApplied={reloadAfterRepair} />}
    {recreate && <ProfileRecreateModal key={recreate.candidate.candidateId} profile={recreate.profile} candidate={recreate.candidate} models={currentModels} onClose={() => setRecreate(null)} onApplied={reloadAfterRepair} />}
    {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}
    <div className="flex border-b" role="tablist" style={{ borderColor: 'var(--color-border)' }}>
      {(['profiles', 'models', 'accounts'] as const).map((value) => <button key={value} role="tab" aria-selected={tab === value} className={`px-4 py-2.5 text-sm font-semibold ${tab === value ? 'border-b-2 text-primary-500' : 'text-warm-500'}`} onClick={() => setTab(value)}>{value === 'accounts' ? t('accounts.title') : t(`profiles.tab.${value}`)}</button>)}
    </div>

      {tab === 'accounts' && <ProviderAccountsPanel onEvent={onEvent} />}
      {tab === 'models' && <section className="space-y-4">
      <div><h2 className="text-lg font-semibold">{t('catalog.title')}</h2><p className="text-sm text-warm-500">{t('catalog.description')}</p></div>
      {reconciliation && <div className="rounded-xl bg-theme-surface-2 p-3 space-y-2"><h3 className="text-sm font-semibold">{t('reconciliation.needsAttention')}</h3>
        {reconciliation.profiles.flatMap(profile => profile.candidates.filter(candidate => ['stale', 'unconfirmed', 'orphaned', 'invalid'].includes(candidate.catalogState)).map(candidate =>
          <button key={candidate.candidateId} className="block text-left text-sm text-primary-500" onClick={() => void runRepair(profile, candidate)}>
            {profile.name} · {candidate.currentModel?.label ?? t('reconciliation.orphaned')} · {t('reconciliation.' + candidate.catalogState)} · {candidate.repairKind && candidate.repairKind !== 'none' ? t('reconciliation.action.' + candidate.repairKind) : t('reconciliation.viewProfiles')}
          </button>))}
      </div>}
      {AGENTS.map((agent) => {
        const agentModels = models[agent.value] ?? [];
        const collapsed = collapsedAgents[agent.value];
        const result = refreshResults[agent.value];
        return <div key={agent.value} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button className="flex items-center gap-2 text-left" aria-expanded={!collapsed} onClick={() => setCollapsedAgents((current) => ({ ...current, [agent.value]: !current[agent.value] }))}>
              {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              <span className="font-semibold">{agent.label}</span>
              {cliStatuses.find((status) => status.tool === agent.value) && <span className="text-xs text-warm-500">
                {(() => {
                  const status = cliStatuses.find((item) => item.tool === agent.value)!;
                  return `${status.installed && status.usable !== false ? t('catalog.cliReady') : t('catalog.cliUnavailable')}${status.version ? ` (${status.version})` : ''}`;
                })()}
              </span>}
              <span className="text-xs text-warm-500">{agentModels.length} {t('catalog.models')}</span>
              {(() => {
                if (agent.value === 'opencode') return null;
                const quota = quotas[agent.value];
                const quotaState = quota?.state ?? 'unknown';
                const quotaLabel = quotaState === 'available'
                  ? t('quota.state.available')
                  : quotaState === 'exhausted'
                    ? (quota?.resetAt
                        ? `${t('quota.state.exhausted')} (${t('quota.resetsAt').replace('{time}', new Date(quota.resetAt).toLocaleTimeString())})`
                        : t('quota.state.exhausted'))
                    : t('quota.state.unknown');
                return (
                  <span className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
                    quotaState === 'available'
                      ? 'bg-status-success/10 text-status-success'
                      : quotaState === 'exhausted'
                        ? 'bg-status-error/10 text-status-error'
                        : 'bg-warm-500/10 text-warm-500'
                  }`}>
                    {t('quota.title')}: {quotaLabel}
                  </span>
                );
              })()}
            </button>
            <div className="flex gap-2"><button className="btn-secondary flex items-center gap-1 text-xs" disabled={!!refreshing} onClick={() => refresh(agent.value)}><RefreshCw size={13} className={refreshing === agent.value ? 'animate-spin' : ''} />{t('catalog.refresh')}</button><button className="btn-secondary flex items-center gap-1 text-xs" onClick={() => addModel(agent.value)}><Plus size={13} />{t('catalog.addManual')}</button><button className="btn-secondary flex items-center gap-1 text-xs" disabled={!dirtyIds[agent.value].size || saving === agent.value} onClick={() => saveAgentModels(agent.value)}><Save size={13} />{t('common.save')}</button></div>
          </div>
          {result && <p className={`mt-2 text-xs ${result === 'failed' || !result.authoritative ? 'text-status-warning' : 'text-status-success'}`}>{result === 'failed' ? t('catalog.refreshFailed') : `${t('catalog.updated')}: ${result.updated} В· ${t('catalog.added')}: ${result.added} В· ${t('catalog.missingCount')}: ${result.markedMissing} В· ${t('catalog.source')}: ${result.source} В· ${result.authoritative ? t('catalog.authoritative') : t('catalog.partial')}`}</p>}
          {!collapsed && <div className="mt-3 space-y-2">{agentModels.map((model) => <div key={model.id} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[1.2fr_1.5fr_auto]" style={{ borderColor: 'var(--color-border)' }}>
            <div className="sm:col-span-3 text-xs text-theme-muted">{t('reconciliation.usedBy').replace('{count}', String(reconciliation?.profiles.reduce((count, profile) => count + profile.candidates.filter(candidate => candidate.currentModel?.id === model.id).length, 0) ?? 0))}
              {reconciliation?.profiles.filter(profile => profile.candidates.some(candidate => candidate.currentModel?.id === model.id)).map(profile => <button key={profile.id} className="ml-2 text-primary-500" onClick={() => { setTab('profiles'); setExpandedProfileId(profile.id); }}>{profile.name} · {t('reconciliation.viewProfiles')}</button>)}
            </div>
            <div><input aria-label={`${agent.label} ${model.value} ${t('catalog.label')}`} className="input-field text-sm" value={model.label} onChange={(e) => updateModelDraft(agent.value, model.id, { label: e.target.value })} /><p className="mt-1 text-2xs text-warm-500">{model.value} В· {model.source === 'manual' ? t('catalog.manual') : t('catalog.cli')}</p><p className="text-2xs text-warm-500">{t('catalog.lastSeen')}: {model.lastSeenAt ? new Date(model.lastSeenAt).toLocaleString() : t('catalog.never')}</p>{model.status === 'missing' && <p className="text-2xs text-status-warning">{t('catalog.missing')}</p>}</div>
            <input aria-label={`${agent.label} ${model.value} ${t('catalog.effortsPrompt')}`} className="input-field text-sm" value={model.supportedEfforts?.join(', ') ?? ''} placeholder={t('catalog.unknownEfforts')} onChange={(e) => updateModelDraft(agent.value, model.id, { supportedEfforts: e.target.value ? e.target.value.split(',').map((item) => item.trim()).filter(Boolean) : null })} />

                  <div className="flex items-center gap-1"><button title={t('catalog.moveUp')} disabled={agentModels.indexOf(model) === 0} onClick={() => moveModel(agent.value, agentModels.indexOf(model), -1)}><ArrowUp size={14} /></button><button title={t('catalog.moveDown')} disabled={agentModels.indexOf(model) === agentModels.length - 1} onClick={() => moveModel(agent.value, agentModels.indexOf(model), 1)}><ArrowDown size={14} /></button><button title={`${t('common.delete')} ${model.label}`} onClick={() => deleteModel(agent.value, model)}><Trash2 size={15} /></button></div>
          </div>)}</div>}
        </div>;
      })}
    </section>}

    {tab === 'profiles' && <section className="space-y-4">
      <div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{t('profiles.executionTitle')}</h2><p className="text-sm text-warm-500">{t('profiles.executionDescription')}</p></div><button className="btn-secondary flex items-center gap-1 text-xs" onClick={createProfile}><Plus size={14} />{t('profiles.new')}</button></div>
      {profiles.map((profile) => {
        const expanded = expandedProfileId === profile.id;
        const health = reconciliation?.profiles.find(item => item.id === profile.id);
        return <div key={profile.id} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
          <button className="flex w-full items-center gap-2 text-left" aria-expanded={expanded} onClick={() => setExpandedProfileId(expanded ? null : profile.id)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="font-semibold">{profile.name}</span><span className="text-xs text-warm-500">В· {(profile.executors ?? []).length} {t('profiles.executors')}</span></button>
          {health && <span className="mt-2 inline-block rounded-full bg-theme-surface-2 px-2 py-1 text-xs">{t('reconciliation.' + health.health)}</span>}
          {expanded && <div className="mt-3 space-y-3">
            {health && <div className="space-y-2">
              {['degraded', 'blocked', 'unknown'].includes(health.health) && <p className="text-sm text-theme-muted">{t('reconciliation.copy.' + health.health)}</p>}
            </div>}
            {health?.candidates.filter(candidate => !candidate.currentModel).map(candidate => <div id={`execution-candidate-${candidate.candidateId}`} key={candidate.candidateId} className="rounded-xl bg-theme-surface-2 p-3 space-y-2">
              <p>{t('reconciliation.missingModelReference')}</p>{repairAction(health, candidate)}
            </div>)}
            <input className="input-field text-sm" aria-label={t('profiles.name')} value={profile.name} onChange={(e) => replaceProfile({ ...profile, name: e.target.value })} />
            <textarea className="input-field min-h-20 text-sm" aria-label={t('profiles.profileDescription')} value={profile.description} onChange={(e) => replaceProfile({ ...profile, description: e.target.value })} />
            {!(profile.executors ?? []).some((executor) => executor.isEnabled && executor.modelStatus === 'available') && <p className="text-xs text-status-warning">{t('profiles.noEligible')}</p>}
            <div className="space-y-2">{(profile.executors ?? []).map((executor, index) => {
              const toolModels = models[executor.cliTool] ?? [];
              const selectedModel = toolModels.find((model) => model.id === executor.cliModelId);
              const selectableModels = toolModels.filter((model) => model.status === 'available' || model.id === executor.cliModelId);
              const efforts = selectedModel?.supportedEfforts ?? FALLBACK_EFFORTS[executor.cliTool] ?? [];
              const capabilitiesUnknown = executor.cliTool === 'antigravity' && selectedModel?.supportedEfforts == null;
              const unsupported = !!executor.effortValue && !!selectedModel?.supportedEfforts && !selectedModel.supportedEfforts.includes(executor.effortValue);
              const uncertain = !!executor.effortValue && capabilitiesUnknown;
              const effortValues = unsupported || uncertain ? [executor.effortValue!, ...efforts] : efforts;
              const candidateHealth = health?.candidates.find(item => item.candidateId === executor.id);
              return <div id={`execution-candidate-${executor.id}`} key={executor.id} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[auto_1fr_1.4fr_1fr_auto]" style={{ borderColor: 'var(--color-border)' }}>
                {candidateHealth && <div className="sm:col-span-5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-theme-surface-2 px-2 py-1">{t('reconciliation.' + candidateHealth.catalogState)}</span>
                  <span>{t('reconciliation.reason.' + candidateHealth.catalogReasonCode)}</span>
                  <span>{t('reconciliation.reason.' + candidateHealth.runtimeReasonCode)}</span>
                  {health && repairAction(health, candidateHealth)}
                </div>}
                <span className="self-center text-xs text-warm-500">{index + 1}</span>
                <select aria-label={`${t('profiles.agent')} ${index + 1}`} className="input-field text-sm" value={executor.cliTool} onChange={(e) => {
                  const tool = e.target.value as Tool;
                  const model = (models[tool] ?? []).find((item) => item.status === 'available');
                  if (model) {
                    const isGrouped = tool === 'antigravity' && !!model.providerVariants && Object.keys(model.providerVariants).length > 0;
                    const initialEffort = isGrouped ? (model.supportedEfforts?.[0] || 'medium') : null;
                    changeExecutor(profile, index, { cliTool: tool, accountPolicy: 'inherited_default', providerAccountId: null, cliModelId: model.id, modelValue: model.value, modelLabel: model.label, modelStatus: model.status, supportedEfforts: model.supportedEfforts, providerVariants: model.providerVariants, effortValue: initialEffort });
                  }
                }}>{AGENTS.map((agent) => <option key={agent.value} value={agent.value}>{agent.label}</option>)}</select>
                <select aria-label={`${t('catalog.title')} ${index + 1}`} className="input-field text-sm" value={executor.cliModelId} onChange={(e) => {
                  const model = selectableModels.find((item) => item.id === e.target.value);
                  if (model) {
                    const isGrouped = executor.cliTool === 'antigravity' && !!model.providerVariants && Object.keys(model.providerVariants).length > 0;
                    const initialEffort = isGrouped ? (model.supportedEfforts?.[0] || 'medium') : null;
                    changeExecutor(profile, index, { cliModelId: model.id, modelValue: model.value, modelLabel: model.label, modelStatus: model.status, supportedEfforts: model.supportedEfforts, providerVariants: model.providerVariants, effortValue: initialEffort });
                  }
                }}>{selectableModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.status === 'missing' ? ` (${t('catalog.missingShort')})` : ''}</option>)}</select>
                <div>
                  <select ref={node => { if (node) effortControls.current.set(executor.id, node); else effortControls.current.delete(executor.id); }} aria-label={`${t('profiles.effort')} ${index + 1}`} className="input-field text-sm" value={executor.effortValue ?? ''} onChange={(e) => changeExecutor(profile, index, { effortValue: e.target.value || null })}>
                    <option value="">{t(executor.cliTool === 'antigravity' && !!selectedModel?.providerVariants && Object.keys(selectedModel.providerVariants).length > 0 ? 'reconciliation.chooseEffort' : 'profiles.providerDefault')}</option>
                    {[...new Set(effortValues)].map((effort) => <option key={effort} value={effort}>{effort}{effort === executor.effortValue && unsupported ? ` (${t('effort.unsupported')})` : effort === executor.effortValue && uncertain ? ` (${t('effort.unknown')})` : ''}</option>)}
                  </select>
                  {unsupported && <p className="text-2xs text-status-warning">{t('effort.unsupportedWarning')}</p>}
                  {uncertain && <p className="text-2xs text-status-warning">{t('effort.unknownWarning')}</p>}
                </div>
                {(executor.cliTool !== 'opencode' || candidateHealth?.repairKind === 'account') && <div className="space-y-2">
                    <select ref={node => { if (node) accountControls.current.set(executor.id, node); else accountControls.current.delete(executor.id); }} className="input-field text-sm" aria-label={t('accounts.account')} value={executor.accountPolicy ?? 'inherited_default'} onChange={event => changeExecutor(profile, index, { accountPolicy: event.target.value as 'fixed' | 'automatic' | 'inherited_default', providerAccountId: null })}>
                      {(executor.cliTool === 'opencode' ? ['inherited_default'] as const : ['inherited_default', 'fixed', 'automatic'] as const).map(policy => <option key={policy} value={policy}>{t(`accounts.${policy}`)}</option>)}
                    </select>
                    {executor.accountPolicy === 'fixed' && <ProviderAccountPicker provider={executor.cliTool} value={executor.providerAccountId} onChange={id => changeExecutor(profile, index, { providerAccountId: id })} />}
                  </div>}
                <div className="flex items-center gap-1"><button onClick={() => moveExecutor(profile, index, -1)}><ArrowUp size={14} /></button><button onClick={() => moveExecutor(profile, index, 1)}><ArrowDown size={14} /></button><button title={t('profiles.removeExecutor')} onClick={() => removeExecutor(profile, index)}><Trash2 size={14} /></button></div>
              </div>;
            })}</div>
            <button className="btn-secondary flex items-center gap-1 text-xs" onClick={() => addExecutor(profile)}><Plus size={13} />{t('profiles.addExecutor')}</button>
            <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={profile.isEnabled} onChange={(e) => replaceProfile({ ...profile, isEnabled: e.target.checked })} />{t('profiles.enabled')}</label><div className="flex gap-3"><button title={t('common.save')} onClick={() => saveProfile(profile)}><Save size={16} /></button><button title={t('common.delete')} onClick={() => deleteProfile(profile)}><Trash2 size={16} /></button></div></div>
          </div>}
        </div>;
      })}
    </section>}
  </div>;
}
