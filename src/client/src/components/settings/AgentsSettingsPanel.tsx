import { useEffect, useState } from 'react';
import { Copy, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import * as api from '../../api/agentProfiles';

const AGENTS: Array<{ value: api.AgentCliTool; label: string }> = [
  { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex CLI' }, { value: 'antigravity', label: 'Antigravity CLI' },
];
const EFFORTS: Record<api.AgentCliTool, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: ['low', 'medium', 'high'],
};

export default function AgentsSettingsPanel() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<api.AgentProfile[]>([]);
  const [models, setModels] = useState<Record<string, Array<{ value: string; label: string; deprecated?: boolean; availabilityStatus?: string }>>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const load = () => Promise.all([api.getProfiles(), fetch('/api/models', { credentials: 'include' }).then((r) => r.json())]).then(([p, m]) => { setProfiles(p); setModels(m); });
  useEffect(() => { load().catch((e) => setError(String(e))).finally(() => setBusy(false)); }, []);
  const replace = (value: api.AgentProfile) => setProfiles((items) => items.map((item) => item.id === value.id ? value : item));
  const create = async (cliTool: api.AgentCliTool, source?: api.AgentProfile) => {
    setError('');
    try { const created = await api.createProfile({ cliTool, name: source ? `${source.name} copy` : t('profiles.newProfile'), modelValue: source?.modelValue ?? null, effortValue: source?.effortValue ?? null, isEnabled: true }); setProfiles((items) => [...items, created]); } catch (e) { setError(String(e)); }
  };
  const save = async (profile: api.AgentProfile) => { try { replace(await api.updateProfile(profile.id, profile)); } catch (e) { setError(String(e)); } };
  const remove = async (profile: api.AgentProfile) => { try { await api.deleteProfile(profile.id); setProfiles((items) => items.filter((item) => item.id !== profile.id)); } catch (e) { setError(String(e)); } };
  if (busy) return <div className="flex justify-center p-12"><Loader2 className="animate-spin" /></div>;
  return <div className="space-y-5 p-5 sm:p-6">
    <div><h2 className="text-lg font-semibold">{t('effort.agentsTitle')}</h2><p className="text-sm text-warm-500">{t('profiles.description')}</p></div>
    {error && <p className="text-sm text-red-500">{error}</p>}
    {AGENTS.map((agent) => <section key={agent.value} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
      <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">{agent.label}</h3><button className="btn-secondary flex items-center gap-1 text-xs" onClick={() => create(agent.value)}><Plus size={14} />{t('profiles.new')}</button></div>
      <div className="space-y-3">{profiles.filter((p) => p.cliTool === agent.value).map((profile) => {
        const catalog = models[agent.value] ?? [];
        const missing = profile.modelValue && !catalog.some((m) => m.value === profile.modelValue);
        return <div key={profile.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1.1fr_1.4fr_1fr_auto]" style={{ borderColor: 'var(--color-border)' }}>
          <input className="input-field text-sm" value={profile.name} aria-label={t('profiles.name')} onChange={(e) => replace({ ...profile, name: e.target.value })} />
          <select className="input-field text-sm" value={profile.modelValue ?? ''} onChange={(e) => replace({ ...profile, modelValue: e.target.value || null })}><option value="">{t('profiles.providerDefault')}</option>{missing && <option value={profile.modelValue!}>{profile.modelValue} ({t('effort.modelUnavailable')})</option>}{catalog.filter((m) => m.value && !m.deprecated && m.availabilityStatus !== 'unavailable').map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
          <select className="input-field text-sm" value={profile.effortValue ?? ''} onChange={(e) => replace({ ...profile, effortValue: e.target.value || null })}><option value="">{t('profiles.providerDefault')}</option>{profile.effortValue && !EFFORTS[agent.value].includes(profile.effortValue) && <option value={profile.effortValue}>{profile.effortValue}</option>}{EFFORTS[agent.value].map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select>
          <div className="flex items-center gap-2"><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={profile.isEnabled} onChange={(e) => replace({ ...profile, isEnabled: e.target.checked })} />{t('profiles.enabled')}</label><button title={t('common.save')} onClick={() => save(profile)}><Save size={15} /></button><button title={t('profiles.duplicate')} onClick={() => create(agent.value, profile)}><Copy size={15} /></button><button title={t('common.delete')} onClick={() => remove(profile)}><Trash2 size={15} /></button></div>
        </div>;
      })}</div>
    </section>)}
  </div>;
}
