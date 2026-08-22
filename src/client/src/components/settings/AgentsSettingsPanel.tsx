import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { useI18n } from '../../i18n';
import EffortStars from '../EffortStars';
import * as api from '../../api/agentEffortProfiles';

const EFFORT_OPTIONS: Record<api.AgentCliTool, string[]> = {
  claude: ['provider-default', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: ['provider-default', 'low', 'medium', 'high'],
};
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_NAMES: Record<api.AgentCliTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
};

export default function AgentsSettingsPanel() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<api.AgentEffortProfile[]>([]);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState('');

  useEffect(() => {
    api.getProfiles().then(setProfiles).catch((err) => setError(String(err))).finally(() => setBusy(null));
  }, []);

  const replace = (profile: api.AgentEffortProfile) => setProfiles((items) => items.map((item) => item.cliTool === profile.cliTool ? profile : item));
  const save = async (profile: api.AgentEffortProfile) => {
    setBusy(profile.cliTool); setError('');
    try { replace(await api.saveProfile(profile)); } catch (err) { setError(String(err)); } finally { setBusy(null); }
  };
  const reset = async (cliTool: api.AgentCliTool) => {
    setBusy(cliTool); setError('');
    try { replace(await api.resetProfile(cliTool)); } catch (err) { setError(String(err)); } finally { setBusy(null); }
  };

  if (busy === 'load') return <div className="flex justify-center p-12"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="space-y-5 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{t('effort.agentsTitle')}</h2><p className="text-sm text-warm-500">{t('effort.agentsDescription')}</p></div>
        <button type="button" className="btn-secondary flex items-center gap-2" onClick={() => api.refreshModels()}><RefreshCw size={14} />{t('effort.refreshModels')}</button>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {profiles.map((profile) => (
        <section key={profile.cliTool} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
          <h3 className="mb-4 font-semibold">{AGENT_NAMES[profile.cliTool]}</h3>
          <div className="mb-5">
            <label className="mb-2 block text-sm font-medium">{t('effort.defaultLevel')}</label>
            <EffortStars value={profile.defaultLevel} onChange={(defaultLevel) => replace({ ...profile, defaultLevel })} disabled={busy === profile.cliTool} />
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">{t('effort.mapping')}</div>
            {([1, 2, 3, 4, 5] as const).map((level) => (
              <div key={level} className="grid grid-cols-[7rem_1fr] items-center gap-3">
                <span className="tracking-wider" aria-label={t('effort.level').replace('{level}', String(level))}>{'★'.repeat(level)}{'☆'.repeat(5 - level)}</span>
                <select className="input-field text-sm" value={profile.mapping[String(level) as keyof api.EffortMapping]} onChange={(event) => replace({ ...profile, mapping: { ...profile.mapping, [level]: event.target.value } })}>
                  {EFFORT_OPTIONS[profile.cliTool].map((effort) => <option key={effort} value={effort}>{t(`effort.native.${effort}` as Parameters<typeof t>[0])}</option>)}
                </select>
              </div>
            ))}
          </div>
          {([1, 2, 3, 4] as const).map((level) => {
            const current = EFFORT_ORDER.indexOf(profile.mapping[level]);
            const next = EFFORT_ORDER.indexOf(profile.mapping[(level + 1) as 2 | 3 | 4 | 5]);
            return current >= 0 && next >= 0 && next < current
              ? <p key={level} className="mt-3 text-sm text-amber-600">{t('effort.decreasingWarning').replace('{from}', String(level)).replace('{to}', String(level + 1))}</p>
              : null;
          })}
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn-primary flex items-center gap-2" disabled={busy === profile.cliTool} onClick={() => save(profile)}><Save size={14} />{t('common.save')}</button>
            <button type="button" className="btn-secondary flex items-center gap-2" disabled={busy === profile.cliTool} onClick={() => reset(profile.cliTool)}><RotateCcw size={14} />{t('effort.resetRecommended')}</button>
          </div>
        </section>
      ))}
    </div>
  );
}
