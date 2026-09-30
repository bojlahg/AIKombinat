import { useEffect, useState } from 'react';
import { getAccounts, type ProviderAccount } from '../api/providerAccounts';
import { useI18n } from '../i18n';

export default function ProviderAccountPicker({ provider, value, onChange, disabled = false }: {
  provider: string; value?: string | null; onChange: (id: string | null) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  useEffect(() => { let active = true; getAccounts().then(rows => { if (active) setAccounts(Array.isArray(rows) ? rows : []); }).catch(() => undefined); return () => { active = false; }; }, []);
  if (!['claude', 'codex', 'antigravity'].includes(provider)) return null;
  return <label className="block text-xs text-theme-muted">{t('accounts.account')}
    <select className="input-field mt-1 text-sm" aria-label={t('accounts.account')} disabled={disabled} value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
      <option value="">{t('accounts.inherited_default')}</option>
      {value && !accounts.some(account => account.id === value) && <option value={value}>{t('accounts.unavailable')}</option>}
      {accounts.filter(account => account.provider === provider).map(account => <option key={account.id} value={account.id} disabled={!account.is_enabled && account.id !== value}>{account.label}{!account.is_enabled ? ` (${t('accounts.disabled')})` : ''}</option>)}
    </select>
  </label>;
}
