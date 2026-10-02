import { getCampaignTreatmentUsage, emptyTreatmentUsage, type TreatmentUsage } from './treatment-usage.js';
import { getDatabase } from '../db/connection.js';
import { getEvaluationCampaign } from './evaluation-campaign-service.js';
import { evaluationResult, normalizeExecutionIdentity } from './review-evaluation-normalize.js';
import { evaluationCsvCell } from './evaluation-csv.js';
import { redactString } from '../logging/redact.js';

interface Outcome {
  id: string; todo_id: string; arm_id: string; assigned_at: string; assignment_bucket: number;
  integrity_state: string; integrity_reason: string | null; first_execution_at: string | null; review_started_at: string | null; finished_at: string | null;
  usage: TreatmentUsage;
  status: string; total_cost_usd: number | null; total_tokens: number | null;
  result_payload: string | null; rework_count: number; manual_approve: number; manual_rework: number; feedback: string | null;
}
const projection=`SELECT a.id,a.todo_id,a.arm_id,a.assigned_at,a.assignment_bucket,a.integrity_state,a.integrity_reason,
  a.first_execution_at,a.review_started_at,a.finished_at,t.status,t.total_cost_usd,t.total_tokens,
  CASE WHEN r.status='completed' THEN r.result_payload ELSE NULL END result_payload,
  (SELECT COUNT(*) FROM todo_execution_rounds w WHERE w.todo_id=t.id AND w.phase='rework' AND w.started_at IS NOT NULL) rework_count,
  (SELECT COUNT(*) FROM review_human_actions h WHERE h.todo_id=t.id AND h.action='manual_approve') manual_approve,
  (SELECT COUNT(*) FROM review_human_actions h WHERE h.todo_id=t.id AND h.action='manual_rework') manual_rework,
  f.label feedback
  FROM evaluation_campaign_assignments a JOIN todos t ON t.id=a.todo_id
  LEFT JOIN todo_execution_rounds r ON r.id=(SELECT rr.id FROM todo_execution_rounds rr WHERE rr.todo_id=t.id AND rr.phase='review' ORDER BY rr.round_index DESC,rr.attempt_index DESC,rr.created_at DESC,rr.id DESC LIMIT 1)
  LEFT JOIN evaluation_campaign_assignment_feedback f ON f.assignment_id=a.id
  WHERE a.campaign_id=?`;
const rate=(n: number,d: number): number | null=>d?n/d:null;
function percentile(sorted: number[],p: number) { return sorted.length ? sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] : null; }

function treatmentMetrics(rows: Outcome[]) {
  const total=rows.reduce((n,r)=>n+r.usage.processAttempts.total,0);
  const measure=(key: 'cost' | 'ioTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'providerDuration' | 'attemptWallDuration')=>{
    const values=rows.map(r=>r.usage[key]);
    const known=values.reduce((n,v)=>n+v.attemptsKnown,0);
    return { value: known ? values.reduce((n,v)=>n+(v.known ?? 0),0) : null,known,coverage: rate(known,total) };
  };
  const cost=measure('cost'),tokens=measure('ioTokens'),cacheRead=measure('cacheReadTokens'),cacheCreation=measure('cacheCreationTokens'),duration=measure('providerDuration'),wall=measure('attemptWallDuration');
  const started=rows.filter(r=>r.usage.processAttempts.total>0);
  const covered=started.filter(r=>r.usage.cost.coverage===1).map(r=>r.usage.cost.known!).sort((a,b)=>a-b);
  return { knownTreatmentCostUsd: cost.value,treatmentCostAttemptsKnown: cost.known,treatmentCostAttemptsTotal: total,treatmentCostCoverage: cost.coverage,
    knownTreatmentIoTokens: tokens.value,treatmentTokenAttemptsKnown: tokens.known,treatmentTokenAttemptsTotal: total,treatmentTokenCoverage: tokens.coverage,
    treatmentCostTodosFullyCovered: covered.length,treatmentCostTodosStarted: started.length,treatmentCostTodoCoverage: rate(covered.length,started.length),
    avgTreatmentCostUsd: covered.length ? covered.reduce((n,v)=>n+v,0)/covered.length : null,p50TreatmentCostUsd: percentile(covered,.5),
    knownCacheReadTokens: cacheRead.value,cacheReadAttemptsKnown: cacheRead.known,cacheReadCoverage: cacheRead.coverage,
    knownCacheCreationTokens: cacheCreation.value,cacheCreationAttemptsKnown: cacheCreation.known,cacheCreationCoverage: cacheCreation.coverage,
    knownAttemptWallDurationMs: wall.value,attemptWallDurationAttemptsKnown: wall.known,attemptWallDurationAttemptsTotal: total,attemptWallDurationCoverage: wall.coverage,
    providerDurationAttemptsTotal: total,knownProviderDurationMs: duration.value,providerDurationAttemptsKnown: duration.known,providerDurationCoverage: duration.coverage,treatmentProcessAttempts: total };
}
function attachUsage(rows: Outcome[], id: string, page?: { limit: number; offset: number }): Outcome[] {
  const usages=getCampaignTreatmentUsage(id,page);
  return rows.map(row=>({ ...row,usage: usages.get(row.todo_id) ?? emptyTreatmentUsage() }));
}

function metrics(rows: Outcome[]) {
  const reached=rows.filter(r=>r.review_started_at!==null);
  const verdicts=reached.map(r=>evaluationResult(r.result_payload)?.verdict).filter(Boolean);
  const durations=rows.flatMap(r=>{
    if (!r.first_execution_at || !r.finished_at || !['completed','failed','stopped','merged'].includes(r.status)) return [];
    const value=Date.parse(r.finished_at)-Date.parse(r.first_execution_at);
    return Number.isFinite(value) && value>=0 ? [value] : [];
  }).sort((a,b)=>a-b);
  const cost=rows.filter(r=>r.total_cost_usd!==null),tokens=rows.filter(r=>r.total_tokens!==null);
  const responses=reached.filter(r=>r.feedback!==null),evaluative=responses.filter(r=>r.feedback!=='unknown');
  const count=(status: string)=>rows.filter(r=>r.status===status).length;
  const helpful=evaluative.filter(r=>r.feedback==='helpful').length,notHelpful=evaluative.filter(r=>r.feedback==='not_helpful').length,mixed=evaluative.filter(r=>r.feedback==='mixed').length;
  const todosWithRework=reached.filter(r=>r.rework_count>0).length;
  const approvedFinalReview=verdicts.filter(v=>v==='approved').length,needsChangesFinalReview=verdicts.filter(v=>v==='needs_changes').length;
  return { ...treatmentMetrics(rows),assignments: rows.length, started: rows.filter(r=>r.first_execution_at!==null).length,reachedReview: reached.length,
    terminal: count('completed')+count('failed')+count('stopped')+count('merged'),completed: count('completed')+count('merged'),failed: count('failed'),stopped: count('stopped'),
    completionRate: rate(count('completed')+count('merged'),rows.length),failureRate: rate(count('failed'),rows.length),
    approvedFinalReview,needsChangesFinalReview,finalReviewSamples: verdicts.length,needsChangesRate: rate(needsChangesFinalReview,verdicts.length),
    todosWithRework,reworkDenominator: reached.length,reworkRate: rate(todosWithRework,reached.length),
    manualApprove: reached.reduce((n,r)=>n+r.manual_approve,0),manualRework: reached.reduce((n,r)=>n+r.manual_rework,0),
    avgTodoDurationMs: durations.length ? durations.reduce((n,d)=>n+d,0)/durations.length : null,p50TodoDurationMs: percentile(durations,.5),p95TodoDurationMs: percentile(durations,.95),durationSamples: durations.length,
    knownTodoCostUsd: cost.length ? cost.reduce((n,r)=>n+r.total_cost_usd!,0) : null,todoCostKnown: cost.length,todoCostTotal: rows.length,todoCostCoverage: rate(cost.length,rows.length),
    knownTodoTokens: tokens.length ? tokens.reduce((n,r)=>n+r.total_tokens!,0) : null,todoTokensKnown: tokens.length,todoTokensTotal: rows.length,todoTokenCoverage: rate(tokens.length,rows.length),
    feedback: { responses: responses.length,evaluative: evaluative.length,denominator: reached.length,responseCoverage: rate(responses.length,reached.length),evaluativeCoverage: rate(evaluative.length,reached.length),
      helpful,notHelpful,mixed,unknown: responses.length-evaluative.length,helpfulRate: rate(helpful,evaluative.length) },lowSample: rows.length<10 };
}
export function listCampaignAssignments(id: string,projectId: string,limit=100,offset=0) {
  const campaign=getEvaluationCampaign(id,projectId);
  const db=getDatabase();
  const rows=attachUsage(db.prepare(projection+' ORDER BY a.assigned_at,a.id LIMIT ? OFFSET ?').all(id,limit,offset) as Outcome[],id,{ limit,offset });
  const total=(db.prepare('SELECT COUNT(*) n FROM evaluation_campaign_assignments WHERE campaign_id=?').get(id) as { n: number }).n;
  return { total,limit,offset,hasMore: offset+rows.length<total,assignments: rows.map(r=>({
    assignment_id: r.id,todo_id: r.todo_id,assigned_at: r.assigned_at,arm_id: r.arm_id,arm_name: redactString(campaign.arms.find(a=>a.id===r.arm_id)?.name ?? ''),
    control: campaign.arms.find(a=>a.id===r.arm_id)?.is_control ?? 0,bucket: r.assignment_bucket,integrity_state: r.integrity_state,integrity_reason: r.integrity_reason,
    started: r.first_execution_at!==null,reached_review: r.review_started_at!==null,todo_status: r.status,
    final_review_verdict: evaluationResult(r.result_payload)?.verdict ?? null,rework_count: r.rework_count,
    known_todo_cost_usd: r.total_cost_usd,known_todo_tokens: r.total_tokens,
    known_treatment_cost_usd: r.usage.cost.known,treatment_cost_attempts_known: r.usage.cost.attemptsKnown,treatment_cost_attempts_total: r.usage.cost.attemptsTotal,treatment_cost_coverage: r.usage.cost.coverage,
    known_treatment_io_tokens: r.usage.ioTokens.known,treatment_token_attempts_known: r.usage.ioTokens.attemptsKnown,treatment_token_attempts_total: r.usage.ioTokens.attemptsTotal,treatment_token_coverage: r.usage.ioTokens.coverage,
    known_cache_read_tokens: r.usage.cacheReadTokens.known,known_cache_creation_tokens: r.usage.cacheCreationTokens.known,
    cache_read_attempts_known: r.usage.cacheReadTokens.attemptsKnown,cache_read_coverage: r.usage.cacheReadTokens.coverage,
    cache_creation_attempts_known: r.usage.cacheCreationTokens.attemptsKnown,cache_creation_coverage: r.usage.cacheCreationTokens.coverage,
    treatment_process_attempts: r.usage.processAttempts.total,known_provider_duration_ms: r.usage.providerDuration.known,
    known_attempt_wall_duration_ms: r.usage.attemptWallDuration.known,attempt_wall_duration_attempts_known: r.usage.attemptWallDuration.attemptsKnown,
    attempt_wall_duration_attempts_total: r.usage.attemptWallDuration.attemptsTotal,attempt_wall_duration_coverage: r.usage.attemptWallDuration.coverage,
    provider_duration_attempts_total: r.usage.providerDuration.attemptsTotal,provider_duration_attempts_known: r.usage.providerDuration.attemptsKnown,provider_duration_coverage: r.usage.providerDuration.coverage,
    treatment_phase_usage: r.usage.phases,
    duration_ms: r.first_execution_at && r.finished_at ? Math.max(0,Date.parse(r.finished_at)-Date.parse(r.first_execution_at)) : null,campaign_feedback: r.feedback,
  })) };
}
export function campaignCsv(page: ReturnType<typeof listCampaignAssignments>) {
  const fields=['assignment_id','todo_id','assigned_at','arm_id','arm_name','control','bucket','integrity_state','integrity_reason','started','reached_review','todo_status','final_review_verdict','rework_count','known_todo_cost_usd','known_todo_tokens','known_treatment_cost_usd','treatment_cost_attempts_known','treatment_cost_attempts_total','treatment_cost_coverage','known_treatment_io_tokens','treatment_token_attempts_known','treatment_token_attempts_total','treatment_token_coverage','known_cache_read_tokens','cache_read_attempts_known','cache_read_coverage','known_cache_creation_tokens','cache_creation_attempts_known','cache_creation_coverage','treatment_process_attempts','known_attempt_wall_duration_ms','attempt_wall_duration_attempts_known','attempt_wall_duration_attempts_total','attempt_wall_duration_coverage','known_provider_duration_ms','provider_duration_attempts_total','provider_duration_attempts_known','provider_duration_coverage','duration_ms','campaign_feedback'] as const;
  return [fields.join(','),...page.assignments.map(row=>fields.map(f=>evaluationCsvCell(row[f])).join(','))].join('\r\n');
}
export function getEvaluationCampaignAnalytics(id: string,projectId: string) {
  const campaign=getEvaluationCampaign(id,projectId),db=getDatabase();
  return db.transaction(()=>{
    const rows=attachUsage(db.prepare(projection).all(id) as Outcome[],id);
    const identities=db.prepare(`SELECT a.arm_id,a.todo_id,a.integrity_state,r.execution_snapshot FROM evaluation_campaign_assignments a
      JOIN todo_execution_rounds r ON r.todo_id=a.todo_id WHERE a.campaign_id=? AND r.started_at IS NOT NULL AND r.execution_snapshot IS NOT NULL
      UNION ALL SELECT a.arm_id,a.todo_id,a.integrity_state,x.execution_snapshot FROM evaluation_campaign_assignments a
      JOIN consensus_review_batches b ON b.todo_id=a.todo_id JOIN consensus_review_jobs j ON j.batch_id=b.id JOIN consensus_review_attempts x ON x.review_job_id=j.id
      WHERE a.campaign_id=? AND x.started_at IS NOT NULL AND x.execution_snapshot IS NOT NULL`).all(id,id) as { arm_id: string; todo_id: string; integrity_state: string; execution_snapshot: string }[];
    const totalWeight=campaign.arms.filter(a=>a.is_enabled).reduce((n,a)=>n+a.weight,0);
    const arms=campaign.arms.map(arm=>{
      const assigned=rows.filter(r=>r.arm_id===arm.id),itt=assigned.filter(r=>!(r.integrity_state==='excluded' && r.first_execution_at===null)),pp=assigned.filter(r=>r.integrity_state==='clean');
      function distribution(protocol: 'itt' | 'pp') {
        const grouped={ providers: new Map<string,Set<string>>(),accounts: new Map<string,Set<string>>(),models: new Map<string,Set<string>>(),efforts: new Map<string,Set<string>>() };
        for (const row of identities) {
          if (row.arm_id!==arm.id || row.integrity_state==='excluded' || protocol==='pp' && row.integrity_state!=='clean') continue;
          const identity=normalizeExecutionIdentity(row.execution_snapshot);
          for (const [group,value] of [['providers',identity.provider],['accounts',identity.providerAccountId],['models',identity.effectiveModel],['efforts',identity.effort]] as const) {
            const key=value ?? 'unknown',set=grouped[group].get(key) ?? new Set<string>();set.add(row.todo_id);grouped[group].set(key,set);
          }
        }
        return Object.fromEntries(Object.entries(grouped).map(([key,map])=>{ const entries=[...map].map(([value,todos])=>({ value,todos: todos.size })).sort((a,b)=>b.todos-a.todos || a.value.localeCompare(b.value));return [key,{ totalIdentities: entries.length,omittedIdentities: Math.max(0,entries.length-100),items: entries.slice(0,100) }]; }));
      }
      return { id: arm.id,name: arm.name,isControl: !!arm.is_control,weight: arm.weight,expectedPercentage: arm.is_enabled ? rate(arm.weight,totalWeight) : 0,
        observedCount: assigned.length,observedPercentage: rate(assigned.length,rows.length),clean: pp.length,contaminated: assigned.filter(r=>r.integrity_state==='contaminated').length,
        excluded: assigned.filter(r=>r.integrity_state==='excluded').length,attrition: metrics(assigned),itt: metrics(itt),pp: metrics(pp),actualIdentities: { itt: distribution('itt'),pp: distribution('pp') } };
    });
    const control=arms.find(a=>a.isControl)!;
    const comparisons=arms.filter(a=>!a.isControl).map(arm=>{
      const compare=(protocol: 'itt' | 'pp')=>Object.fromEntries(['completionRate','failureRate','reworkRate','needsChangesRate','avgTreatmentCostUsd','p50TreatmentCostUsd','avgTodoDurationMs','helpfulRate'].map(key=>{
        const value=(a: typeof arm): number | null=>key==='helpfulRate' ? a[protocol].feedback.helpfulRate : a[protocol][key as 'completionRate'];
        const controlValue=value(control),armValue=value(arm);
        return [key,{ controlValue,armValue,absoluteDifference: controlValue!==null && armValue!==null ? armValue-controlValue : null,relativeRatio: controlValue!==null && controlValue!==0 && armValue!==null ? armValue/controlValue : null }];
      }));
      return { armId: arm.id,controlArmId: control.id,itt: compare('itt'),pp: compare('pp') };
    });
    return { campaignId: id,totalAssigned: rows.length,defaultProtocol: 'itt',arms,comparisons,identityLimit: 100 };
  })();
}
