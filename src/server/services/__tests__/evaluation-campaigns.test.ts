import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../../db/schema.js';
import { migrateEvaluationCampaigns } from '../../db/evaluation-campaigns.js';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

let db: Database.Database;
vi.mock('../../db/connection.js',()=>({ getDatabase: ()=>db }));
const q=await import('../../db/queries.js');
const service=await import('../evaluation-campaign-service.js');
const helpers=await import('../evaluation-campaign-definition.js');
const analytics=await import('../evaluation-campaign-analytics.js');
const { saveReviewPolicy }=await import('../review-policy.js');
const router=(await import('../../routes/evaluation-campaigns.js')).default;
const todosRouter=(await import('../../routes/todos.js')).default;
let projectId: string,otherProjectId: string,profileId: string,policyId: string;
const now=()=>new Date().toISOString();
const approved=JSON.stringify({ verdict: 'approved',summary: 'PRIVATE RESULT',issues: [] });
beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');initDatabase(db);
  projectId=q.createProject('Campaign','/tmp/campaign').id;otherProjectId=q.createProject('Other','/tmp/other').id;
  const model=q.addModel('claude','campaign-reviewer','Campaign reviewer',['low','high']);
  profileId=q.createExecutionProfile({ name: 'Reviewer',slug: 'reviewer',description: '',executors: [{ cli_model_id: model.id,effort_value: 'low',priority: 0 }] }).id;
  policyId=saveReviewPolicy({ name: 'Consensus',members: [0,1].map(priority=>({ execution_profile_id: profileId,label: `Reviewer ${priority}`,priority })) }).id;
});
afterEach(()=>{ vi.restoreAllMocks();db?.close(); });
function arms() { return [
  { name: 'Single',is_control: 1,weight: 1,sort_order: 0,review_mode: 'single',review_profile_id: profileId },
  { name: 'Consensus',is_control: 0,weight: 1,sort_order: 1,review_mode: 'consensus',review_policy_id: policyId },
]; }
function campaign(options: Record<string,unknown>={}) { return service.saveEvaluationCampaign(projectId,{ name: 'Experiment',arms: arms(),...options }); }
function running(options: Record<string,unknown>={}) { const c=campaign(options);return service.transitionEvaluationCampaign(c.id,projectId,'start'); }
function enroll(c: helpers.EvaluationCampaign,options: Record<string,unknown>={}) {
  return service.createTodoWithEvaluationAssignment([projectId,'Task','PRIVATE PROMPT',7,'claude','implementation-model',undefined,undefined,5,0,'none',null,null,undefined,null,'high',null,'[]',0,null,null,4],
    { provider_account_id: null,account_policy: 'automatic',...options },{ evaluation_campaign_id: c.id,evaluation_campaign_enroll: true });
}
function reviewed(todo: q.Todo,status='completed') {
  service.observeImplementationStart(todo.id);service.observeReviewStart(todo.id);
  q.createExecutionRound(todo.id,'review',1,randomUUID(),{ status: 'completed',resultPayload: approved,startedAt: now(),executionSnapshot: JSON.stringify({ agent: 'claude',providerAccountId: 'runtime-account',effectiveModel: 'runtime-model',effort: 'high' }) });
  q.updateTodoStatus(todo.id,status);
}
describe('campaign validation and lifecycle',()=>{
  for (const [name,patch] of [
    ['too few',{ arms: [] }],['too many',{ arms: Array.from({ length: 7 },(_,i)=>({ name: `arm-${i}`,is_control: i===0?1:0,weight: 1,review_mode: 'single',review_profile_id: 'PROFILE' })) }],
    ['no control',{ arms: 'no-control' }],['two controls',{ arms: 'two-controls' }],['zero weight',{ arms: 'zero-weight' }],['invalid profile',{ arms: 'invalid-profile' }],
    ['invalid policy',{ arms: 'invalid-policy' }],['single policy mismatch',{ arms: 'single-policy' }],['consensus profile mismatch',{ arms: 'consensus-profile' }],
  ] as const) it(`rejects ${name}`,()=>{
    const a=arms();
    if (patch.arms==='no-control') a[0].is_control=0;
    if (patch.arms==='two-controls') a[1].is_control=1;
    if (patch.arms==='zero-weight') a[0].weight=0;
    if (patch.arms==='invalid-profile') a[0].review_profile_id='missing';
    if (patch.arms==='invalid-policy') a[1].review_policy_id='missing';
    if (patch.arms==='single-policy') a[0].review_policy_id=policyId;
    if (patch.arms==='consensus-profile') a[1].review_profile_id=profileId;
    const input=typeof patch.arms==='string' ? a : patch.arms.map(arm=>({ ...arm,...('review_profile_id' in arm ? { review_profile_id: profileId } : {}) }));
    expect(()=>campaign({ arms: input })).toThrow();
    expect(db.prepare('SELECT id FROM evaluation_campaigns').all()).toHaveLength(0);
  });
  it('edits drafts, locks definitions, preserves salt across resume and clones fresh drafts',()=>{
    let c=campaign();expect(c.auto_enroll).toBe(0);expect(c.assignment_salt.length).toBeGreaterThanOrEqual(32);
    c=service.saveEvaluationCampaign(projectId,{ name: 'Updated',arms: arms().map(a=>({ ...a,weight: 3 })) },c.id);
    c=service.transitionEvaluationCampaign(c.id,projectId,'start');
    expect(c.campaign_definition_hash).toMatch(/^[a-f0-9]{64}$/);expect(c.arms.every(a=>a.definition_hash)).toBe(true);
    expect(()=>service.saveEvaluationCampaign(projectId,{ arms: arms() },c.id)).toThrow('campaign_definition_locked');
    expect(()=>service.saveEvaluationCampaign(projectId,{ auto_enroll: 1 },c.id)).toThrow('campaign_definition_locked');
    expect(service.saveEvaluationCampaign(projectId,{ name: 'Metadata only' },c.id).name).toBe('Metadata only');
    expect(()=>db.prepare('UPDATE evaluation_campaign_arms SET weight=2 WHERE campaign_id=?').run(c.id)).toThrow();
    expect(()=>service.deleteEvaluationCampaign(c.id,projectId)).toThrow();
    service.transitionEvaluationCampaign(c.id,projectId,'pause');const resumed=service.transitionEvaluationCampaign(c.id,projectId,'resume');
    expect(resumed.assignment_salt).toBe(c.assignment_salt);expect(resumed.campaign_definition_hash).toBe(c.campaign_definition_hash);
    service.transitionEvaluationCampaign(c.id,projectId,'complete');service.transitionEvaluationCampaign(c.id,projectId,'archive');
    expect(()=>service.transitionEvaluationCampaign(c.id,projectId,'resume')).toThrow();
    const clone=service.cloneEvaluationCampaign(c.id,projectId);expect(clone.status).toBe('draft');expect(clone.assignment_salt).not.toBe(c.assignment_salt);expect(clone.arms.map(a=>a.weight)).toEqual([3,3]);
    service.deleteEvaluationCampaign(clone.id,projectId);expect(service.listEvaluationCampaigns(projectId)).toHaveLength(0);
  });
  it('enforces one running auto campaign per project on start and resume, with a DB backstop',()=>{
    const a=running({ auto_enroll: 1 }),b=campaign({ auto_enroll: 1 });
    expect(()=>service.transitionEvaluationCampaign(b.id,projectId,'start')).toThrow();
    service.transitionEvaluationCampaign(a.id,projectId,'pause');service.transitionEvaluationCampaign(b.id,projectId,'start');
    expect(()=>service.transitionEvaluationCampaign(a.id,projectId,'resume')).toThrow();
    expect(()=>db.prepare("UPDATE evaluation_campaigns SET status='running' WHERE id=?").run(a.id)).toThrow();
  });
});
describe('deterministic assignment and atomic Todo creation',()=>{
  it('matches independent SHA-256 golden vectors and ignores input ordering and outcomes',()=>{
    const c=campaign();c.assignment_salt='0123456789abcdef0123456789abcdef';c.arms[0].weight=3;c.arms[1].weight=1;
    for (const [id,bucket,armIndex] of [['todo-1',3,1],['todo-2',0,0],['todo-3',3,1],['todo-4',1,0],['00000000-0000-0000-0000-000000000000',2,0]] as const) {
      const choice=helpers.chooseEvaluationArm(c,id);expect(choice.bucket).toBe(bucket);expect(choice.arm.id).toBe(c.arms[armIndex].id);
      expect(helpers.chooseEvaluationArm({ ...c,arms: [...c.arms].reverse() },id)).toEqual(choice);
    }
    const before=helpers.chooseEvaluationArm(c,'todo-1');q.createTodo(projectId,'Completed history');expect(helpers.chooseEvaluationArm(c,'todo-1')).toEqual(before);
  });
  for (const weight of [1,3]) it(`distributes 10k random IDs with ${weight}:1 weights`,()=>{
    const c=campaign();c.arms[0].weight=weight;
    const ids=Array.from({ length: 10000 },()=>randomUUID());const n=ids.filter(id=>helpers.chooseEvaluationArm(c,id).arm.is_control).length/ids.length;
    expect(n).toBeGreaterThan(weight===1?.45:.70);expect(n).toBeLessThan(weight===1?.55:.80);
  });
  it('changes review fields only and persists immutable snapshots before execution',()=>{
    const c=running(),todo=enroll(c),assignment=service.getEvaluationAssignment(todo.id)!;
    expect(todo).toMatchObject({ title: 'Task',description: 'PRIVATE PROMPT',priority: 7,cli_tool: 'claude',cli_model: 'implementation-model',cli_effort: 'high',execution_profile_id: null,provider_account_id: null,account_policy: 'automatic',resource_requirements: '[]',use_worktree: 0,max_turns: 5,memory_inject_mode: 'none',review_enabled: 1,max_review_rounds: 4 });
    expect(assignment).toMatchObject({ assignment_source: 'manual_todo',integrity_state: 'clean',first_execution_at: null,review_started_at: null });
    expect(assignment.assigned_review_config_hash).toBe(helpers.hashReviewExperimentConfig(todo));expect(assignment.arm_snapshot_json).not.toContain('PRIVATE PROMPT');
    expect(()=>db.prepare('UPDATE evaluation_campaign_assignments SET arm_id=? WHERE id=?').run(c.arms.find(a=>a.id!==assignment.arm_id)!.id,assignment.id)).toThrow();
  });
  it('rolls back Todo, configuration and assignment if insertion throws',()=>{
    const c=running();db.exec("CREATE TRIGGER fail_assignment BEFORE INSERT ON evaluation_campaign_assignments BEGIN SELECT RAISE(ABORT,'injected crash'); END;");
    expect(()=>enroll(c)).toThrow('injected crash');expect(q.getTodosByProjectId(projectId)).toEqual([]);expect(db.prepare('SELECT * FROM evaluation_campaign_assignments').all()).toEqual([]);
  });
  it('preserves every implementation field relative to an opted-out Todo with the same inputs',()=>{
    const c=running(),dependency=q.createTodo(projectId,'Dependency');
    const args: Parameters<typeof q.createTodo>=[projectId,'Paired task','Unchanged implementation prompt',9,'claude','ignored-with-profile',undefined,dependency.id,11,1,'selected','["wiki-id"]','["wiki.md"]',undefined,profileId,'high',null,'[{"type":"cpu","amount":2}]',0,null,profileId,5];
    const updates={ account_policy: 'automatic',images: '["fixture.png"]',position_x: 12,position_y: 34 };
    const plain=service.createTodoWithEvaluationAssignment(args,updates,{ evaluation_campaign_enroll: false });
    const enrolled=service.createTodoWithEvaluationAssignment(args,updates,{ evaluation_campaign_id: c.id,evaluation_campaign_enroll: true });
    const omitted=new Set(['id','created_at','updated_at',...Object.keys(helpers.todoReviewConfig(plain))]);
    const implementation=(todo: q.Todo)=>Object.fromEntries(Object.entries(todo).filter(([key])=>!omitted.has(key)));
    expect(implementation(enrolled)).toEqual(implementation(plain));
    expect(enrolled.execution_profile_id).toBe(profileId);expect(enrolled.depends_on).toBe(dependency.id);
  });
  it('enrolls manual only, respects opt-out and leaves old/schedule/child/internal Todos alone',()=>{
    const old=q.createTodo(projectId,'Old pending'),c=running({ auto_enroll: 1 });
    const internal=q.createTodo(projectId,'Internal'),schedule=q.createSchedule(projectId,'Scheduled','schedule fixture','* * * * *'),scheduled=q.createTodo(projectId,'Scheduled task',undefined,0,undefined,undefined,schedule.id),child=q.createTodo(projectId,'Child',undefined,0,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,'orchestrator-parent');
    const manual=service.createTodoWithEvaluationAssignment([projectId,'Manual'],{}),optedOut=service.createTodoWithEvaluationAssignment([projectId,'Opt out'],{},{ evaluation_campaign_enroll: false });
    expect(service.getEvaluationAssignment(manual.id)?.campaign_id).toBe(c.id);
    for (const todo of [old,internal,scheduled,child,optedOut]) expect(service.getEvaluationAssignment(todo.id)).toBeNull();
  });
  it('pause/complete stop enrollment, keep existing tasks, and enforce an atomic cap',()=>{
    const c=running({ max_assignments: 2 }),first=enroll(c);
    service.transitionEvaluationCampaign(c.id,projectId,'pause');expect(()=>enroll(c)).toThrow('not running');
    service.transitionEvaluationCampaign(c.id,projectId,'resume');enroll(c);
    expect(service.getEvaluationCampaign(c.id).status).toBe('completed');expect(()=>enroll(c)).toThrow();expect(q.getTodosByProjectId(projectId)).toHaveLength(2);
    service.observeImplementationStart(first.id);expect(service.getEvaluationAssignment(first.id)?.first_execution_at).not.toBeNull();
  });
});
describe('integrity and feedback',()=>{
  it('requires explicit override, contaminates atomically and never changes arms',()=>{
    const c=running(),todo=enroll(c),before=service.getEvaluationAssignment(todo.id)!;
    expect(()=>service.updateTodoWithEvaluationGuard(todo.id,{ review_enabled: 0 },false)).toThrow('experiment_assignment_locked');
    service.updateTodoWithEvaluationGuard(todo.id,{ title: 'Ordinary edit',review_enabled: todo.review_enabled },false);
    service.updateTodoWithEvaluationGuard(todo.id,{ review_enabled: 0 },true);
    expect(q.getTodoById(todo.id)?.review_enabled).toBe(0);expect(service.getEvaluationAssignment(todo.id)).toMatchObject({ arm_id: before.arm_id,integrity_state: 'contaminated',integrity_reason: 'todo_review_configuration_overridden' });
    expect(()=>db.prepare("UPDATE evaluation_campaign_assignments SET integrity_state='clean' WHERE id=?").run(before.id)).toThrow();
  });
  it('withdraws clean pre-start assignments and allows normal review config afterwards',()=>{
    const c=running(),todo=enroll(c);service.withdrawEvaluationAssignment(todo.id,projectId);
    expect(service.getEvaluationAssignment(todo.id)?.integrity_state).toBe('excluded');service.updateTodoWithEvaluationGuard(todo.id,{ review_enabled: 0 },false);
    const started=enroll(c);service.observeImplementationStart(started.id);expect(()=>service.withdrawEvaluationAssignment(started.id,projectId)).toThrow();
  });
  it('records timestamps once, records terminal callback, and does not contaminate stops or human actions',()=>{
    const todo=enroll(running());service.observeImplementationStart(todo.id);const first=service.getEvaluationAssignment(todo.id)!.first_execution_at;
    service.observeImplementationStart(todo.id);service.observeReviewStart(todo.id);const review=service.getEvaluationAssignment(todo.id)!.review_started_at;service.observeReviewStart(todo.id);
    q.updateTodoStatus(todo.id,'stopped');const a=service.getEvaluationAssignment(todo.id)!;
    expect(a.first_execution_at).toBe(first);expect(a.review_started_at).toBe(review);expect(a.finished_at).toBeTruthy();expect(a.integrity_state).toBe('clean');
  });
  it('hashes profile candidates, account policy and consensus policy/member/judge semantics, excluding runtime health',()=>{
    const c=running(),todo=enroll(c),config=helpers.todoReviewConfig(todo),before=helpers.hashReviewExperimentConfig(config);
    db.prepare("UPDATE provider_accounts SET health_state='unknown'").run();
    db.prepare("UPDATE cli_models SET status='missing'").run();
    expect(helpers.hashReviewExperimentConfig(config)).toBe(before);
    db.prepare('UPDATE execution_profile_executors SET effort_value=\'high\' WHERE profile_id=?').run(profileId);
    service.observeReviewStart(todo.id);expect(service.getEvaluationAssignment(todo.id)).toMatchObject({ integrity_state: 'contaminated',integrity_reason: 'review_configuration_changed' });
    const consensus={ ...config,review_mode: 'consensus' as const,review_profile_id: null,review_policy_id: policyId },hash=helpers.hashReviewExperimentConfig(consensus);
    db.prepare("UPDATE review_policies SET strategy='unanimous' WHERE id=?").run(policyId);expect(helpers.hashReviewExperimentConfig(consensus)).not.toBe(hash);
    const single={ ...config,review_mode: 'single' as const,review_profile_id: profileId,review_policy_id: null },singleHash=helpers.hashReviewExperimentConfig(single);
    db.prepare("UPDATE execution_profile_executors SET account_policy='automatic' WHERE profile_id=?").run(profileId);expect(helpers.hashReviewExperimentConfig(single)).not.toBe(singleHash);
  });
  it('runtime fallback identity remains clean and is exposed descriptively',()=>{
    const c=running(),todo=enroll(c);reviewed(todo);
    const result=analytics.getEvaluationCampaignAnalytics(c.id,projectId),arm=result.arms.find(a=>a.observedCount)!;
    expect(arm.clean).toBe(1);expect(arm.actualIdentities.itt.models.items).toContainEqual({ value: 'runtime-model',todos: 1 });expect(arm.actualIdentities.itt.accounts.items).toContainEqual({ value: 'runtime-account',todos: 1 });
  });
  it('validates symmetric feedback timing, labels, ownership, size and redaction; unknown is response only',()=>{
    const c=running(),todo=enroll(c);
    expect(()=>service.putCampaignFeedback(todo.id,projectId,{ label: 'helpful' })).toThrow();reviewed(todo);
    expect(()=>service.putCampaignFeedback(todo.id,otherProjectId,{ label: 'helpful' })).toThrow();expect(()=>service.putCampaignFeedback(todo.id,projectId,{ label: 'correct' })).toThrow();
    expect(()=>service.putCampaignFeedback(todo.id,projectId,{ label: 'helpful',note: 'я'.repeat(2049) })).toThrow();expect(()=>service.putCampaignFeedback(todo.id,projectId,{ label: 'helpful',note: '<script>bad</script>' })).toThrow();
    service.putCampaignFeedback(todo.id,projectId,{ label: 'helpful',note: 'api_key=sk-sensitive-value' });
    service.putCampaignFeedback(todo.id,projectId,{ label: 'unknown' });
    expect(db.prepare('SELECT * FROM evaluation_campaign_assignment_feedback').all()).toHaveLength(1);
    const arm=analytics.getEvaluationCampaignAnalytics(c.id,projectId).arms.find(a=>a.observedCount)!;expect(arm.itt.feedback).toMatchObject({ responses: 1,evaluative: 0,responseCoverage: 1,evaluativeCoverage: 0,helpfulRate: null });
    expect(q.getTodoById(todo.id)?.description).toBe('PRIVATE PROMPT');
  });
});
describe('ITT/PP projections, pagination and migration',()=>{
  it('exports exact retry treatment cost, excludes partial Todos from averages and preserves membership',async()=>{
    const { persistExecutionRoundUsage }=await import('../treatment-usage.js');
    const c=running(),todo=enroll(c),partial=enroll(c),pending=enroll(c);
    const r1=q.createExecutionRound(todo.id,'implementation',1,randomUUID(),{ status: 'failed',startedAt: now() });
    const r2=q.createExecutionRound(todo.id,'implementation',2,randomUUID(),{ status: 'completed',startedAt: now(),retryOfRoundId: r1.id });
    persistExecutionRoundUsage(r1.id,{ cost_usd: .0426689,input_tokens: 10,output_tokens: 5 });
    persistExecutionRoundUsage(r2.id,{ cost_usd: .0356593,input_tokens: 10,output_tokens: 5 });
    const review=q.createExecutionRound(todo.id,'review',3,randomUUID(),{ status: 'completed',startedAt: now() });
    const batch=randomUUID();
    db.prepare(`INSERT INTO consensus_review_batches (id,todo_id,review_round_id,review_policy_id,strategy,failure_policy,min_successful_reviewers,diversity_policy,max_parallel_reviewers,status,artifact_identity_json,evidence_hash,created_at,updated_at)
      VALUES (?,?,?,?,'majority','quorum',2,'none',2,'completed','{}','hash',?,?)`).run(batch,todo.id,review.id,policyId,now(),now());
    for (const cost of [.0566660,.0176279]) {
      const job=randomUUID();
      db.prepare(`INSERT INTO consensus_review_jobs (id,batch_id,role,execution_profile_id,label,weight,priority,status,created_at,updated_at) VALUES (?,?,'reviewer',?,'Reviewer',1,0,'completed',?,?)`).run(job,batch,profileId,now(),now());
      db.prepare(`INSERT INTO consensus_review_attempts (id,review_job_id,attempt_index,status,run_token,cost_usd,input_tokens,output_tokens,started_at,created_at,updated_at) VALUES (?,?,1,'completed',?,?,10,5,?,?,?)`).run(randomUUID(),job,randomUUID(),cost,now(),now(),now());
    }
    q.updateTodo(todo.id,{ total_cost_usd: .0356593,total_tokens: 999 });
    const known=q.createExecutionRound(partial.id,'implementation',1,randomUUID(),{ status: 'completed',startedAt: now() });
    persistExecutionRoundUsage(known.id,{ cost_usd: .01 });
    q.createExecutionRound(partial.id,'review',2,randomUUID(),{ status: 'completed',startedAt: now() });
    const before=[todo,partial,pending].map(t=>service.getEvaluationAssignment(t.id));
    const spy=vi.spyOn(db,'prepare');
    const data=analytics.getEvaluationCampaignAnalytics(c.id,projectId);
    expect(spy.mock.calls.filter(([sql])=>String(sql).includes('WITH selected AS'))).toHaveLength(1);
    expect(data.arms.reduce((n,a)=>n+a.itt.assignments,0)).toBe(3);
    expect(data.arms.reduce((n,a)=>n+a.pp.assignments,0)).toBe(3);
    expect(data.arms.reduce((n,a)=>n+a.itt.treatmentCostTodosFullyCovered,0)).toBe(1);
    expect(data.arms.reduce((n,a)=>n+a.itt.treatmentCostTodosStarted,0)).toBe(2);
    const covered=data.arms.find(a=>a.itt.treatmentCostTodosFullyCovered===1)!;
    expect(covered.itt.avgTreatmentCostUsd).toBeCloseTo(.1526221,10);
    expect(covered.itt.p50TreatmentCostUsd).toBeCloseTo(.1526221,10);
    expect(data.arms.reduce((n,a)=>n+(a.itt.knownTreatmentCostUsd??0),0)).toBeCloseTo(.1626221,10);
    const page=analytics.listCampaignAssignments(c.id,projectId);
    const assignment=page.assignments.find(a=>a.todo_id===todo.id)!;
    expect(assignment.known_treatment_cost_usd).toBeCloseTo(.1526221,10);
    expect(assignment).toMatchObject({ treatment_cost_attempts_known: 4,treatment_cost_attempts_total: 4,treatment_cost_coverage: 1,treatment_process_attempts: 4,known_treatment_io_tokens: 60,known_todo_cost_usd: .0356593 });
    expect(page.assignments.find(a=>a.todo_id===pending.id)).toMatchObject({ known_treatment_cost_usd: null,treatment_cost_coverage: null,treatment_process_attempts: 0 });
    const csv=analytics.campaignCsv(page);expect(csv).toContain('known_treatment_cost_usd,treatment_cost_attempts_known,treatment_cost_attempts_total,treatment_cost_coverage');
    expect(csv).toContain('known_treatment_io_tokens');expect(csv).toContain('known_cache_read_tokens');
    expect([todo,partial,pending].map(t=>service.getEvaluationAssignment(t.id))).toEqual(before);
  });
  it('keeps contamination in ITT, excludes withdrawal, handles attrition, denominators and unknown usage',()=>{
    const c=running(),clean=enroll(c),contaminated=enroll(c),excluded=enroll(c),pending=enroll(c);
    reviewed(clean);q.updateTodo(clean.id,{ total_cost_usd: .25,total_tokens: 120 });
    q.createExecutionRound(clean.id,'rework',2,randomUUID(),{ startedAt: now(),status: 'completed' });
    service.putCampaignFeedback(clean.id,projectId,{ label: 'helpful' });
    service.updateTodoWithEvaluationGuard(contaminated.id,{ max_review_rounds: 7 },true);reviewed(contaminated,'failed');service.putCampaignFeedback(contaminated.id,projectId,{ label: 'mixed' });
    service.withdrawEvaluationAssignment(excluded.id,projectId);
    const data=analytics.getEvaluationCampaignAnalytics(c.id,projectId),sum=(key: 'itt' | 'pp',metric: keyof ReturnType<typeof analytics.getEvaluationCampaignAnalytics>['arms'][0]['itt'])=>data.arms.reduce((n,a)=>n+Number(a[key][metric]),0);
    expect(data.totalAssigned).toBe(4);expect(sum('itt','assignments')).toBe(3);expect(sum('pp','assignments')).toBe(2);
    expect(sum('itt','started')).toBe(2);expect(sum('itt','reachedReview')).toBe(2);expect(sum('itt','terminal')).toBe(2);expect(sum('itt','todosWithRework')).toBe(1);
    expect(sum('itt','todoCostKnown')).toBe(1);expect(sum('itt','todoTokensKnown')).toBe(1);
    expect(data.arms.reduce((n,a)=>n+a.excluded,0)).toBe(1);expect(data.arms.reduce((n,a)=>n+a.contaminated,0)).toBe(1);
    expect(JSON.stringify(data)).not.toMatch(/winner|recommendedArm|"rank"|PRIVATE PROMPT|PRIVATE RESULT/);
    expect(service.getEvaluationAssignment(pending.id)?.first_execution_at).toBeNull();
  });
  it('compares experiments to control with raw differences and nullable zero ratios',()=>{
    const c=running();let control: q.Todo | undefined,experiment: q.Todo | undefined;
    for (let i=0;i<100 && (!control || !experiment);i++) { const todo=enroll(c);if (service.getEvaluationAssignment(todo.id)?.arm_id===c.arms[0].id) control=todo;else experiment=todo; }
    reviewed(control!);reviewed(experiment!,'failed');q.updateTodo(control!.id,{ total_cost_usd: 0 });q.updateTodo(experiment!.id,{ total_cost_usd: .2 });
    const comparison=analytics.getEvaluationCampaignAnalytics(c.id,projectId).comparisons[0].itt;
    expect(comparison.avgTreatmentCostUsd).toEqual({ controlValue: null,armValue: null,absoluteDifference: null,relativeRatio: null });
    expect(comparison).not.toHaveProperty('knownTodoCostUsd');
  });
  it('bounds a 10k-assignment response and CSV, preserves nulls and prevents formula injection',()=>{
    const c=running(),first=enroll(c),a=service.getEvaluationAssignment(first.id)!;
    db.transaction(()=>{
      for (let i=0;i<9999;i++) {
        const id=`large-${i}`,choice=helpers.chooseEvaluationArm(c,id);
        db.prepare('INSERT INTO todos (id,project_id,title,description,created_at,updated_at) VALUES (?,?,?,\'PRIVATE PROMPT\',?,?)').run(id,projectId,'Scale',now(),now());
        db.prepare(`INSERT INTO evaluation_campaign_assignments (id,campaign_id,arm_id,todo_id,assignment_source,assignment_algorithm,assignment_hash,assignment_bucket,campaign_definition_hash,arm_definition_hash,arm_snapshot_json,assigned_review_config_hash,assigned_at)
          VALUES (?,?,?,?,'manual_todo','sha256_weighted_v1',?,?,?,?,?,?,?)`).run(randomUUID(),c.id,choice.arm.id,id,choice.hash,choice.bucket,a.campaign_definition_hash,choice.arm.definition_hash,a.arm_snapshot_json,a.assigned_review_config_hash,now());
      }
    })();
    const data=analytics.getEvaluationCampaignAnalytics(c.id,projectId);expect(data.totalAssigned).toBe(10000);expect(JSON.stringify(data).length).toBeLessThan(25000);
    expect(data.arms.every(arm=>arm.itt.knownTodoCostUsd===null && arm.itt.todoCostCoverage===0)).toBe(true);
    const page=analytics.listCampaignAssignments(c.id,projectId,200);expect(page.assignments).toHaveLength(200);expect(page.total).toBe(10000);expect(page.hasMore).toBe(true);
    page.assignments[0].arm_name='=HYPERLINK("bad")';const csv=analytics.campaignCsv(page);expect(csv).toContain("'=");expect(csv).not.toMatch(/PRIVATE|description|prompt|execution_snapshot|note/);
  });
  it('migrates twice without modifying existing history or Todo rows and remains FK-clean',()=>{
    const old=q.createTodo(projectId,'Legacy','Retained'),schedule=q.createSchedule(projectId,'Scheduled','schedule fixture','* * * * *');
    db.prepare('INSERT INTO orchestrators (id,project_id,title,objective,primary_execution_profile_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('legacy-orchestrator',projectId,'Retained orchestrator','Retained objective',profileId,now(),now());
    db.prepare("INSERT INTO orchestrator_turns (id,orchestrator_id,turn_index,status,trigger_type,assistant_output,created_at) VALUES (?, ?,1,'completed','manual','Retained output',?)").run('legacy-turn','legacy-orchestrator',now());
    const history=db.prepare('SELECT * FROM orchestrator_turns').all(),orchestrators=db.prepare('SELECT * FROM orchestrators').all(),quotas=db.prepare('SELECT * FROM provider_account_quota_state').all();
    const before=q.getTodoById(old.id);migrateEvaluationCampaigns(db);migrateEvaluationCampaigns(db);
    expect(q.getTodoById(old.id)).toEqual(before);expect(q.getScheduleById(schedule.id)).toBeDefined();expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT * FROM orchestrator_turns').all()).toEqual(history);expect(db.prepare('SELECT * FROM orchestrators').all()).toEqual(orchestrators);expect(db.prepare('SELECT * FROM provider_account_quota_state').all()).toEqual(quotas);
    expect(service.getEvaluationAssignment(old.id)).toBeNull();
  });
});
describe('production HTTP boundaries',()=>{
  it('creates atomic enrolled Todo via canonical router, rejects cross-project/arm selection and accidental override',async()=>{
    const app=express();app.use(express.json());app.use('/api',router);app.use('/api',todosRouter);
    const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    async function request(path: string,method='GET',body?: unknown) { return fetch(base+path,{ method,headers: { 'Content-Type': 'application/json' },body: body ? JSON.stringify(body) : undefined }); }
    try {
      const response=await request(`/projects/${projectId}/evaluation-campaigns`,'POST',{ name: 'HTTP',arms: arms() });expect(response.status).toBe(201);const c=await response.json();
      expect((await request(`/evaluation-campaigns/${c.id}/start`,'POST',{ projectId: otherProjectId })).status).toBe(404);
      expect((await request(`/evaluation-campaigns/${c.id}/start`,'POST',{ projectId })).status).toBe(200);
      expect((await request(`/projects/${projectId}/todos`,'POST',{ title: 'Chosen arm',evaluation_arm_id: c.arms[0].id })).status).toBe(400);
      const created=await request(`/projects/${projectId}/todos`,'POST',{ title: 'HTTP task',description: 'PRIVATE HTTP PROMPT',cli_tool: 'claude',evaluation_campaign_id: c.id,evaluation_campaign_enroll: true });expect(created.status).toBe(201);const todo=await created.json();
      expect((await request(`/todos/${todo.id}/evaluation-assignment?projectId=${otherProjectId}`)).status).toBe(404);
      expect((await request(`/todos/${todo.id}`,'DELETE')).status).toBe(409);
      expect((await request(`/todos/${todo.id}`,'PUT',{ evaluation_arm_id: c.arms[0].id })).status).toBe(400);
      const assigned=await (await request(`/todos/${todo.id}/evaluation-assignment?projectId=${projectId}`)).json();expect(assigned.arm_id).toBeTruthy();expect(assigned.explanation.totalWeight).toBe(2);
      expect((await request(`/todos/${todo.id}`,'PUT',{ review_enabled: 0 })).status).toBe(409);
      expect((await request(`/todos/${todo.id}`,'PUT',{ review_enabled: 0,evaluation_override: true })).status).toBe(200);
      const data=await (await request(`/evaluation-campaigns/${c.id}/analytics?projectId=${projectId}`)).json();expect(data.arms.reduce((n: number,a: any)=>n+a.itt.assignments,0)).toBe(1);expect(data.arms.reduce((n: number,a: any)=>n+a.pp.assignments,0)).toBe(0);
      expect((await request(`/evaluation-campaigns/${c.id}/assignments?projectId=${projectId}&limit=201`)).status).toBe(400);
      const csv=await request(`/evaluation-campaigns/${c.id}/export.csv?projectId=${projectId}`);expect(csv.headers.get('X-Total-Count')).toBe('1');expect(await csv.text()).not.toContain('PRIVATE HTTP PROMPT');
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())); }
  });
});
