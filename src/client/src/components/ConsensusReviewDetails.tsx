import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import type { WsEvent } from '../hooks/useWebSocket';
import type { ReviewResult } from '../types';
import { getConsensusHistory, retryReviewer, type ConsensusBatch, type ConsensusDecision } from '../api/consensusReview';

export default function ConsensusReviewDetails({ todoId,roundId,onEvent }: { todoId: string; roundId: string; onEvent?: (cb: (event: WsEvent) => void) => () => void }) {
  const { t } = useI18n();
  const [batch,setBatch] = useState<ConsensusBatch>(), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  useEffect(() => {
    let disposed = false, generation = 0;
    const refresh = () => { const request = ++generation;void getConsensusHistory(todoId).then(rows => { if (!disposed && request === generation) setBatch(rows.find(b => b.review_round_id === roundId)); }).catch(e => { if (!disposed) setError(String(e)); }); };
    refresh();
    const unsubscribe = onEvent?.(event => { if (event.todoId === todoId && event.type.startsWith('consensus-review:')) refresh(); });
    return () => { disposed = true;unsubscribe?.(); };
  },[todoId,roundId,onEvent]);
  if (!batch) return error ? <p role="alert">{error}</p> : null;
  const aggregate: ConsensusDecision | null = batch.aggregate_result_json ? JSON.parse(batch.aggregate_result_json) : null;
  return <div className="mt-3 space-y-3">
    <p className="font-semibold">{t('consensus.title')} · {t(`consensus.${batch.strategy}`)} · {t(`consensus.status.${batch.status}`)}</p>
    {error && <p role="alert" className="text-status-error">{error}</p>}
    {batch.failure_reason && <p className="text-status-error">{batch.failure_reason}</p>}
    {batch.jobs.map(job => {
      const result: ReviewResult | null = job.final_result_payload ? JSON.parse(job.final_result_payload) : null;
      return <div key={job.id} className="rounded-xl bg-theme-card p-3 space-y-1">
        <p className="font-semibold">{job.role === 'judge' ? t('consensus.judge') : job.label || t('consensus.reviewer')} · {t(`consensus.status.${job.status}`)} · {t('consensus.weight')}: {job.weight}</p>
        {job.attempts.map(attempt => { const identity = JSON.parse(attempt.execution_snapshot ?? '{}');return <div key={attempt.id} className="text-theme-muted">
          {t('consensus.attempt')} {attempt.attempt_index} · {identity.profileName ?? job.execution_profile_id} · {identity.agent} / {identity.providerAccountLabel ?? t('accounts.legacy')} / {identity.effectiveModel ?? identity.model} / {identity.effort ?? '—'} · {t(`consensus.status.${attempt.status}`)}
          {attempt.duration_ms !== null && <> · {attempt.duration_ms} ms</>}{attempt.cost_usd !== null && <> · ${attempt.cost_usd}</>}
        </div>; })}
        {result && <><p>{t(`review.pipeline.verdict.${result.verdict}`)} · {result.summary}</p><ul>{result.issues.map((issue,i) => <li key={i}>{t(`review.pipeline.severity.${issue.severity}`)}: {issue.description} {issue.files?.join(', ')}</li>)}</ul></>}
        {job.final_error_message && <p className="text-status-error">{job.final_error_message}</p>}
        {['failed','stopped'].includes(job.status) && !['completed','stopping','stopped','recovery_required'].includes(batch.status) && <button className="btn-ghost" disabled={busy} onClick={async () => {
          setBusy(true);setError('');try { await retryReviewer(job.id);setBatch((await getConsensusHistory(todoId)).find(b => b.id === batch.id)); } catch(e) { setError(String(e)); } finally { setBusy(false); }
        }}>{t(job.role === 'judge' ? 'consensus.retryJudge' : 'consensus.retryReviewer')}</button>}
      </div>;
    })}
    {aggregate && <p>{t('consensus.votes')}: {aggregate.approved_votes} / {aggregate.needs_changes_votes} · {t('consensus.weights')}: {aggregate.approved_weight} / {aggregate.needs_changes_weight} · {t(`review.pipeline.verdict.${aggregate.verdict}`)}</p>}
  </div>;
}
