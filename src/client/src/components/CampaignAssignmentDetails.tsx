import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import type { WsEvent } from '../hooks/useWebSocket';
import { getCampaignAssignment, saveCampaignFeedback, withdrawCampaignAssignment, type CampaignAssignment } from '../api/evaluationCampaigns';

export default function CampaignAssignmentDetails({ todoId,projectId,onAssignment,onOverride,onEvent,revision=0 }: {
  todoId: string; projectId: string; onAssignment?: (assignment: CampaignAssignment | null)=>void; onOverride?: ()=>void; onEvent?: (cb: (event: WsEvent)=>void)=>()=>void; revision?: number;
}) {
  const { t }=useI18n();
  const [assignment,setAssignment]=useState<CampaignAssignment | null>(null),[note,setNote]=useState(''),[label,setLabel]=useState('unknown'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[localRevision,setLocalRevision]=useState(0);
  useEffect(()=>onEvent?.(event=>{
    if (event.type.startsWith('evaluation-campaign:') && 'todoId' in event && event.todoId===todoId) setLocalRevision(v=>v+1);
  }),[onEvent,todoId]);
  useEffect(()=>{
    let disposed=false;
    getCampaignAssignment(todoId,projectId).then(value=>{
      if (disposed) return;
      setAssignment(value);setLabel(value?.feedback?.label ?? 'unknown');setNote(value?.feedback?.note ?? '');onAssignment?.(value);setError('');
    }).catch(()=>{ if (!disposed) setError(t('campaign.loadError')); });
    return ()=>{ disposed=true; };
  },[todoId,projectId,revision,localRevision,onAssignment,t]);
  async function act(action: ()=>Promise<unknown>) {
    setBusy(true);setError('');try { await action();setLocalRevision(v=>v+1); } catch { setError(t('campaign.actionError')); } finally { setBusy(false); }
  }
  if (!assignment) return error ? <p role="alert" className="text-status-error text-xs">{error}</p> : null;
  return <section className="p-3 rounded-xl border border-theme-border bg-theme-card text-xs space-y-2" aria-label={t('campaign.assignment')}>
    <div className="font-medium">{t('campaign.title')}: {assignment.campaign_name} · {assignment.arm_snapshot.name} · {t(assignment.arm_snapshot.is_control ? 'campaign.control' : 'campaign.experiment')}</div>
    <div>{t('campaign.integrity')}: {t(`campaign.${assignment.integrity_state}`)}{assignment.integrity_reason ? ` · ${t(`campaign.${assignment.integrity_reason}`)}` : ''}</div>
    <details><summary className="cursor-pointer">{t('campaign.explanation')}</summary><dl className="space-y-1 break-all">
      <div>{t('campaign.algorithm')}: {assignment.explanation.algorithm}</div>
      <div>{t('campaign.bucket')}: {assignment.explanation.bucket} / {assignment.explanation.totalWeight} · [{assignment.explanation.rangeStart}, {assignment.explanation.rangeEnd})</div>
      <div>{t('campaign.definitionHash')}: {assignment.campaign_definition_hash}</div>
      <div>{t('campaign.armHash')}: {assignment.arm_definition_hash}</div>
      <div>{t('campaign.configHash')}: {assignment.assigned_review_config_hash}</div>
    </dl></details>
    {onOverride && assignment.integrity_state!=='excluded' && <button type="button" className="btn-ghost text-xs" onClick={onOverride}>{t('campaign.override')}</button>}
    {!assignment.first_execution_at && !assignment.review_started_at && assignment.integrity_state==='clean' && <button type="button" disabled={busy} className="btn-ghost text-xs" onClick={()=>void act(()=>withdrawCampaignAssignment(todoId,projectId))}>{t('campaign.withdraw')}</button>}
    {assignment.review_started_at && <div className="space-y-2">
      <p>{t('campaign.feedbackQuestion')}</p>
      <select aria-label={t('campaign.feedback')} className="input-field text-xs" value={label} onChange={e=>setLabel(e.target.value)}>{['helpful','not_helpful','mixed','unknown'].map(key=><option key={key} value={key}>{t(`campaign.${key}`)}</option>)}</select>
      <textarea aria-label={t('campaign.note')} className="input-field w-full text-xs" maxLength={4096} value={note} onChange={e=>setNote(e.target.value)} placeholder={t('campaign.note')} />
      <button type="button" disabled={busy} className="btn-primary text-xs" onClick={()=>void act(()=>saveCampaignFeedback(todoId,projectId,label,note))}>{t('campaign.saveFeedback')}</button>
    </div>}
    {error && <p role="alert" className="text-status-error">{error}</p>}
  </section>;
}
