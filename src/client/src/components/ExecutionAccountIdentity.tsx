import { useI18n } from '../i18n';
export default function ExecutionAccountIdentity({ snapshot }: { snapshot?: string | null }) {
  const { t } = useI18n();
  if (!snapshot) return null;
  try {
    const identity = JSON.parse(snapshot);
    if (identity.agent === 'opencode' || identity.agent === 'raw-shell') return null;
    return <p className="text-xs text-theme-muted">{t('accounts.account')}: {identity.providerAccountLabel ?? t('accounts.legacy')}{identity.accountPolicy && <> · {t(`accounts.${identity.accountPolicy}` as 'accounts.fixed')}</>}</p>;
  } catch { return null; }
}
