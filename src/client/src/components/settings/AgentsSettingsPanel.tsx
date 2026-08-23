import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import * as profilesApi from '../../api/executionProfiles';

type Tool = profilesApi.AgentCliTool;
type Model = {
  id: string; value: string; label: string; status: 'available' | 'missing'; source: 'cli' | 'manual';
  supportedEfforts: string[] | null; lastSeenAt: string | null; lastCheckedAt: string | null;
};
type RefreshResult = { source: string; authoritative: boolean; added: number; updated: number; restored: number; markedMissing: number };

const AGENTS: Array<{ value: Tool; label: string }> = [
  { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'antigravity', label: 'Antigravity' },
];
const FALLBACK_EFFORTS: Record<Tool, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: [],
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

const sameModelDraft = (left: Model, right?: Model) => !!right
  && left.label === right.label
  && JSON.stringify(left.supportedEfforts) === JSON.stringify(right.supportedEfforts);

export default function AgentsSettingsPanel() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'profiles' | 'models'>('profiles');
  const [models, setModels] = useState<Record<string, Model[]>>({});
  const [savedModels, setSavedModels] = useState<Record<string, Model[]>>({});
  const [profiles, setProfiles] = useState<profilesApi.ExecutionProfile[]>([]);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Record<Tool, boolean>>({ claude: false, codex: false, antigravity: false });
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState<Tool | null>(null);
  const [saving, setSaving] = useState<Tool | null>(null);
  const [refreshResults, setRefreshResults] = useState<Partial<Record<Tool, RefreshResult | 'failed'>>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([json<Record<string, Model[]>>('/api/models'), profilesApi.getProfiles(true)])
      .then(([catalog, executionProfiles]) => {
        setModels(catalog); setSavedModels(catalog); setProfiles(executionProfiles);
        setExpandedProfileId(executionProfiles[0]?.id ?? null);
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
    } catch (e) {
      setError(String(e)); setRefreshResults((current) => ({ ...current, [tool]: 'failed' }));
    } finally { setRefreshing(null); }
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
      method: 'PATCH', body: JSON.stringify({ modelLabel: model.label, supportedEfforts: model.supportedEfforts }),
    })));
    const saved = results.flatMap((result, index) => result.status === 'fulfilled' ? [{ ...dirty[index], source: 'manual' as const }] : []);
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
  const replaceProfile = (profile: profilesApi.ExecutionProfile) => setProfiles((current) => current.map((item) => item.id === profile.id ? profile : item));
  const createProfile = async () => {
    try {
      const suffix = Date.now().toString(36);
      const created = await profilesApi.createProfile({ slug: `profile-${suffix}`, name: t('profiles.newProfile'), description: '', isEnabled: true, sortOrder: profiles.length, executors: [] });
      setProfiles((current) => [...current, created]); setExpandedProfileId(created.id);
    } catch (e) { setError(String(e)); }
  };
  const saveProfile = async (profile: profilesApi.ExecutionProfile) => {
    try {
      const saved = await profilesApi.updateProfile(profile.id, {
        slug: profile.slug, name: profile.name, description: profile.description, isEnabled: profile.isEnabled, sortOrder: profile.sortOrder,
        executors: (profile.executors ?? []).map((executor, index) => ({ id: executor.id, cliModelId: executor.cliModelId, effortValue: executor.effortValue, priority: index, isEnabled: executor.isEnabled })),
      });
      replaceProfile(saved);
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
    replaceProfile({ ...profile, executors: [...(profile.executors ?? []), {
      id: `new-${Date.now()}`, cliModelId: model.id, cliTool: tool, modelValue: model.value, modelLabel: model.label, modelStatus: model.status,
      supportedEfforts: model.supportedEfforts, effortValue: null, priority: profile.executors?.length ?? 0, isEnabled: true,
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

  if (busy) return <div className="flex justify-center p-12"><Loader2 className="animate-spin" /></div>;
  return <div className="space-y-5 p-5 sm:p-6">
    {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}
    <div className="flex border-b" role="tablist" style={{ borderColor: 'var(--color-border)' }}>
      {(['profiles', 'models'] as const).map((value) => <button key={value} role="tab" aria-selected={tab === value} className={`px-4 py-2.5 text-sm font-semibold ${tab === value ? 'border-b-2 text-primary-500' : 'text-warm-500'}`} onClick={() => setTab(value)}>{t(`profiles.tab.${value}`)}</button>)}
    </div>

    {tab === 'models' && <section className="space-y-4">
      <div><h2 className="text-lg font-semibold">{t('catalog.title')}</h2><p className="text-sm text-warm-500">{t('catalog.description')}</p></div>
      {AGENTS.map((agent) => {
        const agentModels = models[agent.value] ?? [];
        const collapsed = collapsedAgents[agent.value];
        const result = refreshResults[agent.value];
        return <div key={agent.value} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button className="flex items-center gap-2 text-left" aria-expanded={!collapsed} onClick={() => setCollapsedAgents((current) => ({ ...current, [agent.value]: !current[agent.value] }))}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}<span className="font-semibold">{agent.label}</span><span className="text-xs text-warm-500">{agentModels.length} {t('catalog.models')}</span></button>
            <div className="flex gap-2"><button className="btn-secondary flex items-center gap-1 text-xs" disabled={!!refreshing} onClick={() => refresh(agent.value)}><RefreshCw size={13} className={refreshing === agent.value ? 'animate-spin' : ''} />{t('catalog.refresh')}</button><button className="btn-secondary flex items-center gap-1 text-xs" onClick={() => addModel(agent.value)}><Plus size={13} />{t('catalog.addManual')}</button><button className="btn-secondary flex items-center gap-1 text-xs" disabled={!dirtyIds[agent.value].size || saving === agent.value} onClick={() => saveAgentModels(agent.value)}><Save size={13} />{t('common.save')}</button></div>
          </div>
          {result && <p className={`mt-2 text-xs ${result === 'failed' || !result.authoritative ? 'text-status-warning' : 'text-status-success'}`}>{result === 'failed' ? t('catalog.refreshFailed') : `${t('catalog.updated')}: ${result.updated} · ${t('catalog.added')}: ${result.added} · ${t('catalog.missingCount')}: ${result.markedMissing} · ${t('catalog.source')}: ${result.source} · ${result.authoritative ? t('catalog.authoritative') : t('catalog.partial')}`}</p>}
          {!collapsed && <div className="mt-3 space-y-2">{agentModels.map((model) => <div key={model.id} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[1.2fr_1.5fr_auto]" style={{ borderColor: 'var(--color-border)' }}>
            <div><input aria-label={`${agent.label} ${model.value} ${t('catalog.label')}`} className="input-field text-sm" value={model.label} onChange={(e) => updateModelDraft(agent.value, model.id, { label: e.target.value })} /><p className="mt-1 text-2xs text-warm-500">{model.value} · {model.source === 'manual' ? t('catalog.manual') : t('catalog.cli')}</p><p className="text-2xs text-warm-500">{t('catalog.lastSeen')}: {model.lastSeenAt ? new Date(model.lastSeenAt).toLocaleString() : t('catalog.never')}</p>{model.status === 'missing' && <p className="text-2xs text-status-warning">{t('catalog.missing')}</p>}</div>
            <input aria-label={`${agent.label} ${model.value} ${t('catalog.effortsPrompt')}`} className="input-field text-sm" value={model.supportedEfforts?.join(', ') ?? ''} placeholder={t('catalog.unknownEfforts')} onChange={(e) => updateModelDraft(agent.value, model.id, { supportedEfforts: e.target.value ? e.target.value.split(',').map((item) => item.trim()).filter(Boolean) : null })} />
            <button title={`${t('common.delete')} ${model.label}`} onClick={() => deleteModel(agent.value, model)}><Trash2 size={15} /></button>
          </div>)}</div>}
        </div>;
      })}
    </section>}

    {tab === 'profiles' && <section className="space-y-4">
      <div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{t('profiles.executionTitle')}</h2><p className="text-sm text-warm-500">{t('profiles.executionDescription')}</p></div><button className="btn-secondary flex items-center gap-1 text-xs" onClick={createProfile}><Plus size={14} />{t('profiles.new')}</button></div>
      {profiles.map((profile) => {
        const expanded = expandedProfileId === profile.id;
        return <div key={profile.id} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
          <button className="flex w-full items-center gap-2 text-left" aria-expanded={expanded} onClick={() => setExpandedProfileId(expanded ? null : profile.id)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="font-semibold">{profile.name}</span><span className="text-xs text-warm-500">· {(profile.executors ?? []).length} {t('profiles.executors')}</span></button>
          {expanded && <div className="mt-3 space-y-3">
            <div className="grid gap-2 sm:grid-cols-2"><input className="input-field text-sm" aria-label={t('profiles.name')} value={profile.name} onChange={(e) => replaceProfile({ ...profile, name: e.target.value })} /><input className="input-field text-sm" aria-label={t('profiles.slug')} value={profile.slug} onChange={(e) => replaceProfile({ ...profile, slug: e.target.value.toLowerCase() })} /></div>
            <textarea className="input-field min-h-20 text-sm" aria-label={t('profiles.profileDescription')} value={profile.description} onChange={(e) => replaceProfile({ ...profile, description: e.target.value })} />
            {!(profile.executors ?? []).some((executor) => executor.isEnabled && executor.modelStatus === 'available') && <p className="text-xs text-status-warning">{t('profiles.noEligible')}</p>}
            <div className="space-y-2">{(profile.executors ?? []).map((executor, index) => {
              const toolModels = models[executor.cliTool] ?? [];
              const selectedModel = toolModels.find((model) => model.id === executor.cliModelId);
              const selectableModels = toolModels.filter((model) => model.status === 'available' || model.id === executor.cliModelId);
              const efforts = selectedModel?.supportedEfforts ?? FALLBACK_EFFORTS[executor.cliTool];
              const capabilitiesUnknown = executor.cliTool === 'antigravity' && selectedModel?.supportedEfforts == null;
              const unsupported = !!executor.effortValue && !!selectedModel?.supportedEfforts && !selectedModel.supportedEfforts.includes(executor.effortValue);
              const uncertain = !!executor.effortValue && capabilitiesUnknown;
              const effortValues = unsupported || uncertain ? [executor.effortValue!, ...efforts] : efforts;
              return <div key={executor.id} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[auto_1fr_1.4fr_1fr_auto]" style={{ borderColor: 'var(--color-border)' }}>
                <span className="self-center text-xs text-warm-500">{index + 1}</span>
                <select aria-label={`${t('profiles.agent')} ${index + 1}`} className="input-field text-sm" value={executor.cliTool} onChange={(e) => { const tool = e.target.value as Tool; const model = (models[tool] ?? []).find((item) => item.status === 'available'); if (model) changeExecutor(profile, index, { cliTool: tool, cliModelId: model.id, modelValue: model.value, modelLabel: model.label, modelStatus: model.status, supportedEfforts: model.supportedEfforts, effortValue: null }); }}>{AGENTS.map((agent) => <option key={agent.value} value={agent.value}>{agent.label}</option>)}</select>
                <select aria-label={`${t('catalog.title')} ${index + 1}`} className="input-field text-sm" value={executor.cliModelId} onChange={(e) => { const model = selectableModels.find((item) => item.id === e.target.value); if (model) changeExecutor(profile, index, { cliModelId: model.id, modelValue: model.value, modelLabel: model.label, modelStatus: model.status, supportedEfforts: model.supportedEfforts, effortValue: null }); }}>{selectableModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.status === 'missing' ? ` (${t('catalog.missingShort')})` : ''}</option>)}</select>
                <div><select aria-label={`${t('profiles.effort')} ${index + 1}`} className="input-field text-sm" value={executor.effortValue ?? ''} onChange={(e) => changeExecutor(profile, index, { effortValue: e.target.value || null })}><option value="">{t('profiles.providerDefault')}</option>{[...new Set(effortValues)].map((effort) => <option key={effort} value={effort}>{effort}{effort === executor.effortValue && unsupported ? ` (${t('effort.unsupported')})` : effort === executor.effortValue && uncertain ? ` (${t('effort.unknown')})` : ''}</option>)}</select>{unsupported && <p className="text-2xs text-status-warning">{t('effort.unsupportedWarning')}</p>}{uncertain && <p className="text-2xs text-status-warning">{t('effort.unknownWarning')}</p>}</div>
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
