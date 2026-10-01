import { useState } from 'react';
import Modal from '../Modal';
import { useI18n } from '../../i18n';
import { rebindCandidate, type ReconciledCandidate, type ReconciledProfile } from '../../api/reconciliation';

export interface RepairModel {
  id: string; value: string; label: string; supportedEfforts: string[] | null; providerVariants?: Record<string, string> | null;
}
export default function ProfileRepairModal({ profile, candidate, models, onClose, onApplied }: {
  profile: ReconciledProfile; candidate: ReconciledCandidate; models: RepairModel[]; onClose: () => void; onApplied: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [modelId, setModelId] = useState(''), [effort, setEffort] = useState(candidate.effort.configured ?? ''), [search, setSearch] = useState('');
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const model = models.find(item => item.id === modelId);
  const grouped = candidate.provider === 'antigravity' && !!model?.providerVariants && Object.keys(model.providerVariants).length > 0;
  const unsupported = !!model && (!!effort && !!model.supportedEfforts && !model.supportedEfforts.includes(effort)
    || grouped && (!effort || !model.providerVariants?.[effort]) || candidate.provider === 'opencode' && !!effort);
  const apply = async () => {
    setBusy(true); setError('');
    try {
      await rebindCandidate(profile.id, candidate.candidateId, { newModelId: modelId, newEffort: effort || null,
        expectedOldModelId: candidate.currentModel?.id ?? '', expectedProfileUpdatedAt: profile.updatedAt, confirmActiveCampaignImpact: confirmed });
      await onApplied(); onClose();
    } catch (err) {
      const code = err instanceof Error ? err.message : 'rebind_failed';
      const known = ['profile_not_found', 'candidate_not_found', 'model_not_found', 'provider_mismatch', 'effort_unsupported', 'effort_required', 'reconciliation_stale', 'active_campaign_impact', 'candidate_provider_unrecoverable', 'invalid_account_policy'];
      setError(t(`reconciliation.error.${known.includes(code) ? code : 'rebind_failed'}`));
    } finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} size="xl" disableBackdropClose={busy} disableEscClose={busy}>
    <div role="dialog" aria-modal="true" aria-label={t('reconciliation.repair')} className="bg-theme-card border border-theme-border rounded-2xl p-6 space-y-4 max-h-[85vh] overflow-y-auto">
      <h2 className="text-lg font-semibold">{t('reconciliation.repair')} — {profile.name}</h2>
      <p>{t('reconciliation.oldModel')}: {candidate.currentModel?.label ?? t('reconciliation.orphaned')} ({candidate.currentModel?.value ?? '—'})</p>
      <p className="text-sm text-theme-muted">{t('profiles.agent')}: {candidate.provider} · {t('profiles.effort')}: {candidate.effort.configured ?? t('profiles.providerDefault')}</p>
      <p className="text-sm">{t('accounts.account')}: {t(`accounts.${candidate.account.policy}`)} {candidate.account.accountId ?? ''} · {t('reconciliation.priority')}: {candidate.priority}</p>
      <p className="text-sm text-theme-muted">{t('reconciliation.reason.' + candidate.catalogReasonCode)}</p>
      <div className="space-y-2"><p className="text-sm font-semibold">{t('reconciliation.suggestions')}</p>
        {candidate.suggestions.map(item => <button key={item.modelId} className="btn-secondary mr-2 mb-2 text-xs" onClick={() => setModelId(item.modelId)}>{item.label} · {t('reconciliation.' + item.reasonCode)}</button>)}
      </div>
      <input className="input-field w-full" aria-label={t('reconciliation.search')} placeholder={t('reconciliation.search')} value={search} onChange={event => setSearch(event.target.value)} />
      <select className="input-field w-full" aria-label={t('reconciliation.newModel')} value={modelId} onChange={event => setModelId(event.target.value)}>
        <option value="">{t('reconciliation.choose')}</option>
        {models.filter(item => item.id === modelId || `${item.label} ${item.value}`.toLowerCase().includes(search.toLowerCase())).map(item => <option key={item.id} value={item.id}>{item.label} ({item.value})</option>)}
      </select>
      <select className="input-field w-full" aria-label={t('profiles.effort')} value={effort} onChange={event => setEffort(event.target.value)}>
        {!grouped && <option value="">{t('profiles.providerDefault')}</option>}
        {[...new Set([...(effort ? [effort] : []), ...(model?.supportedEfforts ?? candidate.effort.supported ?? [])])].map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      {unsupported && <p className="text-status-warning">{t('reconciliation.error.effort_required')}</p>}
      {model && model.supportedEfforts === null && effort && <p className="text-status-warning">{t('effort.unknownWarning')}</p>}
      {model && <div className="rounded-xl bg-theme-surface-2 p-3 text-sm space-y-1">
        <p>{t('catalog.title')}: {candidate.currentModel?.value ?? '—'} → {model.value}</p>
        <p>{t('profiles.effort')}: {candidate.effort.configured ?? t('profiles.providerDefault')} → {effort || t('profiles.providerDefault')}</p>
        <p>{t('reconciliation.preserved')}</p>
      </div>}
      {profile.references.reviewPolicies.length > 0 && <p className="text-sm">{t('reconciliation.reviewRefs')}: {profile.references.reviewPolicies.map(item => item.name).join(', ')}</p>}
      {profile.references.runningCampaigns.length > 0 && <label className="flex gap-2 text-sm text-status-warning"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('reconciliation.campaignWarning')} {profile.references.runningCampaigns.map(item => item.name).join(', ')}</label>}
      {error && <p role="alert" className="text-status-error">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn-secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="btn-primary" disabled={busy || !model || unsupported || profile.references.runningCampaigns.length > 0 && !confirmed} onClick={apply}>{t('reconciliation.apply')}</button></div>
    </div>
  </Modal>;
}
