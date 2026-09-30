import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { getProfiles, type ExecutionProfile } from '../../api/executionProfiles';
import { getPolicies, savePolicy, disablePolicy, type ReviewPolicy } from '../../api/consensusReview';

const blank = (): Omit<ReviewPolicy,'id'> => ({ name: '',description: '',strategy: 'majority',failure_policy: 'require_all',
  min_successful_reviewers: 2,judge_execution_profile_id: null,diversity_policy: 'none',max_parallel_reviewers: 3,is_enabled: 1,sort_order: 0,
  members: Array.from({ length: 3 },(_,i) => ({ execution_profile_id: '',label: '',weight: 1,priority: i,is_enabled: 1 })) });

export default function ReviewPoliciesPanel() {
  const { t } = useI18n();
  const [policies,setPolicies] = useState<ReviewPolicy[]>([]), [profiles,setProfiles] = useState<ExecutionProfile[]>([]);
  const [editing,setEditing] = useState<string>(), [draft,setDraft] = useState(blank), [open,setOpen] = useState(false);
  const [error,setError] = useState(''), [saving,setSaving] = useState(false);
  const refresh = () => getPolicies().then(setPolicies);
  useEffect(() => { void Promise.all([refresh(),getProfiles().then(setProfiles)]).catch(e => setError(String(e))); },[]);
  const profileOptions = <><option value="">{t('consensus.selectProfile')}</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</>;
  return <section className="p-5 space-y-4 text-theme-primary">
    <div className="flex justify-between"><h2 className="text-lg font-semibold">{t('consensus.policies')}</h2>
      <button className="btn-primary" onClick={() => { setDraft(blank());setEditing(undefined);setOpen(true); }}>{t('consensus.create')}</button></div>
    {error && <p role="alert" className="text-status-error">{error}</p>}
    {policies.map(policy => <div key={policy.id} className="bg-theme-card rounded-xl p-4 flex items-center justify-between">
      <div><strong>{policy.name}</strong><p className="text-sm text-theme-muted">{t(`consensus.${policy.strategy}`)} · {policy.members.filter(m => m.is_enabled).map(m => m.label || profiles.find(p => p.id === m.execution_profile_id)?.name).join(', ')}</p></div>
      <div className="flex gap-2"><button className="btn-ghost" onClick={() => { setDraft({ ...policy,members: policy.members });setEditing(policy.id);setOpen(true); }}>{t('consensus.edit')}</button>
        <button className="btn-ghost" disabled={!policy.is_enabled} onClick={() => { void disablePolicy(policy.id).then(refresh).catch(e => setError(String(e))); }}>{t('consensus.disable')}</button></div>
    </div>)}
    {open && <form className="bg-theme-card rounded-xl p-4 space-y-3" onSubmit={async e => {
      e.preventDefault();setSaving(true);setError('');
      try { await savePolicy(draft,editing);await refresh();setOpen(false); } catch(e) { setError(String(e)); } finally { setSaving(false); }
    }}>
      <label className="flex gap-2"><input type="checkbox" checked={!!draft.is_enabled} onChange={e => setDraft({ ...draft,is_enabled: e.target.checked ? 1 : 0 })} />{t('consensus.enabled')}</label>
      <label className="block">{t('consensus.name')}<input className="input-field" required maxLength={128} value={draft.name} onChange={e => setDraft({ ...draft,name: e.target.value })} /></label>
      <label className="block">{t('consensus.description')}<textarea className="input-field" maxLength={4096} value={draft.description} onChange={e => setDraft({ ...draft,description: e.target.value })} /></label>
      <label className="block">{t('consensus.strategy')}<select className="input-field" value={draft.strategy} onChange={e => setDraft({ ...draft,strategy: e.target.value as ReviewPolicy['strategy'] })}>
        {(['majority','unanimous','weighted','judge','judge_on_disagreement'] as const).map(s => <option key={s} value={s}>{t(`consensus.${s}`)}</option>)}</select></label>
      <label className="block">{t('consensus.failurePolicy')}<select className="input-field" value={draft.failure_policy} onChange={e => setDraft({ ...draft,failure_policy: e.target.value as ReviewPolicy['failure_policy'] })}>
        <option value="require_all">{t('consensus.require_all')}</option><option value="quorum">{t('consensus.quorum')}</option></select></label>
      {draft.failure_policy === 'quorum' && <label className="block">{t('consensus.minimum')}<input type="number" className="input-field" min={2} max={draft.members.length} value={draft.min_successful_reviewers} onChange={e => setDraft({ ...draft,min_successful_reviewers: Number(e.target.value) })} /></label>}
      <label className="block">{t('consensus.diversity')}<select className="input-field" value={draft.diversity_policy} onChange={e => setDraft({ ...draft,diversity_policy: e.target.value as ReviewPolicy['diversity_policy'] })}>
        {(['none','prefer_provider','prefer_provider_and_account'] as const).map(s => <option key={s} value={s}>{t(`consensus.${s}`)}</option>)}</select></label>
      <label className="block">{t('consensus.parallel')}<input type="number" className="input-field" min={1} max={7} value={draft.max_parallel_reviewers} onChange={e => setDraft({ ...draft,max_parallel_reviewers: Number(e.target.value) })} /></label>
      {draft.strategy.startsWith('judge') && <label className="block">{t('consensus.judgeProfile')}<select required className="input-field" value={draft.judge_execution_profile_id ?? ''} onChange={e => setDraft({ ...draft,judge_execution_profile_id: e.target.value || null })}>{profileOptions}</select></label>}
      <h3 className="font-semibold">{t('consensus.reviewers')}</h3>
      {draft.members.map((member,i) => <div key={member.id ?? i} className="rounded-xl bg-theme-secondary p-3 grid gap-2 sm:grid-cols-4">
        <label>{t('consensus.profile')}<select required className="input-field" value={member.execution_profile_id} onChange={e => setDraft({ ...draft,members: draft.members.map((m,n) => n === i ? { ...m,execution_profile_id: e.target.value } : m) })}>{profileOptions}</select></label>
        <label>{t('consensus.label')}<input className="input-field" maxLength={128} value={member.label} onChange={e => setDraft({ ...draft,members: draft.members.map((m,n) => n === i ? { ...m,label: e.target.value } : m) })} /></label>
        <label>{t('consensus.weight')}<input type="number" className="input-field" min={1} max={10} value={member.weight} onChange={e => setDraft({ ...draft,members: draft.members.map((m,n) => n === i ? { ...m,weight: Number(e.target.value) } : m) })} /></label>
        <label className="flex gap-2"><input type="checkbox" checked={!!member.is_enabled} onChange={e => setDraft({ ...draft,members: draft.members.map((m,n) => n === i ? { ...m,is_enabled: e.target.checked ? 1 : 0 } : m) })} />{t('consensus.enabled')}</label>
        <label>{t('consensus.priority')}<input type="number" className="input-field" value={member.priority} onChange={e => setDraft({ ...draft,members: draft.members.map((m,n) => n === i ? { ...m,priority: Number(e.target.value) } : m) })} /></label>
        <button type="button" className="btn-ghost" disabled={draft.members.length <= 2} onClick={() => setDraft({ ...draft,members: draft.members.filter((_,n) => n !== i) })}>{t('consensus.remove')}</button>
      </div>)}
      <button type="button" className="btn-ghost" disabled={draft.members.length >= 7} onClick={() => setDraft({ ...draft,members: [...draft.members,{ execution_profile_id: '',label: '',weight: 1,priority: draft.members.length,is_enabled: 1 }] })}>{t('consensus.addReviewer')}</button>
      <div className="flex gap-2"><button className="btn-primary" disabled={saving}>{t('consensus.save')}</button><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>{t('consensus.cancel')}</button></div>
    </form>}
  </section>;
}
