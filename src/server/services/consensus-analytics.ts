import { evaluationCsvCell } from './evaluation-csv.js';
import { createHash } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import type { ConsensusBatch, ConsensusJob, ConsensusAttempt } from './consensus-review.js';
import { aggregateConsensus, type ConsensusStrategy } from './consensus-result.js';
import { reviewIssueFingerprint, compareIssueSeverity } from './review-issue-identity.js';
import { evaluationResult, normalizeExecutionIdentity, normalizeConsensusFailure, normalizeReviewerFailure } from './review-evaluation-normalize.js';
import type { ReviewIssue } from './review-result.js';
import { redactString } from '../logging/redact.js';

export interface EvaluationFilters {
  period: '7d' | '30d' | '90d' | 'all'; reviewPolicyId?: string; strategy?: ConsensusStrategy;
  executionProfileId?: string; provider?: string; providerAccountId?: string; model?: string; offset: number; limit: number;
}
export function parseEvaluationFilters(query: Record<string,unknown>): EvaluationFilters {
  const allowed = ['period','reviewPolicyId','strategy','executionProfileId','provider','providerAccountId','model','offset','limit'];
  if (Object.keys(query).some(k => !allowed.includes(k))) throw new Error('Unknown analytics filter');
  for (const [key,value] of Object.entries(query)) if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f]/u.test(value)) throw new Error(`Invalid ${key}`);
  const period = query.period ?? 'all';
  if (!['7d','30d','90d','all'].includes(period as string)) throw new Error('Invalid period');
  if (query.strategy && !['majority','unanimous','weighted','judge','judge_on_disagreement'].includes(query.strategy as string)) throw new Error('Invalid strategy');
  const integer = (key: string, fallback: number, max: number) => {
    if (query[key] === undefined) return fallback;
    if (!/^\d+$/.test(query[key] as string) || Number(query[key]) > max) throw new Error(`Invalid ${key}`);
    return Number(query[key]);
  };
  const limit = integer('limit',200,200);
  if (!limit) throw new Error('Invalid limit');
  return { ...query,period,offset: integer('offset',0,1_000_000),limit } as EvaluationFilters;
}
const rate = (n: number,d: number): number | null => d ? n / d : null;
const sum = (values: (number | null)[]) => values.reduce<number>((n,v) => n + (v ?? 0),0);
const average = (values: (number | null)[]) => { const known = values.filter((v): v is number => v !== null); return known.length ? sum(known)/known.length : null; };
const persistedTime = (value: string) => Date.parse(/Z$|[+-]\d{2}:\d{2}$/i.test(value) ? value : value.replace(' ','T')+'Z');
const duration = (start: string | null,end: string | null) => {
  if (!start || !end) return null;
  const value = persistedTime(end) - persistedTime(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
type Identity = ReturnType<typeof normalizeExecutionIdentity>;
const identityGroups = { provider: ['provider'],provider_model: ['provider','effectiveModel','effort'],provider_account: ['provider','providerAccountId'],provider_account_model: ['provider','providerAccountId','effectiveModel','effort'] } as const;
function identityGroup(grouping: keyof typeof identityGroups,identity: Identity) {
  return Object.fromEntries(identityGroups[grouping].map(k=>[k,identity[k]])) as Partial<Identity>;
}
const safeIssue = (issue: ReviewIssue) => ({ ...issue,description: redactString(issue.description).slice(0,4096),files: issue.files?.slice(0,100).map(f=>redactString(f).slice(0,1024)) });
interface Feedback { id: string; batch_id: string; review_job_id: string | null; scope: string; issue_fingerprint: string | null; label: string; note: string; created_at: string; updated_at: string }
interface Action { id: string; todo_id: string; review_round_id: string; batch_id: string | null; action: string; previous_verdict: string | null; created_at: string }
interface Round { id: string; todo_id: string; round_index: number; phase: string; status: string; result_payload: string | null; execution_snapshot: string | null; started_at: string | null; finished_at: string | null; created_at: string; retry_of_round_id: string | null }
function telemetry(attempts: ConsensusAttempt[]) {
  const costKnown = attempts.filter(a => a.cost_usd !== null).length;
  const tokenKnown = attempts.filter(a => a.input_tokens !== null && a.output_tokens !== null).length;
  const durationKnown = attempts.filter(a => a.duration_ms !== null).length;
  return { attempts: attempts.length,knownCostUsd: sum(attempts.map(a => a.cost_usd)),knownTokens: sum(attempts.map(a => a.input_tokens))+sum(attempts.map(a => a.output_tokens)),
    knownDurationMs: sum(attempts.map(a => a.duration_ms)),costAttemptsKnown: costKnown,costAttemptsTotal: attempts.length,
    tokenAttemptsKnown: tokenKnown,tokenAttemptsTotal: attempts.length,durationAttemptsKnown: durationKnown,durationAttemptsTotal: attempts.length,
    costCoverage: rate(costKnown,attempts.length),tokenCoverage: rate(tokenKnown,attempts.length),durationCoverage: rate(durationKnown,attempts.length),avgDurationMs: average(attempts.map(a => a.duration_ms)) };
}
const inWindow = (created: string,start: string | null,end: string) => {
  const time = persistedTime(created);
  return time <= Date.parse(end) && (!start || time >= Date.parse(start));
};
function matchesIdentity(identity: Identity,filters: EvaluationFilters): boolean {
  return (!filters.executionProfileId || identity.executionProfileId === filters.executionProfileId)
    && (!filters.provider || identity.provider === filters.provider) && (!filters.providerAccountId || identity.providerAccountId === filters.providerAccountId)
    && (!filters.model || identity.effectiveModel === filters.model || identity.model === filters.model);
}
function evaluateBatch(batch: ConsensusBatch,jobs: ConsensusJob[],attempts: ConsensusAttempt[],feedback: Feedback[],actions: Action[],rounds: Round[],failovers: { owner_id: string }[],filters: EvaluationFilters,start: string | null,end: string,retainedIssues: Set<string>) {
  const reviewers = jobs.filter(j => j.role === 'reviewer').sort((a,b) => a.priority-b.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const result = batch.status === 'completed' ? evaluationResult(batch.aggregate_result_json) : null;
  const parsed = new Map(reviewers.map(j => [j.id,j.status === 'completed' ? evaluationResult(j.final_result_payload) : null]));
  const successful = reviewers.filter(j => parsed.get(j.id));
  const yes = successful.filter(j => parsed.get(j.id)!.verdict === 'approved').length;
  const no = successful.length-yes;
  const agreement = successful.length >= 2 ? !(yes && no) : null;
  const majority = yes === no ? null : yes > no ? 'approved' : 'needs_changes';
  const aggregateIssues = new Set(result?.verdict === 'needs_changes' ? result.issues.map(reviewIssueFingerprint) : []);
  const issueMap = new Map<string,{ issue: ReviewIssue; jobIds: Set<string> }>();
  for (const job of successful) for (const issue of parsed.get(job.id)!.issues) {
    const key = reviewIssueFingerprint(issue), existing = issueMap.get(key);
    if (existing) { existing.jobIds.add(job.id); if (compareIssueSeverity(issue.severity,existing.issue.severity)<0) existing.issue = issue; }
    else issueMap.set(key,{ issue,jobIds: new Set([job.id]) });
  }
  const relevant = attempts.filter(a => inWindow(a.created_at,start,end) && matchesIdentity(normalizeExecutionIdentity(a.execution_snapshot),filters));
  const allVotes = reviewers.map(j => ({ ...j,result: parsed.get(j.id) ?? null }));
  const deterministic = ['majority','unanimous','weighted'].includes(batch.strategy);
  const counterfactual = (excluded: string[]) => aggregateConsensus({ strategy: batch.strategy,failure_policy: 'quorum',min_successful_reviewers: 1,reviewers: allVotes.filter(v => v.result && !excluded.includes(v.id)) });
  const full = deterministic && successful.length ? counterfactual([]).verdict : null;
  const jobDetails = reviewers.map(job => {
    const jobAttempts = attempts.filter(a => a.review_job_id === job.id).sort((a,b) => a.attempt_index-b.attempt_index);
    const finalAttempt = parsed.get(job.id) ? [...jobAttempts].reverse().find(a => a.status === 'completed') ?? jobAttempts.at(-1) : jobAttempts.at(-1);
    const identity = normalizeExecutionIdentity(finalAttempt?.execution_snapshot ?? null);
    const vote = parsed.get(job.id) ?? null;
    const issues = [...issueMap].filter(([,i]) => i.jobIds.has(job.id));
    const remaining = successful.filter(j => j.id !== job.id);
    const jobFeedback = feedback.filter(f => f.review_job_id === job.id);
    return { id: job.id,policyMemberId: job.policy_member_id,label: job.label,executionProfileId: job.execution_profile_id,status: job.status,
      identity,verdict: vote?.verdict ?? null,minorityVote: !!(vote && yes && no && majority && vote.verdict !== majority),
      agreementWithFinal: vote && result ? vote.verdict === result.verdict : null,
      decisiveVote: deterministic && vote && remaining.length ? counterfactual([job.id]).verdict !== full : null,
      judgeTriggerContribution: batch.strategy === 'judge_on_disagreement' && agreement === false && !!jobs.find(j => j.role === 'judge') && remaining.length > 0 && new Set(remaining.map(j => parsed.get(j.id)!.verdict)).size === 1,
      uniqueIssueCount: issues.filter(([,i]) => i.jobIds.size === 1).length,
      reworkContribution: result?.verdict === 'needs_changes' && issues.some(([fp]) => aggregateIssues.has(fp)),
      confirmedFindingCount: jobFeedback.filter(f => f.scope === 'issue' && f.label === 'confirmed').length,
      rejectedFindingCount: jobFeedback.filter(f => f.scope === 'issue' && f.label === 'rejected').length,
      feedback: jobFeedback.slice(0,200),issues: issues.slice(0,200).map(([fingerprint,i]) => ({ fingerprint,...safeIssue(i.issue),source: 'reviewer',shared: i.jobIds.size > 1,includedInAggregate: aggregateIssues.has(fingerprint) })),
      issueCount: issues.length,failureCategory: normalizeReviewerFailure(job.final_error_message,job.status),
      failoverCount: failovers.filter(f => f.owner_id === job.id).length,
      telemetry: telemetry(relevant.filter(a => a.review_job_id === job.id)),
      attempts: jobAttempts.slice(-200).map(a => ({ id: a.id,status: a.status,identity: normalizeExecutionIdentity(a.execution_snapshot),failureCategory: normalizeReviewerFailure(a.error_message,a.status),createdAt: a.created_at })) };
  });
  const identities = jobDetails.map(j => j.identity);
  const distinct = (values: (string | null)[]) => new Set(values.filter((v): v is string => v !== null)).size;
  const diversity = { distinctProviders: distinct(identities.map(i => i.provider)),distinctAccounts: distinct(identities.map(i => i.providerAccountId)),
    distinctModels: distinct(identities.map(i => i.effectiveModel)),distinctProviderAccountPairs: distinct(identities.map(i => i.provider && i.providerAccountId ? JSON.stringify([i.provider,i.providerAccountId]) : null)),
    requestedDiversity: batch.diversity_policy,identityCoverage: rate(identities.filter(i => i.provider && i.providerAccountId && i.effectiveModel).length,identities.length) };
  const judge = jobs.find(j => j.role === 'judge');
  const judgeResult = judge?.status === 'completed' ? evaluationResult(judge.final_result_payload) : null;
  const thisRound = rounds.find(r => r.id === batch.review_round_id);
  const nextReview = thisRound && rounds.find(r => r.phase === 'review' && r.round_index > thisRound.round_index && !r.retry_of_round_id);
  const reworks = thisRound ? rounds.filter(r => r.phase === 'rework' && r.round_index > thisRound.round_index && (!nextReview || r.round_index < nextReview.round_index)) : [];
  const nextResult = nextReview?.status === 'completed' ? evaluationResult(nextReview.result_payload) : null;
  const previousFingerprints = new Set(result?.issues.map(reviewIssueFingerprint) ?? []);
  const nextFingerprints = new Set(nextResult?.issues.map(reviewIssueFingerprint) ?? []);
  const recurring = [...previousFingerprints].filter(fp => nextFingerprints.has(fp)).length;
  const recurrence = reworks.length && nextResult ? { nextReviewRoundId: nextReview!.id,previousIssueCount: previousFingerprints.size,recurringIssueCount: recurring,notRepeatedAfterReworkCount: previousFingerprints.size-recurring } : null;
  const policySnapshot = { strategy: batch.strategy,failurePolicy: batch.failure_policy,quorum: batch.min_successful_reviewers,diversity: batch.diversity_policy,
    members: reviewers.map(j => ({ profile: j.execution_profile_id,weight: j.weight,priority: j.priority })).sort((a,b)=>a.priority-b.priority || a.profile.localeCompare(b.profile) || a.weight-b.weight),judgeProfile: batch.judge_execution_profile_id };
  const batchDurationMs = duration(batch.created_at,batch.finished_at);
  const reviewerTelemetry = telemetry(relevant.filter(a => reviewers.some(j => j.id === a.review_job_id)));
  const judgeTelemetry = telemetry(relevant.filter(a => a.review_job_id === judge?.id));
  return { id: batch.id,todoId: batch.todo_id,createdAt: batch.created_at,policyId: batch.review_policy_id,
    policyVariantId: createHash('sha256').update(JSON.stringify(policySnapshot)).digest('hex'),policySnapshot,
    strategy: batch.strategy,failurePolicy: batch.failure_policy,status: batch.status,finalVerdict: result?.verdict ?? null,
    reviewerCount: reviewers.length,successfulReviewers: successful.length,failedReviewers: reviewers.filter(j => j.status === 'failed').length,
    agreement,disagreement: agreement === null ? null : !agreement,tieBatch: successful.length >= 2 && yes === no,
    reworkTriggered: reworks.length > 0,recurrence,batchDurationMs,serialReviewerTimeMs: reviewerTelemetry.durationAttemptsKnown ? reviewerTelemetry.knownDurationMs : null,
    parallelismRatio: batchDurationMs && reviewerTelemetry.durationAttemptsKnown ? reviewerTelemetry.knownDurationMs/batchDurationMs : null,
    judgeInvoked: !!judge,judge: { invoked: !!judge,status: judge?.status ?? null,verdict: judgeResult?.verdict ?? null,
      agreedWithMajority: judgeResult && majority ? judgeResult.verdict === majority : null,overrodeMajority: judgeResult && majority ? judgeResult.verdict !== majority : null,
      durationMs: judge ? duration(judge.started_at,judge.finished_at) : null,telemetry: judgeTelemetry,
      issues: (judgeResult?.issues ?? []).slice(0,200).map(i => ({ ...safeIssue(i),fingerprint: reviewIssueFingerprint(i),source: 'judge' })) },
    diversity: { ...diversity,providerDiverse: diversity.distinctProviders > 1,accountDiverse: diversity.distinctAccounts > 1,modelDiverse: diversity.distinctModels > 1,
      achievedProviderDiversity: diversity.distinctProviders > 1,achievedAccountDiversity: diversity.distinctAccounts > 1,achievedModelDiversity: diversity.distinctModels > 1 },
    telemetry: telemetry(relevant),knownReviewerCostUsd: reviewerTelemetry.knownCostUsd,knownJudgeCostUsd: judgeTelemetry.knownCostUsd,knownConsensusCostUsd: telemetry(relevant).knownCostUsd,
    failureCategory: batch.failure_policy==='require_all' && batch.failure_reason==='reviewer_quorum_failed' ? 'reviewer_failure' : normalizeConsensusFailure(batch.failure_reason,batch.status),jobs: jobDetails,
    uniqueIssueCount: [...issueMap.values()].filter(i => i.jobIds.size === 1).length,sharedIssueCount: [...issueMap.values()].filter(i => i.jobIds.size>1).length,
    sharedIssueRate: rate([...issueMap.values()].filter(i => i.jobIds.size>1).length,issueMap.size),
    issues: [...issueMap].filter(([fp])=>retainedIssues.has(fp)).slice(0,200).map(([fingerprint,i]) => ({ fingerprint,...safeIssue(i.issue),reviewerCount: i.jobIds.size,unique: i.jobIds.size === 1,includedInAggregate: aggregateIssues.has(fingerprint),
      confirmed: feedback.filter(f=>f.issue_fingerprint===fingerprint && f.label==='confirmed').length,rejected: feedback.filter(f=>f.issue_fingerprint===fingerprint && f.label==='rejected').length })),
    thirdReviewer: reviewers.length >= 3 ? { jobId: reviewers[2].id,changedDeterministicVerdict: jobDetails[2].decisiveVote,introducedUniqueFinding: jobDetails[2].uniqueIssueCount>0,onlyDuplicatedFindings: jobDetails[2].issueCount>0 && !jobDetails[2].uniqueIssueCount } : null,
    feedback: feedback.slice(0,200),feedbackMetrics: { batchLabeled: Number(feedback.some(f=>f.scope==='batch')),reviewersLabeled: feedback.filter(f=>f.scope==='reviewer_job').length,issuesLabeled: feedback.filter(f=>f.scope==='issue').length,
      confirmed: feedback.filter(f=>f.scope==='issue' && f.label==='confirmed').length,rejected: feedback.filter(f=>f.scope==='issue' && f.label==='rejected').length,uncertain: feedback.filter(f=>f.scope==='issue' && f.label==='uncertain').length },
    humanActions: actions.filter(a => a.review_round_id === batch.review_round_id).slice(0,200),
    hadQuotaFailover: jobDetails.some(j => j.failoverCount>0),hadFailure: reviewers.some(j => j.status === 'failed') || attempts.some(a => a.status === 'failed') };
}
type BatchEvaluation = ReturnType<typeof evaluateBatch>;
function accumulator() {
  return { sampleCount: 0,totalBatches: 0,completedBatches: 0,failedBatches: 0,stoppedBatches: 0,approvedBatches: 0,needsChangesBatches: 0,
    agreementBatches: 0,disagreementBatches: 0,judgeInvokedBatches: 0,reworkTriggeredBatches: 0,reviewersConfigured: 0,successfulReviewers: 0,failedReviewers: 0,
    durationTotal: 0,durationCount: 0,knownCostUsd: 0,knownTokens: 0,costAttemptsKnown: 0,costAttemptsTotal: 0,tokenAttemptsKnown: 0,tokenAttemptsTotal: 0,
    durationAttemptsKnown: 0,durationAttemptsTotal: 0,reviewerFailureIncidence: 0,batchFailureDueReviewerFailure: 0,quorumSalvageCount: 0,
    feedbackBatchesLabeled: 0,feedbackBatchesTotal: 0,feedbackIssuesLabeled: 0,feedbackIssuesTotal: 0,feedbackReviewersLabeled: 0,feedbackReviewersTotal: 0,
    confirmedIssueCount: 0,rejectedIssueCount: 0,uncertainIssueCount: 0 };
}
type Accumulator = ReturnType<typeof accumulator>;
function addBatch(a: Accumulator,b: BatchEvaluation) {
  a.sampleCount++;a.totalBatches++;a.completedBatches+=Number(b.status==='completed');a.failedBatches+=Number(b.status==='failed');a.stoppedBatches+=Number(b.status==='stopped');
  a.approvedBatches+=Number(b.finalVerdict==='approved');a.needsChangesBatches+=Number(b.finalVerdict==='needs_changes');
  a.agreementBatches+=Number(b.agreement===true);a.disagreementBatches+=Number(b.disagreement===true);a.judgeInvokedBatches+=Number(b.judgeInvoked);a.reworkTriggeredBatches+=Number(b.reworkTriggered);
  a.reviewersConfigured+=b.reviewerCount;a.successfulReviewers+=b.successfulReviewers;a.failedReviewers+=b.failedReviewers;
  if (b.batchDurationMs!==null) { a.durationCount++;a.durationTotal+=b.batchDurationMs; }
  for (const key of ['knownCostUsd','knownTokens','costAttemptsKnown','costAttemptsTotal','tokenAttemptsKnown','tokenAttemptsTotal','durationAttemptsKnown','durationAttemptsTotal'] as const) a[key]+=b.telemetry[key];
  a.reviewerFailureIncidence+=Number(b.failedReviewers>0);a.batchFailureDueReviewerFailure+=Number(b.status==='failed' && ['reviewer_failure','quorum_failure'].includes(b.failureCategory ?? ''));
  a.quorumSalvageCount+=Number(b.failurePolicy==='quorum' && b.failedReviewers>0 && b.status==='completed');
  a.feedbackBatchesTotal++;a.feedbackReviewersTotal+=b.reviewerCount;a.feedbackIssuesTotal+=b.jobs.reduce((n,j)=>n+j.issueCount,0);
  a.feedbackBatchesLabeled+=b.feedbackMetrics.batchLabeled;
  a.feedbackReviewersLabeled+=b.feedbackMetrics.reviewersLabeled;a.feedbackIssuesLabeled+=b.feedbackMetrics.issuesLabeled;
  a.confirmedIssueCount+=b.feedbackMetrics.confirmed;a.rejectedIssueCount+=b.feedbackMetrics.rejected;a.uncertainIssueCount+=b.feedbackMetrics.uncertain;
}
function finish(a: Accumulator) {
  return { ...a,agreementRate: rate(a.agreementBatches,a.agreementBatches+a.disagreementBatches),disagreementRate: rate(a.disagreementBatches,a.agreementBatches+a.disagreementBatches),
    judgeInvocationRate: rate(a.judgeInvokedBatches,a.totalBatches),reworkRate: rate(a.reworkTriggeredBatches,a.totalBatches),failureRate: rate(a.failedBatches,a.totalBatches),
    avgReviewersConfigured: rate(a.reviewersConfigured,a.totalBatches),avgSuccessfulReviewers: rate(a.successfulReviewers,a.totalBatches),avgFailedReviewers: rate(a.failedReviewers,a.totalBatches),
    avgBatchDurationMs: rate(a.durationTotal,a.durationCount),costCoverage: rate(a.costAttemptsKnown,a.costAttemptsTotal),tokenCoverage: rate(a.tokenAttemptsKnown,a.tokenAttemptsTotal),durationCoverage: rate(a.durationAttemptsKnown,a.durationAttemptsTotal),
    quorumSalvageRate: rate(a.quorumSalvageCount,a.reviewerFailureIncidence),batchFeedbackCoverage: rate(a.feedbackBatchesLabeled,a.feedbackBatchesTotal),reviewerFeedbackCoverage: rate(a.feedbackReviewersLabeled,a.feedbackReviewersTotal),issueFeedbackCoverage: rate(a.feedbackIssuesLabeled,a.feedbackIssuesTotal),
    confirmedFindingRate: rate(a.confirmedIssueCount,a.confirmedIssueCount+a.rejectedIssueCount),rejectedFindingRate: rate(a.rejectedIssueCount,a.confirmedIssueCount+a.rejectedIssueCount),lowSample: a.sampleCount<10 };
}
function reviewerAccumulator() {
  return { jobs: 0,completedJobs: 0,failedJobs: 0,stoppedJobs: 0,approvalVotes: 0,needsChangesVotes: 0,agreementWithFinal: 0,disagreementWithFinal: 0,minorityVotes: 0,minorityEligibleVotes: 0,
    uniqueIssueCount: 0,uniqueIssueBatchCount: 0,reworkContributionCount: 0,decisiveVotes: 0,judgeTriggerContributions: 0,confirmedFindingCount: 0,rejectedFindingCount: 0,
    knownCostUsd: 0,knownTokens: 0,knownDurationMs: 0,attempts: 0,costAttemptsKnown: 0,tokenAttemptsKnown: 0,durationAttemptsKnown: 0,failoverCount: 0 };
}
type ReviewerAccumulator = ReturnType<typeof reviewerAccumulator>;
function addReviewer(a: ReviewerAccumulator,j: BatchEvaluation['jobs'][number],b: BatchEvaluation) {
  a.jobs++;a.completedJobs+=Number(j.status==='completed');a.failedJobs+=Number(j.status==='failed');a.stoppedJobs+=Number(j.status==='stopped');
  a.approvalVotes+=Number(j.verdict==='approved');a.needsChangesVotes+=Number(j.verdict==='needs_changes');a.agreementWithFinal+=Number(j.agreementWithFinal===true);a.disagreementWithFinal+=Number(j.agreementWithFinal===false);
  a.minorityVotes+=Number(j.minorityVote);a.minorityEligibleVotes+=Number(!!j.verdict && b.disagreement===true && !b.tieBatch);
  a.uniqueIssueCount+=j.uniqueIssueCount;a.uniqueIssueBatchCount+=Number(j.uniqueIssueCount>0);a.reworkContributionCount+=Number(j.reworkContribution);
  a.decisiveVotes+=Number(j.decisiveVote);a.judgeTriggerContributions+=Number(j.judgeTriggerContribution);a.confirmedFindingCount+=j.confirmedFindingCount;a.rejectedFindingCount+=j.rejectedFindingCount;
  a.failoverCount+=j.failoverCount;
  for (const key of ['knownCostUsd','knownTokens','knownDurationMs','attempts','costAttemptsKnown','tokenAttemptsKnown','durationAttemptsKnown'] as const) a[key]+=j.telemetry[key];
}
function finishReviewer(a: ReviewerAccumulator) {
  return { ...a,sampleCount: a.jobs,lowSample: a.jobs<10,approvalRate: rate(a.approvalVotes,a.approvalVotes+a.needsChangesVotes),finalAlignmentRate: rate(a.agreementWithFinal,a.agreementWithFinal+a.disagreementWithFinal),minorityRate: rate(a.minorityVotes,a.minorityEligibleVotes),
    avgDurationMs: rate(a.knownDurationMs,a.durationAttemptsKnown),telemetryCoverage: { cost: rate(a.costAttemptsKnown,a.attempts),tokens: rate(a.tokenAttemptsKnown,a.attempts),duration: rate(a.durationAttemptsKnown,a.attempts) } };
}

export function getConsensusAnalytics(projectId: string,filters: EvaluationFilters,batchId?: string,issueOffset=0) {
  const db = getDatabase(),end = new Date().toISOString();
  const start = filters.period==='all' ? null : new Date(Date.parse(end)-Number(filters.period.slice(0,-1))*86400000).toISOString();
  return db.transaction(() => {
    const summary = accumulator();
    const groups = { strategies: new Map<string,Accumulator>(),policies: new Map<string,Accumulator>(),failurePolicies: new Map<string,Accumulator>(),diversity: new Map<string,Accumulator>() };
    const members = new Map<string,{ label: string; metrics: ReviewerAccumulator }>();
    const policySnapshots = new Map<string,BatchEvaluation['policySnapshot']>();
    const identities = new Map<string,{ grouping: string; identity: Partial<Identity>; metrics: ReviewerAccumulator }>();
    const issues = new Map<string,{ fingerprint: string; description: string; files?: string[]; severity: ReviewIssue['severity']; reviewerCount: number; batchCount: number; uniqueCount: number; sharedCount: number; confirmed: number; rejected: number }>();
    const daily = new Map<string,{ date: string; batches: number; agreement: number; disagreement: number }>();
    const batchFailures: Record<string,number> = {},reviewerFailures: Record<string,number> = {};
    let groupRowsOmitted = false,issueRowsOmitted = false,lastId = '',seen = 0;
    const batches: BatchEvaluation[] = [];
    const judge = { judgeInvocations: 0,judgeCompleted: 0,judgeFailed: 0,judgeApproved: 0,judgeNeedsChanges: 0,judgeAgreedWithMajority: 0,judgeOverrodeMajority: 0,knownJudgeTokens: 0,knownJudgeCostUsd: 0,durationTotal: 0,durationCount: 0,costKnown: 0,attempts: 0 };
    const failover = { reviewerJobsWithFailover: 0,reviewerFailoverCount: 0,failoverSuccessCount: 0,failoverEventuallyFailedCount: 0 };
    const human = { batchFeedbackCorrect: 0,batchFeedbackIncorrect: 0,manualApproveAfterNeedsChanges: 0,manualReworkAfterApproved: 0 };
    const recurrence = { chains: 0,previousIssueCount: 0,recurringIssueCount: 0,notRepeatedAfterReworkCount: 0 };
    const params: unknown[] = [projectId,start,start,end];
    let where = 't.project_id=? AND (? IS NULL OR julianday(b.created_at)>=julianday(?)) AND julianday(b.created_at)<=julianday(?)';
    if (filters.reviewPolicyId) { where+=' AND b.review_policy_id=?';params.push(filters.reviewPolicyId); }
    if (filters.strategy) { where+=' AND b.strategy=?';params.push(filters.strategy); }
    if (batchId) { where+=' AND b.id=?';params.push(batchId); }
    db.function('evaluation_identity_matches',{ deterministic: true },(payload: string | null)=>Number(matchesIdentity(normalizeExecutionIdentity(payload),filters)));
    if (filters.provider || filters.model || filters.providerAccountId || filters.executionProfileId) {
      where+=' AND EXISTS(SELECT 1 FROM consensus_review_jobs ej JOIN consensus_review_attempts ea ON ea.review_job_id=ej.id WHERE ej.batch_id=b.id AND evaluation_identity_matches(ea.execution_snapshot)=1)';
    }
    db.function('evaluation_issue_fingerprint',{ deterministic: true },(payload: string)=>{
      try { const issue=evaluationResult(JSON.stringify({ verdict: 'needs_changes',issues: [JSON.parse(payload)] }))?.issues[0];return issue ? reviewIssueFingerprint(issue) : null; } catch { return null; }
    });
    const topIssueRows=db.prepare(`SELECT evaluation_issue_fingerprint(i.value) fingerprint,COUNT(*) OVER() total FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id
      JOIN consensus_review_jobs j ON j.batch_id=b.id JOIN json_each(CASE WHEN json_valid(j.final_result_payload) THEN json_extract(j.final_result_payload,'$.issues') ELSE '[]' END) i
      WHERE ${where} AND j.role='reviewer' AND j.status='completed' AND evaluation_issue_fingerprint(i.value) IS NOT NULL
      GROUP BY fingerprint ORDER BY COUNT(DISTINCT b.id) DESC,COUNT(DISTINCT j.id) DESC,fingerprint LIMIT ? OFFSET ?`).all(...params,filters.limit+1,issueOffset) as { fingerprint: string; total: number }[];
    const topIssues=new Set(topIssueRows.slice(0,filters.limit).map(i=>i.fingerprint));issueRowsOmitted=issueOffset>0 || topIssueRows.length>filters.limit;
    const topMembers=db.prepare(`SELECT COALESCE(j.policy_member_id,'unknown') member_id FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id
      JOIN consensus_review_jobs j ON j.batch_id=b.id WHERE ${where} AND j.role='reviewer' GROUP BY member_id ORDER BY COUNT(*) DESC,member_id LIMIT 101`).all(...params) as { member_id: string }[];
    const retainedMembers=new Set(topMembers.slice(0,100).map(j=>j.member_id));groupRowsOmitted=topMembers.length>100;
    db.function('evaluation_identity_group',{ deterministic: true },(grouping: keyof typeof identityGroups,payload: string | null)=>JSON.stringify([grouping,identityGroup(grouping,normalizeExecutionIdentity(payload))]));
    const topIdentityRows=db.prepare(`WITH identity_observations AS (SELECT evaluation_identity_group(d.grouping,(SELECT a.execution_snapshot FROM consensus_review_attempts a WHERE a.review_job_id=j.id ORDER BY CASE WHEN j.status='completed' AND a.status='completed' THEN 0 ELSE 1 END,a.attempt_index DESC LIMIT 1)) identity_key
      FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id JOIN consensus_review_jobs j ON j.batch_id=b.id
      CROSS JOIN (SELECT 'provider' grouping UNION ALL SELECT 'provider_model' UNION ALL SELECT 'provider_account' UNION ALL SELECT 'provider_account_model') d
      WHERE ${where} AND j.role='reviewer'
      UNION ALL SELECT evaluation_identity_group(d.grouping,a.execution_snapshot) identity_key
      FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id JOIN consensus_review_jobs j ON j.batch_id=b.id JOIN consensus_review_attempts a ON a.review_job_id=j.id
      CROSS JOIN (SELECT 'provider' grouping UNION ALL SELECT 'provider_model' UNION ALL SELECT 'provider_account' UNION ALL SELECT 'provider_account_model') d
      WHERE ${where} AND j.role='reviewer' AND (? IS NULL OR julianday(a.created_at)>=julianday(?)) AND julianday(a.created_at)<=julianday(?) AND evaluation_identity_matches(a.execution_snapshot)=1)
      SELECT identity_key FROM identity_observations GROUP BY identity_key ORDER BY COUNT(*) DESC,identity_key LIMIT 101`).all(...params,...params,start,start,end) as { identity_key: string }[];
    const retainedIdentities=new Set(topIdentityRows.slice(0,100).map(i=>i.identity_key));groupRowsOmitted ||= topIdentityRows.length>100;
    const retainedDates=new Set((db.prepare(`SELECT date(b.created_at) date FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id WHERE ${where} GROUP BY date ORDER BY date DESC LIMIT 201`).all(...params) as { date: string }[]).map(d=>d.date));
    const dailyRowsOmitted=retainedDates.size>200;
    if (dailyRowsOmitted) retainedDates.delete([...retainedDates].at(-1)!);
    const knownDurationWhere=`${where} AND b.finished_at IS NOT NULL AND julianday(b.finished_at)>=julianday(b.created_at)`;
    const durationCount=(db.prepare(`SELECT COUNT(*) count FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id WHERE ${knownDurationWhere}`).get(...params) as { count: number }).count;
    const quantile=(q: number) => durationCount ? (db.prepare(`SELECT ROUND((julianday(b.finished_at)-julianday(b.created_at))*86400000) duration FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id WHERE ${knownDurationWhere} ORDER BY duration LIMIT 1 OFFSET ?`).get(...params,Math.max(0,Math.ceil(durationCount*q)-1)) as { duration: number }).duration : null;
    while (true) {
      const page = db.prepare(`SELECT b.* FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id WHERE ${where} AND b.id>? ORDER BY b.id LIMIT 200`).all(...params,lastId) as ConsensusBatch[];
      if (!page.length) break;
      lastId=page.at(-1)!.id;
      const ids=page.map(b=>b.id),marks=ids.map(()=>'?').join(',');
      const jobs=db.prepare(`SELECT id,batch_id,role,policy_member_id,execution_profile_id,label,weight,priority,status,final_result_payload,final_error_message,created_at,started_at,finished_at FROM consensus_review_jobs WHERE batch_id IN (${marks})`).all(...ids) as ConsensusJob[];
      const attempts=db.prepare(`SELECT a.id,a.review_job_id,a.attempt_index,a.status,a.execution_snapshot,a.error_message,a.duration_ms,a.input_tokens,a.output_tokens,a.cost_usd,a.created_at FROM consensus_review_attempts a JOIN consensus_review_jobs j ON j.id=a.review_job_id WHERE j.batch_id IN (${marks})`).all(...ids) as ConsensusAttempt[];
      const feedback=db.prepare(`SELECT id,batch_id,review_job_id,scope,issue_fingerprint,label,note,created_at,updated_at FROM review_evaluation_feedback WHERE batch_id IN (${marks}) AND (? IS NULL OR julianday(created_at)>=julianday(?)) AND julianday(created_at)<=julianday(?)`).all(...ids,start,start,end) as Feedback[];
      const todoIds=[...new Set(page.map(b=>b.todo_id))],todoMarks=todoIds.map(()=>'?').join(',');
      const rounds=db.prepare(`SELECT id,todo_id,round_index,phase,status,result_payload,execution_snapshot,started_at,finished_at,created_at,retry_of_round_id FROM todo_execution_rounds WHERE todo_id IN (${todoMarks}) ORDER BY round_index`).all(...todoIds) as Round[];
      const actions=db.prepare(`SELECT * FROM review_human_actions WHERE todo_id IN (${todoMarks})`).all(...todoIds) as Action[];
      const events=db.prepare(`SELECT e.owner_id FROM account_failover_events e JOIN consensus_review_jobs j ON j.id=e.owner_id WHERE e.owner_type='consensus_reviewer' AND j.batch_id IN (${marks})`).all(...ids) as { owner_id: string }[];
      for (const row of page) {
        const rowJobs=jobs.filter(j=>j.batch_id===row.id),jobIds=new Set(rowJobs.map(j=>j.id));
        const rowAttempts=attempts.filter(a=>jobIds.has(a.review_job_id));
        if ((filters.provider || filters.model || filters.providerAccountId || filters.executionProfileId) && !rowAttempts.some(a=>matchesIdentity(normalizeExecutionIdentity(a.execution_snapshot),filters))) continue;
        const b=evaluateBatch(row,rowJobs,rowAttempts,feedback.filter(f=>f.batch_id===row.id),actions.filter(a=>a.todo_id===row.todo_id),rounds.filter(r=>r.todo_id===row.todo_id),events,filters,start,end,topIssues);
        addBatch(summary,b);
        if (seen++ >= filters.offset && batches.length<filters.limit) batches.push(b);
        const date=b.createdAt.slice(0,10);
        if (retainedDates.has(date)) { const day=daily.get(date)??{ date,batches: 0,agreement: 0,disagreement: 0 };day.batches++;day.agreement+=Number(b.agreement===true);day.disagreement+=Number(b.disagreement===true);daily.set(date,day); }
        for (const [map,key] of [[groups.strategies,b.strategy],[groups.policies,JSON.stringify([b.policyId,b.policyVariantId])],[groups.failurePolicies,b.failurePolicy],
          ...(['provider','account','model'] as const).map(k=>[groups.diversity,`${k}:${b.diversity[`${k}Diverse`] ? 'diverse' : 'homogeneous'}`] as const)] as const) {
          if (!map.has(key) && map.size>=100) { groupRowsOmitted=true;continue; }
          const value=map.get(key)??accumulator();addBatch(value,b);map.set(key,value);
          if (map===groups.policies) policySnapshots.set(key,b.policySnapshot);
        }
        if (b.failureCategory) batchFailures[b.failureCategory]=(batchFailures[b.failureCategory]??0)+1;
        for (const j of b.jobs) {
          if (j.failureCategory) reviewerFailures[j.failureCategory]=(reviewerFailures[j.failureCategory]??0)+1;
          const memberKey=j.policyMemberId??'unknown';
          if (retainedMembers.has(memberKey)) { const m=members.get(memberKey)??{ label: j.label,metrics: reviewerAccumulator() };addReviewer(m.metrics,j,b);members.set(memberKey,m); }
          for (const grouping of Object.keys(identityGroups) as (keyof typeof identityGroups)[]) {
            const identity=identityGroup(grouping,j.identity),key=JSON.stringify([grouping,identity]);
            if (!retainedIdentities.has(key)) continue;
            const a=identities.get(key)??{ grouping,identity,metrics: reviewerAccumulator() };addReviewer(a.metrics,{ ...j,telemetry: telemetry([]) },b);identities.set(key,a);
          }
          if (j.failoverCount) { failover.reviewerJobsWithFailover++;failover.reviewerFailoverCount+=j.failoverCount;failover.failoverSuccessCount+=Number(j.status==='completed');failover.failoverEventuallyFailedCount+=Number(j.status==='failed'); }
        }
        const reviewerIds=new Set(b.jobs.map(j=>j.id));
        for (const attempt of rowAttempts) {
          const actualIdentity=normalizeExecutionIdentity(attempt.execution_snapshot);
          if (!reviewerIds.has(attempt.review_job_id) || !inWindow(attempt.created_at,start,end) || !matchesIdentity(actualIdentity,filters)) continue;
          const usage=telemetry([attempt]);
          for (const grouping of Object.keys(identityGroups) as (keyof typeof identityGroups)[]) {
            const identity=identityGroup(grouping,actualIdentity),key=JSON.stringify([grouping,identity]);
            if (!retainedIdentities.has(key)) continue;
            const a=identities.get(key)??{ grouping,identity,metrics: reviewerAccumulator() };
            for (const field of ['knownCostUsd','knownTokens','knownDurationMs','attempts','costAttemptsKnown','tokenAttemptsKnown','durationAttemptsKnown'] as const) a.metrics[field]+=usage[field];
            identities.set(key,a);
          }
        }
        for (const i of b.issues) {
          if (!topIssues.has(i.fingerprint)) continue;
          const a=issues.get(i.fingerprint)??{ fingerprint: i.fingerprint,description: i.description,files: i.files,severity: i.severity,reviewerCount: 0,batchCount: 0,uniqueCount: 0,sharedCount: 0,confirmed: 0,rejected: 0 };
          a.batchCount++;a.reviewerCount+=i.reviewerCount;a.uniqueCount+=Number(i.unique);a.sharedCount+=Number(!i.unique);
          if (compareIssueSeverity(i.severity,a.severity)<0) a.severity=i.severity;
          a.confirmed+=i.confirmed;a.rejected+=i.rejected;issues.set(i.fingerprint,a);
        }
        if (b.judgeInvoked) { judge.judgeInvocations++;judge.judgeCompleted+=Number(b.judge.status==='completed');judge.judgeFailed+=Number(b.judge.status==='failed');judge.judgeApproved+=Number(b.judge.verdict==='approved');judge.judgeNeedsChanges+=Number(b.judge.verdict==='needs_changes');judge.judgeAgreedWithMajority+=Number(b.judge.agreedWithMajority===true);judge.judgeOverrodeMajority+=Number(b.judge.overrodeMajority===true);judge.knownJudgeTokens+=b.judge.telemetry.knownTokens;judge.knownJudgeCostUsd+=b.judge.telemetry.knownCostUsd;judge.costKnown+=b.judge.telemetry.costAttemptsKnown;judge.attempts+=b.judge.telemetry.attempts;if (b.judge.durationMs!==null) { judge.durationTotal+=b.judge.durationMs;judge.durationCount++; } }
        if (b.recurrence) { recurrence.chains++;recurrence.previousIssueCount+=b.recurrence.previousIssueCount;recurrence.recurringIssueCount+=b.recurrence.recurringIssueCount;recurrence.notRepeatedAfterReworkCount+=b.recurrence.notRepeatedAfterReworkCount; }
        human.batchFeedbackCorrect+=b.feedback.filter(f=>f.scope==='batch' && f.label==='correct').length;human.batchFeedbackIncorrect+=b.feedback.filter(f=>f.scope==='batch' && f.label==='incorrect').length;
        human.manualApproveAfterNeedsChanges+=b.humanActions.filter(a=>a.action==='manual_approve' && a.previous_verdict==='needs_changes').length;human.manualReworkAfterApproved+=b.humanActions.filter(a=>a.action==='manual_rework' && a.previous_verdict==='approved').length;
      }
    }
    const single = { singleReviewRounds: 0,singleApproved: 0,singleNeedsChanges: 0,singleReworks: 0,knownCostUsd: 0,knownTokens: 0,costCoverage: null,tokenCoverage: null,durationTotal: 0,durationCount: 0 };
    const singleRows=filters.reviewPolicyId || filters.strategy || batchId ? [] : db.prepare(`SELECT r.id,r.todo_id,r.round_index,r.phase,r.status,r.result_payload,r.execution_snapshot,r.started_at,r.finished_at,r.created_at,r.retry_of_round_id,
      EXISTS(SELECT 1 FROM todo_execution_rounds n WHERE n.todo_id=r.todo_id AND n.round_index>r.round_index AND n.phase='rework' AND NOT EXISTS(SELECT 1 FROM todo_execution_rounds v WHERE v.todo_id=r.todo_id AND v.phase='review' AND v.round_index>r.round_index AND v.round_index<n.round_index)) reworked
      FROM todo_execution_rounds r JOIN todos t ON t.id=r.todo_id WHERE t.project_id=? AND t.review_mode='single' AND r.phase='review' AND (? IS NULL OR julianday(r.created_at)>=julianday(?)) AND julianday(r.created_at)<=julianday(?)`).iterate(projectId,start,start,end);
    if (!filters.reviewPolicyId && !filters.strategy && !batchId) for (const raw of singleRows) { const r=raw as Round & { reworked: number };if (!matchesIdentity(normalizeExecutionIdentity(r.execution_snapshot),filters)) continue;single.singleReviewRounds++;const result=r.status==='completed' ? evaluationResult(r.result_payload) : null;single.singleApproved+=Number(result?.verdict==='approved');single.singleNeedsChanges+=Number(result?.verdict==='needs_changes');single.singleReworks+=r.reworked;const ms=duration(r.started_at,r.finished_at);if (ms!==null) { single.durationCount++;single.durationTotal+=ms; } }
    const final=finish(summary);
    return { period: { period: filters.period,periodStart: start,periodEnd: end,timezone: 'UTC',batchTimeField: 'created_at',attemptTimeField: 'created_at',feedbackTimeField: 'created_at' },
      summary: { ...final,p50BatchDurationMs: quantile(.5),p95BatchDurationMs: quantile(.95) },coverage: { costAttemptsKnown: summary.costAttemptsKnown,costAttemptsTotal: summary.costAttemptsTotal,tokenAttemptsKnown: summary.tokenAttemptsKnown,tokenAttemptsTotal: summary.tokenAttemptsTotal,feedbackIssuesLabeled: summary.feedbackIssuesLabeled,feedbackIssuesTotal: summary.feedbackIssuesTotal,feedbackBatchesLabeled: summary.feedbackBatchesLabeled,feedbackBatchesTotal: summary.feedbackBatchesTotal },
      strategies: [...groups.strategies].map(([strategy,a])=>({ strategy,...finish(a) })),policies: [...groups.policies].map(([key,a])=>({ policyId: JSON.parse(key)[0] as string,policyVariantId: JSON.parse(key)[1] as string,policySnapshot: policySnapshots.get(key)!,...finish(a) })),failurePolicies: [...groups.failurePolicies].map(([failurePolicy,a])=>({ failurePolicy,...finish(a) })),
      reviewers: [...members].map(([policyMemberId,a])=>({ policyMemberId,label: a.label,...finishReviewer(a.metrics) })).sort((a,b)=>b.jobs-a.jobs),
      executionIdentities: [...identities.values()].map(a=>({ grouping: a.grouping,identity: a.identity,...finishReviewer(a.metrics) })).sort((a,b)=>b.jobs-a.jobs),
      issues: [...issues.values()].sort((a,b)=>b.batchCount-a.batchCount || b.reviewerCount-a.reviewerCount || a.fingerprint.localeCompare(b.fingerprint)),daily: [...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-200),
      diversity: [...groups.diversity].map(([cohort,a])=>({ cohort,...finish(a) })),judge: { ...judge,sampleCount: judge.judgeInvocations,avgJudgeDurationMs: rate(judge.durationTotal,judge.durationCount),judgeCostCoverage: rate(judge.costKnown,judge.attempts) },
      failover: { ...failover,avgFailoversPerAffectedJob: rate(failover.reviewerFailoverCount,failover.reviewerJobsWithFailover) },recurrence,humanFeedback: { ...human,confirmedIssueCount: summary.confirmedIssueCount,rejectedIssueCount: summary.rejectedIssueCount,uncertainIssueCount: summary.uncertainIssueCount,batchFeedbackCoverage: final.batchFeedbackCoverage,reviewerFeedbackCoverage: final.reviewerFeedbackCoverage,issueFeedbackCoverage: final.issueFeedbackCoverage,confirmedFindingRate: final.confirmedFindingRate,rejectedFindingRate: final.rejectedFindingRate },
      failures: { batches: batchFailures,reviewers: reviewerFailures },singleBaseline: { ...single,sampleCount: single.singleReviewRounds,singleReworkRate: rate(single.singleReworks,single.singleReviewRounds),avgDurationMs: rate(single.durationTotal,single.durationCount) },
      batches,pagination: { offset: filters.offset,limit: filters.limit,total: seen,hasMore: filters.offset+batches.length<seen },bounds: { groupRowsOmitted,issueRowsOmitted,dailyRowsOmitted },
      issuePagination: { offset: issueOffset,limit: filters.limit,total: topIssueRows[0]?.total ?? 0,hasMore: topIssueRows.length>filters.limit },
      evidence: 'Experimental observational metrics. Agreement is not correctness. Human feedback coverage determines quality evidence. Tasks and policies are not randomized.',telemetrySource: 'Provider reported USD and tokens; missing values remain unknown. Single round usage is not persisted.' };
  })();
}

export function consensusCsv(data: ReturnType<typeof getConsensusAnalytics>): string {
  const fields=['batch_id','todo_id','created_at','policy_id','policy_variant_id','strategy','failure_policy','reviewer_count','successful_reviewers','failed_reviewers','agreement','judge_invoked','final_verdict','rework_triggered','distinct_providers','distinct_accounts','distinct_models','known_cost_usd','cost_coverage','known_tokens','token_coverage','duration_ms','human_feedback'];

  return [fields.join(','),...data.batches.map(b=>[b.id,b.todoId,b.createdAt,b.policyId,b.policyVariantId,b.strategy,b.failurePolicy,b.reviewerCount,b.successfulReviewers,b.failedReviewers,b.agreement,b.judgeInvoked,b.finalVerdict,b.reworkTriggered,b.diversity.distinctProviders,b.diversity.distinctAccounts,b.diversity.distinctModels,b.telemetry.knownCostUsd,b.telemetry.costCoverage,b.telemetry.knownTokens,b.telemetry.tokenCoverage,b.batchDurationMs,b.feedback.find(f=>f.scope==='batch')?.label].map(evaluationCsvCell).join(','))].join('\r\n');
}
