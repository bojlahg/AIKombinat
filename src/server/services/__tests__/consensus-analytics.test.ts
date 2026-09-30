import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';
import { migrateReviewEvaluation } from '../../db/review-evaluation.js';
import { aggregateConsensus, type ConsensusStrategy } from '../consensus-result.js';
import { reviewIssueFingerprint } from '../review-issue-identity.js';
import { normalizeConsensusFailure, normalizeReviewerFailure, normalizeExecutionIdentity } from '../review-evaluation-normalize.js';
import type { ReviewResult } from '../review-result.js';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

let db: Database.Database;
vi.mock('../../db/connection.js',()=>({ getDatabase: ()=>db }));
const q=await import('../../db/queries.js');
const { getConsensusAnalytics,parseEvaluationFilters,consensusCsv }=await import('../consensus-analytics.js');
const { putEvaluationFeedback,listEvaluationFeedback,recordReviewHumanAction }=await import('../review-evaluation.js');
const router=(await import('../../routes/consensus-analytics.js')).default;
const approved: ReviewResult={ verdict: 'approved',summary: 'secret prompt excluded',issues: [] };
const change=(...descriptions: string[]): ReviewResult=>({ verdict: 'needs_changes',summary: 'fix',issues: descriptions.map(description=>({ description,severity: 'minor',files: ['a.ts'] })) });
const now=()=>new Date().toISOString();
let projectId: string,profileId: string,policyId: string,sequence: number;
const filters=()=>parseEvaluationFilters({ period: 'all' });
beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');initDatabase(db);sequence=0;
  projectId=q.createProject('Evaluation','/tmp/evaluation').id;
  profileId=q.createExecutionProfile({ name: 'Historical reviewer',slug: 'reviewer',description: '',executors: [] }).id;
  policyId='policy';const timestamp=now();db.prepare(`INSERT INTO review_policies (id,name,strategy,failure_policy,min_successful_reviewers,diversity_policy,max_parallel_reviewers,created_at,updated_at) VALUES (?,'Historical policy','majority','quorum',2,'none',7,?,?)`).run(policyId,timestamp,timestamp);
});
afterEach(()=>db.close());
function fixture(results: (ReviewResult | null)[],options: { strategy?: ConsensusStrategy; weights?: number[]; judge?: ReviewResult | null; status?: string; todoId?: string; old?: boolean; usage?: boolean; failedProvider?: string }={}) {
  const n=sequence++,timestamp=options.old ? '2020-01-01T00:00:00.000Z' : now();
  const todoId=options.todoId??q.createTodo(projectId,`Task ${n}`,'secret task context').id;
  q.updateTodo(todoId,{ review_enabled: 1,review_mode: 'consensus' });
  const round=q.createExecutionRound(todoId,'review',q.getNextExecutionRoundIndex(todoId),`round-${n}`,{ status: 'completed' });
  const strategy=options.strategy??'majority';
  const votes=results.map((result,i)=>({ id: `job-${n}-${i}`,priority: i,created_at: timestamp,weight: options.weights?.[i]??1,result }));
  const aggregate=aggregateConsensus({ strategy,failure_policy: 'quorum',min_successful_reviewers: 2,reviewers: votes });
  const final=options.status==='failed' ? null : options.judge ?? aggregate;
  const batchId=`batch-${String(n).padStart(6,'0')}`;
  db.prepare(`INSERT INTO consensus_review_batches (id,todo_id,review_round_id,review_policy_id,strategy,failure_policy,min_successful_reviewers,diversity_policy,max_parallel_reviewers,status,artifact_identity_json,evidence_hash,aggregate_result_json,created_at,started_at,finished_at,updated_at) VALUES (?,?,?,?,?,'quorum',2,'prefer_provider',7,?,'{}','hash',?,?,?, ?,?)`).run(batchId,todoId,round.id,policyId,strategy,options.status??'completed',final ? JSON.stringify(final) : null,timestamp,timestamp,new Date(Date.parse(timestamp)+1000).toISOString(),timestamp);
  const ids: string[]=[];
  for (const [i,result] of results.entries()) {
    const id=`job-${n}-${i}`;ids.push(id);
    insertJob(id,result,'reviewer',i);
    db.prepare(`INSERT INTO consensus_review_attempts (id,review_job_id,attempt_index,status,run_token,execution_snapshot,input_payload,result_payload,duration_ms,input_tokens,output_tokens,cost_usd,created_at,updated_at) VALUES (?,?,1,?,?,?,'secret prompt',?,100,?,?,?, ?,?)`).run(`attempt-${n}-${i}`,id,result ? 'completed' : 'failed',`token-${n}-${i}`,JSON.stringify({ agent: result ? 'claude' : options.failedProvider??'claude',providerAccountId: 'historical-account',providerAccountLabel: 'Historical Account',profileId,profileName: 'Historical reviewer',effectiveModel: 'model',effort: 'low',env: { SECRET: 'never export' } }),result ? JSON.stringify(result) : null,options.usage ? 10 : null,options.usage ? 5 : null,options.usage ? .02 : null,timestamp,timestamp);
  }
  if ('judge' in options) { insertJob(`judge-${n}`,options.judge??null,'judge',10); }
  q.updateExecutionRound(round.id,{ result_payload: final ? JSON.stringify(final) : null });
  function insertJob(id: string,result: ReviewResult | null,role: string,i: number) {
    const memberId=role==='reviewer' ? `member-${i}` : null;
    if (memberId) db.prepare(`INSERT OR IGNORE INTO review_policy_members (id,review_policy_id,execution_profile_id,label,weight,priority,created_at,updated_at) VALUES (?,?,?, ?,1,?,?,?)`).run(memberId,policyId,profileId,`Reviewer ${i}`,i,timestamp,timestamp);
    db.prepare(`INSERT INTO consensus_review_jobs (id,batch_id,role,policy_member_id,execution_profile_id,label,weight,priority,status,final_result_payload,created_at,started_at,finished_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,batchId,role,memberId,profileId,role==='judge' ? 'Judge' : `Reviewer ${i}`,options.weights?.[i]??1,i,result ? 'completed' : 'failed',result ? JSON.stringify(result) : null,timestamp,timestamp,timestamp,timestamp);
  }
  return { batchId,todoId,roundId: round.id,ids };
}
describe('Consensus evaluation',()=>{
  it('counts one job/vote with two attempts and durable account failover',()=>{
    const f=fixture([approved,approved],{ usage: true });
    db.prepare("UPDATE consensus_review_attempts SET status='failed',error_message='account_quota_failover',cost_usd=NULL,input_tokens=NULL,output_tokens=NULL WHERE review_job_id=?").run(f.ids[0]);
    db.prepare(`INSERT INTO consensus_review_attempts (id,review_job_id,attempt_index,status,run_token,execution_snapshot,duration_ms,input_tokens,output_tokens,cost_usd,created_at,updated_at) VALUES ('retry',?,2,'completed','retry-token',?,100,10,5,.02,?,?)`).run(f.ids[0],JSON.stringify({ agent: 'claude',providerAccountId: 'account-B',effectiveModel: 'model',effort: 'low',profileId }),now(),now());
    const account=db.prepare("SELECT id FROM provider_accounts WHERE provider='claude'").get() as { id: string };
    db.prepare(`INSERT INTO account_failover_events (id,owner_type,owner_id,chain_id,from_account_id,provider,reason,classification,attempt_index_from,created_at) VALUES ('event','consensus_reviewer',?,'chain',?,'claude','quota','quota',1,?)`).run(f.ids[0],account.id,now());
    const data=getConsensusAnalytics(projectId,filters());
    expect(data.reviewers[0]).toMatchObject({ jobs: 1,approvalVotes: 1,attempts: 2 });
    expect(data.failover).toMatchObject({ reviewerJobsWithFailover: 1,reviewerFailoverCount: 1,failoverSuccessCount: 1 });
    expect(data.summary).toMatchObject({ approvedBatches: 1,knownCostUsd: .04,costAttemptsKnown: 2,costAttemptsTotal: 3,knownTokens: 30 });
    expect(data.summary.costCoverage).toBeCloseTo(2/3);
    expect(data.executionIdentities.find(i=>i.grouping==='provider_account' && i.identity.providerAccountId==='account-B')).toMatchObject({ jobs: 1,approvalVotes: 1,attempts: 1,knownCostUsd: .02 });
    expect(data.executionIdentities.find(i=>i.grouping==='provider_account' && i.identity.providerAccountId==='historical-account')).toMatchObject({ jobs: 1,approvalVotes: 1,attempts: 2,knownCostUsd: .02 });
  });
  it('excludes failed reviewers, preserves N/A agreement and prevents false failed approval',()=>{
    fixture([approved,null],{ status: 'failed',failedProvider: 'codex' });
    const b=getConsensusAnalytics(projectId,filters()).batches[0];
    expect(b).toMatchObject({ successfulReviewers: 1,failedReviewers: 1,agreement: null,disagreement: null,finalVerdict: null });
    expect(b.diversity.providerDiverse).toBe(true);
    expect(b.jobs[1].verdict).toBeNull();
  });
  it('counts shared/unique findings once per reviewer and promotes severity consistently',()=>{
    const x=change(' X '),y=change('x','Y'),z=change('Z');y.issues[0].severity='blocking';
    fixture([x,y,z]);const data=getConsensusAnalytics(projectId,filters());
    expect(data.batches[0]).toMatchObject({ sharedIssueCount: 1,uniqueIssueCount: 2 });
    expect(data.batches[0].jobs.map(j=>j.uniqueIssueCount)).toEqual([0,1,1]);
    const shared=data.issues.find(i=>i.sharedCount===1)!;expect(shared.severity).toBe('blocking');
    expect(shared.fingerprint).toBe(reviewIssueFingerprint(x.issues[0]));
    expect(data.batches[0].jobs.every(j=>j.reworkContribution)).toBe(true);
  });
  for (const [strategy,results,weights,expected] of [
    ['majority',[approved,approved,change('X')],[1,1,1],[true,true,false]],
    ['weighted',[approved,change('X'),change('Y')],[5,1,1],[true,false,false]],
    ['unanimous',[approved,approved,change('X')],[1,1,1],[false,false,true]],
  ] as const) it(`derives ${strategy} decisive counterfactual`,()=>{
    fixture([...results],{ strategy,weights: [...weights] });
    expect(getConsensusAnalytics(projectId,filters()).batches[0].jobs.map(j=>j.decisiveVote)).toEqual(expected);
  });
  it('minority and judge override distinguish ties',()=>{
    fixture([approved,approved,change('X')],{ strategy: 'judge_on_disagreement',judge: change('Judge') });
    fixture([approved,change('Tie')],{ strategy: 'judge',judge: approved });
    const data=getConsensusAnalytics(projectId,filters());
    expect(data.judge).toMatchObject({ judgeInvocations: 2,judgeCompleted: 2,judgeOverrodeMajority: 1 });
    expect(data.batches[0].jobs[2]).toMatchObject({ minorityVote: true,judgeTriggerContribution: true });
    expect(data.batches[1]).toMatchObject({ tieBatch: true,judge: { overrodeMajority: null } });
    expect(data.batches[1].jobs.every(j=>!j.minorityVote)).toBe(true);
  });
  it('records judge failure without inventing verdict or usage',()=>{
    fixture([approved,approved],{ strategy: 'judge',judge: null,status: 'failed' });
    expect(getConsensusAnalytics(projectId,filters()).judge).toMatchObject({ judgeFailed: 1,judgeOverrodeMajority: 0,judgeCostCoverage: null });
  });
  it('keeps reviewer and judge costs separate, and orders the third reviewer by policy priority',()=>{
    const f=fixture([approved,approved,change('Z')],{ strategy: 'weighted',weights: [1,1,5],usage: true,judge: change('Judge Z') });
    const judge=db.prepare("SELECT id FROM consensus_review_jobs WHERE batch_id=? AND role='judge'").get(f.batchId) as { id: string };
    db.prepare(`INSERT INTO consensus_review_attempts (id,review_job_id,attempt_index,status,run_token,execution_snapshot,duration_ms,input_tokens,output_tokens,cost_usd,created_at,updated_at) VALUES ('judge-usage',?,1,'completed','judge-token','{}',250,3,4,.2,?,?)`).run(judge.id,now(),now());
    const b=getConsensusAnalytics(projectId,filters()).batches[0];expect(b.knownReviewerCostUsd).toBeCloseTo(.06);expect(b.knownJudgeCostUsd).toBe(.2);expect(b.telemetry.knownCostUsd).toBeCloseTo(.26);expect(b.thirdReviewer).toMatchObject({ jobId: f.ids[2],changedDeterministicVerdict: true,introducedUniqueFinding: true });
  });
  it('counts quorum salvage while require-all failures retain their reviewer-failure category',()=>{
    fixture([approved,approved,null],{ weights: [1,1,10] });
    const failed=fixture([approved,approved,null],{ status: 'failed' });
    db.prepare("UPDATE consensus_review_batches SET failure_policy='require_all',failure_reason='reviewer_quorum_failed' WHERE id=?").run(failed.batchId);
    const data=getConsensusAnalytics(projectId,filters());expect(data.summary.approvedBatches).toBe(1);expect(data.failurePolicies.find(p=>p.failurePolicy==='quorum')).toMatchObject({ quorumSalvageCount: 1,quorumSalvageRate: 1 });expect(data.batches[1].failureCategory).toBe('reviewer_failure');
  });
  it('links rework and exact recurrence including disappearance',()=>{
    const f=fixture([change('X','Y'),change('X')]);
    q.createExecutionRound(f.todoId,'rework',2,'rework',{ status: 'completed' });
    fixture([change(' x '),change('X')],{ todoId: f.todoId });
    const data=getConsensusAnalytics(projectId,filters());
    expect(data.batches[0].reworkTriggered).toBe(true);
    expect(data.recurrence).toMatchObject({ chains: 1,previousIssueCount: 2,recurringIssueCount: 1,notRepeatedAfterReworkCount: 1 });
  });
  it('derives single rounds without creating fake consensus rows',()=>{
    const todo=q.createTodo(projectId,'Single','');q.updateTodo(todo.id,{ review_mode: 'single' });
    const r=q.createExecutionRound(todo.id,'review',1,'single',{ status: 'completed' });q.updateExecutionRound(r.id,{ result_payload: JSON.stringify(approved) });
    fixture([approved,approved]);
    const data=getConsensusAnalytics(projectId,filters());expect(data.singleBaseline).toMatchObject({ singleReviewRounds: 1,singleApproved: 1,costCoverage: null });expect(data.summary.totalBatches).toBe(1);
  });
  it('preserves snapshot identities and policy variants after live edits',()=>{
    fixture([approved,approved]);const before=getConsensusAnalytics(projectId,filters());
    db.prepare("UPDATE execution_profiles SET name='Renamed' WHERE id=?").run(profileId);db.prepare("UPDATE review_policies SET strategy='weighted' WHERE id=?").run(policyId);
    const after=getConsensusAnalytics(projectId,filters());expect(after.batches[0].policyVariantId).toBe(before.batches[0].policyVariantId);expect(after.batches[0].jobs[0].identity.profileName).toBe('Historical reviewer');expect(after.batches[0].strategy).toBe('majority');
  });
  it('uses batch, attempt and feedback creation windows independently',()=>{
    const f=fixture([approved,approved]);fixture([approved,approved],{ old: true });
    db.prepare("UPDATE consensus_review_attempts SET created_at='2020-01-01' WHERE review_job_id=?").run(f.ids[0]);
    const data=getConsensusAnalytics(projectId,parseEvaluationFilters({ period: '7d' }));expect(data.summary.totalBatches).toBe(1);expect(data.summary.costAttemptsTotal).toBe(1);expect(data.period.timezone).toBe('UTC');
  });
  it('validates filters and selects historical provider/model/profile cohorts',()=>{
    fixture([approved,approved]);expect(getConsensusAnalytics(projectId,parseEvaluationFilters({ provider: 'codex' })).summary.totalBatches).toBe(0);
    expect(getConsensusAnalytics(projectId,parseEvaluationFilters({ provider: 'claude',model: 'model',executionProfileId: profileId })).summary.totalBatches).toBe(1);
    for (const query of [{ period: 'today' },{ limit: '201' },{ strategy: 'magic' },{ provider: ['claude'] },{ rawSql: 'select' }]) expect(()=>parseEvaluationFilters(query)).toThrow();
  });
  it('does not expose execution secrets, input or raw result summaries in JSON/CSV',()=>{
    fixture([approved,approved]);const data=getConsensusAnalytics(projectId,filters());const output=JSON.stringify(data)+consensusCsv(data);
    for (const secret of ['secret prompt','secret task context','never export','input_payload','artifact_identity_json','raw stdout']) expect(output).not.toContain(secret);
  });
  it('keeps zero-denominator rates and unknown telemetry nullable',()=>{
    expect(getConsensusAnalytics(projectId,filters()).summary.agreementRate).toBeNull();fixture([approved,approved]);
    const data=getConsensusAnalytics(projectId,filters());expect(data.summary).toMatchObject({ knownCostUsd: 0,costCoverage: 0,tokenCoverage: 0 });expect(data.humanFeedback.confirmedFindingRate).toBeNull();
  });
  it('streams 10k batches through bounded pages and preserves exact summary counts',()=>{
    db.transaction(()=>{ for (let i=0;i<10000;i++) fixture([approved,approved]); })();
    const data=getConsensusAnalytics(projectId,parseEvaluationFilters({ limit: '50',offset: '9950' }));expect(data.summary.totalBatches).toBe(10000);expect(data.batches).toHaveLength(50);expect(data.pagination.hasMore).toBe(false);expect(data.reviewers.length).toBeLessThanOrEqual(100);expect(data.issues.length).toBeLessThanOrEqual(200);
  },120000);
  it('bounds issue rows by frequency, preserves policy variants, and exposes overflow',()=>{
    fixture([change(...Array.from({ length: 205 },(_,i)=>`Finding ${i}`)),change('Finding 204')]);
    const data=getConsensusAnalytics(projectId,filters());expect(data.issues).toHaveLength(200);expect(data.bounds.issueRowsOmitted).toBe(true);
    expect(data.issues[0].fingerprint).toBe(reviewIssueFingerprint(change('Finding 204').issues[0]));
    const next=getConsensusAnalytics(projectId,parseEvaluationFilters({ offset: '200' }),undefined,200);expect(next.issues).toHaveLength(5);expect(next.issuePagination).toMatchObject({ total: 205,hasMore: false });
    expect(next.issues.every(i=>!data.issues.some(first=>first.fingerprint===i.fingerprint))).toBe(true);
  });
  it('serves bounded namespace, details, CSV, and ownership-validated feedback CRUD through HTTP',async()=>{
    const f=fixture([change('X'),approved]);
    const app=express();app.use(express.json());app.use('/api',router);
    const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      for (const section of ['','/reviewers','/policies','/issues']) { const response=await fetch(`${base}/projects/${projectId}/analytics/consensus${section}?limit=1`);expect(response.status).toBe(200);const payload=await response.json();expect(payload.period.timezone).toBe('UTC');expect(payload.coverage).toBeDefined(); }
      expect((await fetch(`${base}/projects/other/analytics/consensus/batches/${f.batchId}`)).status).toBe(404);
      expect((await fetch(`${base}/projects/${projectId}/analytics/consensus?period=invalid`)).status).toBe(400);
      const detail=await fetch(`${base}/projects/${projectId}/analytics/consensus/batches/${f.batchId}`);expect((await detail.json()).batch.id).toBe(f.batchId);
      const csv=await fetch(`${base}/projects/${projectId}/analytics/consensus/export.csv`);expect(csv.headers.get('content-type')).toContain('text/csv');expect(await csv.text()).not.toContain('secret prompt');
      const put=await fetch(`${base}/consensus-review-jobs/${f.ids[0]}/issues/${reviewIssueFingerprint(change('X').issues[0])}/feedback`,{ method: 'PUT',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ projectId,batchId: f.batchId,label: 'confirmed' }) });expect(put.status).toBe(200);const feedback=await put.json();
      const list=await fetch(`${base}/consensus-review-batches/${f.batchId}/feedback?projectId=${projectId}`);expect(await list.json()).toHaveLength(1);
      expect((await fetch(`${base}/consensus-review-batches/${f.batchId}/feedback?projectId=other`)).status).toBe(404);
      expect((await fetch(`${base}/consensus-review-batches/${f.batchId}/feedback/${feedback.id}?projectId=other`,{ method: 'DELETE' })).status).toBe(404);
      expect((await fetch(`${base}/consensus-review-batches/${f.batchId}/feedback/${feedback.id}?projectId=${projectId}`,{ method: 'DELETE' })).status).toBe(204);
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())); }
  });
});
describe('Explicit feedback and actions',()=>{
  it('upserts one current label per target, computes coverage and excludes uncertain from confirmed/rejected rates',()=>{
    const f=fixture([change('X','Y'),change('Z')]);
    const base={ projectId,batchId: f.batchId };
    putEvaluationFeedback({ ...base,scope: 'batch',label: 'correct' });putEvaluationFeedback({ ...base,scope: 'reviewer_job',jobId: f.ids[0],label: 'useful' });
    for (const [jobId,description,label] of [[f.ids[0],'X','confirmed'],[f.ids[0],'Y','rejected'],[f.ids[1],'Z','uncertain']]) putEvaluationFeedback({ ...base,scope: 'issue',jobId,fingerprint: reviewIssueFingerprint(change(description).issues[0]),label });
    putEvaluationFeedback({ ...base,scope: 'batch',label: 'unknown' });expect(listEvaluationFeedback(f.batchId,projectId)).toHaveLength(5);
    const h=getConsensusAnalytics(projectId,filters()).humanFeedback;expect(h).toMatchObject({ batchFeedbackCoverage: 1,reviewerFeedbackCoverage: .5,issueFeedbackCoverage: 1,confirmedFindingRate: .5,rejectedFindingRate: .5,uncertainIssueCount: 1,batchFeedbackCorrect: 0 });
    recordReviewHumanAction(f.todoId,f.roundId,'manual_approve');expect(getConsensusAnalytics(projectId,filters()).humanFeedback.manualApproveAfterNeedsChanges).toBe(1);expect(listEvaluationFeedback(f.batchId,projectId)).toHaveLength(5);
  });
  it('rejects cross-project, invalid scope/label, missing issue, HTML, credentials and oversized UTF-8 notes',()=>{
    const f=fixture([change('X'),approved]);const base={ projectId,batchId: f.batchId,scope: 'batch',label: 'correct' };
    for (const patch of [{ projectId: 'other' },{ scope: 'other' },{ label: 'useful' },{ note: 'я'.repeat(2049) },{ note: '<b>unsafe</b>' },{ note: 'Bearer abcdefghijklmnopqrstuvwxyz1234567890' }]) expect(()=>putEvaluationFeedback({ ...base,...patch })).toThrow();
    expect(()=>putEvaluationFeedback({ ...base,scope: 'issue',jobId: f.ids[0],fingerprint: 'missing',label: 'confirmed' })).toThrow();
    expect(()=>putEvaluationFeedback({ ...base,scope: 'reviewer_job',jobId: f.ids[1],batchId: 'wrong',label: 'useful' })).toThrow();
  });
  it('migration is idempotent and cascade deletion leaves no orphan feedback/actions',()=>{
    const f=fixture([approved,approved]);putEvaluationFeedback({ projectId,batchId: f.batchId,scope: 'batch',label: 'correct' });recordReviewHumanAction(f.todoId,f.roundId,'retry_review_phase');migrateReviewEvaluation(db);migrateReviewEvaluation(db);expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare('DELETE FROM todos WHERE id=?').run(f.todoId);expect(db.prepare('SELECT * FROM review_evaluation_feedback').all()).toEqual([]);expect(db.prepare('SELECT * FROM review_human_actions').all()).toEqual([]);
  });
});
describe('Failure and identity normalization',()=>{
  for (const [reason,category] of [['review_artifact_changed','artifact_changed'],['reviewer_quorum_failed','quorum_failure'],['judge_failed','judge_failure'],['policy_missing','configuration'],['novel failure','unknown']]) it(`batch ${reason}`,()=>expect(normalizeConsensusFailure(reason,'failed')).toBe(category));
  for (const [reason,category] of [['quota exceeded','quota'],['authentication','auth'],['process exit 1','process'],['invalid output','invalid_output'],['output_limit','output_limit'],['resource unavailable','resource'],['controller_restart','recovery'],['profile missing','configuration'],['other','unknown']]) it(`reviewer ${reason}`,()=>expect(normalizeReviewerFailure(reason,'failed')).toBe(category));
  it('legacy identity and Stop remain readable',()=>{ expect(normalizeExecutionIdentity('broken').provider).toBeNull();expect(normalizeReviewerFailure(null,'stopped')).toBe('stop');expect(normalizeConsensusFailure(null,'recovery_required')).toBe('recovery'); });
});
