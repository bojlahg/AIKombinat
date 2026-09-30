import { useEffect, useState } from 'react';
import { getAccounts, saveAccount, testAccount, deleteAccount, type ProviderAccount } from '../../api/providerAccounts';
import { useI18n } from '../../i18n';

export default function ProviderAccountsPanel() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderAccount['provider']>('claude');
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const [variable, setVariable] = useState('');
  const strategies = [...new Set(accounts.filter(account => account.provider === provider).flatMap(account => account.strategies ?? []))].filter(strategy => strategy !== 'inherited' || !accounts.some(account => account.provider === provider && account.auth_strategy === 'inherited'));
  const strategy = strategies.includes('environment_reference') ? 'environment_reference' : strategies[0];
  const reload = () => getAccounts().then(setAccounts);
  useEffect(() => { reload().catch(error => setError(String(error))); }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await reload(); } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  const change = (id: string, fields: Partial<ProviderAccount>) => setAccounts(current => current.map(account => account.id === id ? { ...account, ...fields } : account));
  return <section className="space-y-4">
    <h2 className="text-lg font-semibold">{t('accounts.title')}</h2>
    <p className="text-sm text-theme-muted">{t('accounts.help')}</p>
    {error && <p role="alert" className="text-status-error">{error}</p>}
    {(['claude', 'codex', 'antigravity'] as const).map(provider => <div key={provider} className="rounded-xl border border-theme-border p-4 space-y-3">
      <h3 className="font-semibold">{provider}</h3>
      {accounts.filter(account => account.provider === provider).map(account => <div key={account.id} className="rounded-xl bg-theme-card p-3 space-y-2">
        <div className="flex flex-wrap gap-3 text-xs"><span>{account.slug}</span><span>{t('accounts.health')}: {t(`accounts.${account.is_enabled ? account.health_state : 'disabled'}`)}</span><span>{t('accounts.usage')}: {account.active_usage}/{account.max_concurrency}</span><span>{t(`accounts.${account.auth_strategy}`)}</span></div>
        {account.last_health_at && <time className="text-xs text-theme-muted">{new Date(account.last_health_at).toLocaleString()}</time>}
        {account.health_reason && <p className="text-xs text-theme-muted">{account.health_reason}</p>}
        <label className="block text-xs">{t('accounts.label')}<input className="input-field" maxLength={128} value={account.label} onChange={event => change(account.id, { label: event.target.value })} /></label>
        <label className="block text-xs">{t('accounts.description')}<input className="input-field" value={account.description} onChange={event => change(account.id, { description: event.target.value })} /></label>
        <label className="block text-xs">{t('accounts.limit')}<input className="input-field" type="number" min={1} max={32} value={account.max_concurrency} onChange={event => change(account.id, { max_concurrency: Number(event.target.value) })} /></label>
        {account.auth_strategy === 'environment_reference' && <label className="block text-xs">{t('accounts.variable')}<input className="input-field" value={JSON.parse(account.auth_config_json).variable ?? ''} onChange={event => change(account.id, { auth_config_json: JSON.stringify({ variable: event.target.value }) })} /></label>}
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs"><input type="checkbox" checked={!!account.is_enabled} disabled={busy} onChange={event => run(() => saveAccount(account.id, { is_enabled: event.target.checked }))} /> {t('accounts.enabled')}</label>
          <button className="btn-secondary btn-sm" disabled={busy} onClick={() => run(() => saveAccount(account.id, { label: account.label, description: account.description, max_concurrency: account.max_concurrency, auth_config: JSON.parse(account.auth_config_json) }))}>{t('common.save')}</button>
          <button className="btn-secondary btn-sm" disabled={busy} onClick={() => run(() => testAccount(account.id))}>{t('accounts.test')}</button>
          {account.auth_strategy !== 'inherited' && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => run(() => deleteAccount(account.id))}>{t('common.delete')}</button>}
        </div>
      </div>)}
    </div>)}
    <form className="rounded-xl border border-theme-border p-4 space-y-2" onSubmit={event => { event.preventDefault(); run(() => saveAccount(null, { provider, label, slug, auth_strategy: strategy, auth_config: strategy === 'environment_reference' ? { variable } : {} })); }}>
      <h3 className="font-semibold">{t('accounts.add')}</h3>
      <select className="input-field" aria-label={t('profiles.agent')} value={provider} onChange={event => setProvider(event.target.value as ProviderAccount['provider'])}>{['claude', 'codex', 'antigravity'].map(provider => <option key={provider}>{provider}</option>)}</select>
      <label className="block text-xs">{t('accounts.label')}<input className="input-field" required value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label className="block text-xs">{t('accounts.slug')}<input className="input-field" required pattern="[a-z0-9][a-z0-9_-]{0,63}" value={slug} onChange={event => setSlug(event.target.value)} /></label>
      {strategy && <p className="text-xs text-theme-muted">{t(`accounts.${strategy}`)}</p>}
      {!strategy && <p className="text-xs text-theme-muted">{t('accounts.noAdditionalStrategy')}</p>}
      {strategy === 'environment_reference' && <label className="block text-xs">{t('accounts.variable')}<input className="input-field" required value={variable} onChange={event => setVariable(event.target.value)} /></label>}
      <button className="btn-primary btn-sm" disabled={busy || !strategy}>{t('accounts.add')}</button>
    </form>
  </section>;
}
