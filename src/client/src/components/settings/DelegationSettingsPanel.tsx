import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useToast } from '../../hooks/useToast';
import * as delegationApi from '../../api/delegation';
import { getProfiles, type ExecutionProfile } from '../../api/executionProfiles';
import type { TranslationKey } from '../../i18n/types';

export default function DelegationSettingsPanel() {
  const { t } = useI18n();
  const { error: toastError, success: toastSuccess } = useToast();
  const [settings, setSettings] = useState<delegationApi.DelegationSettings | null>(null);
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [hooks, setHooks] = useState<delegationApi.DelegationHookStatus[]>([]);
  const [stats, setStats] = useState<delegationApi.DelegationStatistics | null>(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hookBusy, setHookBusy] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      delegationApi.getDelegationSettings(), getProfiles(false),
      delegationApi.getDelegationHooks(), delegationApi.getDelegationStatistics(),
    ]).then(([next, nextProfiles, nextHooks, nextStats]) => {
      setSettings(next); setProfiles(nextProfiles); setHooks(nextHooks); setStats(nextStats);
    }).catch((err) => toastError(err instanceof Error ? err.message : t('delegation.loadFailed')))
      .finally(() => setBusy(false));
  }, [t, toastError]);

  const reduction = useMemo(() => {
    if (!stats?.sourceCharsProcessed) return 0;
    return Math.round((stats.contextAvoidedChars / stats.sourceCharsProcessed) * 100);
  }, [stats]);
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === settings?.workerExecutionProfileId) ?? null,
    [profiles, settings?.workerExecutionProfileId],
  );

  if (busy || !settings) return <div className="flex min-h-60 items-center justify-center"><Loader2 className="animate-spin" size={20} /></div>;

  const save = async () => {
    setSaving(true);
    try { setSettings(await delegationApi.updateDelegationSettings(settings)); toastSuccess(t('delegation.saved')); }
    catch (err) { toastError(err instanceof Error ? err.message : t('delegation.saveFailed')); }
    finally { setSaving(false); }
  };

  const changeHook = async (provider: 'claude' | 'codex', install: boolean) => {
    setHookBusy(provider);
    try {
      const next = install ? await delegationApi.installDelegationHook(provider) : await delegationApi.removeDelegationHook(provider);
      setHooks((current) => current.map((hook) => hook.provider === provider ? next : hook));
    } catch (err) { toastError(err instanceof Error ? err.message : t('delegation.hookActionFailed')); }
    finally { setHookBusy(null); }
  };

  const numberField = (key: 'fullFileThresholdLines' | 'maxTargetedReadLines' | 'maxInputBytes' | 'workerTimeoutSeconds', label: string) => (
    <label className="space-y-1 text-sm">
      <span className="text-warm-700">{label}</span>
      <input className="input w-full" type="number" min={1} value={settings[key]}
        onChange={(event) => setSettings({ ...settings, [key]: Number(event.target.value) })} />
    </label>
  );

  return <div className="space-y-6 p-5 sm:p-6">
    <div>
      <h2 className="text-lg font-semibold text-warm-800">{t('delegation.title')}</h2>
      <p className="mt-1 text-sm text-warm-500">{t('delegation.description')}</p>
    </div>

    <div className="rounded-lg border p-4" style={{ borderColor: 'var(--color-border)' }}>
      <label className="flex items-center gap-3 text-sm font-medium text-warm-800">
        <input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />
        {t('delegation.enable')}
      </label>
      <div className="mt-3 flex gap-2 text-sm" style={{ color: 'var(--color-warning)' }}>
        <ShieldAlert size={17} className="shrink-0" />
        <span>{t('delegation.dataWarning')}</span>
      </div>
    </div>

    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm">
        <span className="text-warm-700">{t('delegation.mode')}</span>
        <select className="input w-full" value={settings.mode} onChange={(event) => setSettings({ ...settings, mode: event.target.value as delegationApi.DelegationMode })}>
          <option value="telemetry">{t('delegation.mode.telemetry')}</option>
          <option value="suggest">{t('delegation.mode.suggest')}</option>
          <option value="enforce_bulk_read">{t('delegation.mode.enforce')}</option>
        </select>
      </label>
      <label className="space-y-1 text-sm">
        <span className="text-warm-700">{t('delegation.workerProfile')}</span>
        <select className="input w-full" value={settings.workerExecutionProfileId ?? ''} onChange={(event) => setSettings({ ...settings, workerExecutionProfileId: event.target.value || null })}>
          <option value="">{t('delegation.workerUnconfigured')}</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        {selectedProfile && <div className="text-xs text-warm-500">{(selectedProfile.executors ?? []).filter((item) => item.isEnabled).map((item) => `${item.cliTool} / ${item.modelLabel}${item.effortValue ? ` / ${item.effortValue}` : ''}`).join(', ')}</div>}
      </label>
      {numberField('fullFileThresholdLines', t('delegation.fullFileThreshold'))}
      {numberField('maxTargetedReadLines', t('delegation.maxTargetedRead'))}
      {numberField('maxInputBytes', t('delegation.maxInputBytes'))}
      {numberField('workerTimeoutSeconds', t('delegation.workerTimeout'))}
    </div>

    <div>
      <h3 className="mb-2 text-sm font-semibold text-warm-800">{t('delegation.hooks')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {hooks.map((hook) => <div key={hook.provider} className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center justify-between gap-2">
            <div><div className="font-medium text-warm-800">{hook.provider === 'claude' ? 'Claude Code' : 'Codex'}</div><div className="text-xs text-warm-500">{t(`delegation.hookState.${hook.state}` as TranslationKey)}{hook.version ? ` · ${hook.version}` : ''}</div></div>
            <button className="btn-secondary text-xs" disabled={hookBusy === hook.provider} onClick={() => changeHook(hook.provider, !hook.installed)}>
              {hookBusy === hook.provider ? <Loader2 className="animate-spin" size={14} /> : hook.installed ? t('delegation.removeHook') : t('delegation.installHook')}
            </button>
          </div>
        </div>)}
      </div>
    </div>

    {stats && <div>
      <h3 className="mb-2 text-sm font-semibold text-warm-800">{t('delegation.statistics')}</h3>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {[
          [t('delegation.stat.observed'), stats.toolObservations], [t('delegation.stat.bulkReads'), stats.bulkReadRuns],
          [t('delegation.stat.success'), stats.bulkReadSucceeded], [t('delegation.stat.fallbacks'), stats.fallbacks],
          [t('delegation.stat.sourceChars'), stats.sourceCharsProcessed], [t('delegation.stat.returnedChars'), stats.returnedChars],
          [t('delegation.stat.charReduction'), `${reduction}%`], [t('delegation.stat.latency'), stats.averageLatencyMs === null ? '—' : `${Math.round(stats.averageLatencyMs)} ms`],
        ].map(([label, value]) => <div key={String(label)} className="rounded-lg bg-warm-50 p-2"><div className="text-xs text-warm-500">{label}</div><div className="font-medium text-warm-800">{typeof value === 'number' ? value.toLocaleString() : value}</div></div>)}
      </div>
    </div>}

    <div className="flex justify-end"><button className="btn-primary flex items-center gap-2" disabled={saving} onClick={save}>{saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}{t('delegation.save')}</button></div>
  </div>;
}
