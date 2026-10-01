import { useState } from 'react';
import Modal from '../Modal';
import ProviderAccountPicker from '../ProviderAccountPicker';
import { useI18n } from '../../i18n';
import { recreateCandidate, type ReconciledCandidate, type ReconciledProfile } from '../../api/reconciliation';
import type { RepairModel } from './ProfileRepairModal';
import type { AgentCliTool } from '../../api/executionProfiles';

export default function ProfileRecreateModal({ profile, candidate, models, onClose, onApplied }: {
  profile: ReconciledProfile; candidate: ReconciledCandidate; models: Record<string, RepairModel[]>;
  onClose: () => void; onApplied: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState(''), [modelId, setModelId] = useState(''), [effort, setEffort] = useState('');
  const [policy, setPolicy] = useState('inherited_default'), [accountId, setAccountId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const choices = models[provider] ?? [];
  const model = choices.find(item => item.id === modelId);
  const grouped = provider === 'antigravity' && !!model?.providerVariants && Object.keys(model.providerVariants).length > 0;
  const invalidEffort = grouped && (!effort || !model?.supportedEfforts?.includes(effort) || !model.providerVariants?.[effort])
    || !!effort && (provider === 'opencode' || !!model?.supportedEfforts && !model.supportedEfforts.includes(effort));
  const apply = async () => {
    setBusy(true); setError('');
    try {
      await recreateCandidate(profile.id, candidate.candidateId, { provider, newModelId: modelId, newEffort: effort || null,
        accountPolicy: policy, providerAccountId: accountId, expectedOldModelId: candidate.modelReferenceId,
        expectedProfileUpdatedAt: profile.updatedAt, confirmActiveCampaignImpact: confirmed });
      await onApplied(); onClose();
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      const known = ['profile_not_found', 'candidate_not_found', 'model_not_found', 'provider_mismatch', 'effort_unsupported', 'effort_required',
        'reconciliation_stale', 'active_campaign_impact', 'candidate_provider_unrecoverable', 'invalid_account_policy'];
      setError(t(`reconciliation.error.${known.includes(code) ? code : 'rebind_failed'}`));
    } finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} size="xl" disableBackdropClose={busy} disableEscClose={busy}>
    <div role="dialog" aria-modal="true" aria-label={t('reconciliation.action.recreate')} className="bg-theme-card border border-theme-border rounded-2xl p-6 space-y-4 max-h-[85vh] overflow-y-auto">
      <h2 className="text-lg font-semibold">{t('reconciliation.action.recreate')} — {profile.name}</h2>
      <p>{t('reconciliation.recreate.description')}</p>
      <p>{t('reconciliation.priority')}: {candidate.priority} · {t('profiles.enabled')}: {t(candidate.enabled ? 'common.yes' : 'common.no')}</p>
      <select className="input-field w-full" aria-label={t('profiles.agent')} value={provider} onChange={event => {
        setProvider(event.target.value); setModelId(''); setEffort(''); setPolicy('inherited_default'); setAccountId(null);
      }}><option value="">{t('reconciliation.chooseProvider')}</option>
        {['claude', 'codex', 'antigravity', 'opencode'].map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      {provider && choices.length === 0 && <p role="status">{t('reconciliation.refreshFirst')}</p>}
      <select className="input-field w-full" aria-label={t('reconciliation.newModel')} value={modelId} onChange={event => { setModelId(event.target.value); setEffort(''); }}>
        <option value="">{t('reconciliation.choose')}</option>{choices.map(item => <option key={item.id} value={item.id}>{item.label} ({item.value})</option>)}
      </select>
      <select className="input-field w-full" aria-label={t('profiles.effort')} value={effort} onChange={event => setEffort(event.target.value)}>
        <option value="">{t(grouped ? 'reconciliation.chooseEffort' : 'profiles.providerDefault')}</option>
        {(model?.supportedEfforts ?? []).map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <select className="input-field w-full" aria-label={t('accounts.account')} value={policy} onChange={event => { setPolicy(event.target.value); setAccountId(null); }}>
        {(provider === 'opencode' ? ['inherited_default'] : ['inherited_default', 'automatic', 'fixed']).map(value => <option key={value} value={value}>{t(`accounts.${value}`)}</option>)}
      </select>
      {policy === 'fixed' && provider && <ProviderAccountPicker provider={provider as AgentCliTool} value={accountId} onChange={setAccountId} />}
      {profile.references.runningCampaigns.length > 0 && <label className="flex gap-2 text-sm text-status-warning"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('reconciliation.campaignWarning')}</label>}
      {error && <p role="alert" className="text-status-error">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn-secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn-primary" disabled={busy || !provider || !model || !!invalidEffort || policy === 'fixed' && !accountId || profile.references.runningCampaigns.length > 0 && !confirmed} onClick={apply}>{t('reconciliation.apply')}</button></div>
    </div>
  </Modal>;
}
