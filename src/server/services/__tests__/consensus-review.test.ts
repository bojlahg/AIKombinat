import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'node:stream';
import { initDatabase } from '../../db/schema.js';
import { aggregateConsensus, type ConsensusStrategy } from '../consensus-result.js';
import type { ReviewResult } from '../review-result.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
const q = await import('../../db/queries.js');
const { saveReviewPolicy, getReviewPolicy, disableReviewPolicy } = await import('../review-policy.js');
const { ConsensusReviewService, consensusJobs, consensusAttempts, getConsensusBatch,hasActiveConsensusReview } = await import('../consensus-review.js');
const { reviewPipeline } = await import('../review-pipeline.js');
const { executorPool } = await import('../executor-pool.js');
const { claudeManager } = await import('../claude-manager.js');
const { resourceManager } = await import('../resource-manager.js');
const { providerQuotaService } = await import('../provider-quota.js');
const cliStatus = await import('../cli-status.js');
const accounts = await import('../provider-account-service.js');
const { randomUUID } = await import('node:crypto');
const processTree = await import('../../utils/process-tree.js');
const { ConsensusOutputCollector } = await import('../consensus-output.js');
const { executionSnapshot } = await import('../execution-config.js');
const identity = { baselineCommit: 'a',reviewedHeadCommit: 'b',worktreeStateHash: 'c',diffHash: 'd',changedFiles: ['a.ts'],untrackedFiles: [],truncated: false };
const approved: ReviewResult = { verdict: 'approved',summary: 'OK',issues: [] };
const changes: ReviewResult = { verdict: 'needs_changes',summary: 'Fix',issues: [{ severity: 'major',description: 'Bug',files: ['a.ts'] }] };
const vote = (result: ReviewResult | null, i: number, weight = 1) => ({ id: String(i),priority: i,created_at: '2026-01-01',weight,result });

describe('deterministic consensus matrix', () => {
  for (const strategy of ['majority','unanimous','weighted','judge','judge_on_disagreement'] as const) {
    for (let count = 2; count <= 7; count++) for (let mask = 0; mask < 2 ** count; mask++) {
      it(`${strategy} ${count} reviewers ${mask}`, () => {
        const reviewers = Array.from({ length: count },(_,i) => vote(mask & (1 << i) ? approved : changes,i,i + 1));
        const result = aggregateConsensus({ strategy,failure_policy: 'require_all',min_successful_reviewers: count,reviewers });
        const yes = reviewers.filter(r => r.result.verdict === 'approved');
        const yesWeight = yes.reduce((n,r) => n + r.weight,0), totalWeight = count * (count + 1) / 2;
        const judge = strategy === 'judge' || (strategy === 'judge_on_disagreement' && yes.length > 0 && yes.length < count);
        const pass = strategy === 'weighted' ? yesWeight > totalWeight-yesWeight
          : strategy === 'unanimous' || strategy === 'judge_on_disagreement' ? yes.length === count : yes.length > count-yes.length;
        expect(result.needs_judge).toBe(judge);
        expect(result.verdict).toBe(!judge && pass ? 'approved' : 'needs_changes');
        expect(result.approved_votes + result.needs_changes_votes).toBe(count);
        if (result.verdict === 'approved') expect(result.issues).toEqual([]);
      });
    }
  }
  it('excludes failed votes and enforces exact quorum / require_all', () => {
    const reviewers = [vote(approved,0),vote(approved,1),vote(null,2,10)];
    const input = { strategy: 'weighted' as const,failure_policy: 'quorum' as const,min_successful_reviewers: 2,reviewers };
    expect(aggregateConsensus(input)).toMatchObject({ verdict: 'approved',failed_count: 1,approved_weight: 2,needs_changes_weight: 0 });
    expect(aggregateConsensus({ ...input,min_successful_reviewers: 3 }).failure_reason).toBeTruthy();
    expect(aggregateConsensus({ ...input,failure_policy: 'require_all' }).failure_reason).toBeTruthy();
  });
  it('normalizes Unicode, preserves file distinctions and highest severity, and orders issues', () => {
    const result = aggregateConsensus({ strategy: 'majority',failure_policy: 'require_all',min_successful_reviewers: 2,reviewers: [
      vote({ ...changes,issues: [{ severity: 'minor',description: '  Ошибка   ДАННЫХ ',files: ['b.ts','a.ts'] },{ severity: 'major',description: 'Other',files: [] }] },0),
      vote({ ...changes,issues: [{ severity: 'blocking',description: 'ошибка данных',files: ['a.ts','b.ts'] },{ severity: 'minor',description: 'ошибка данных',files: ['c.ts'] }] },1),
    ] });
    expect(result.issues.map(i => i.severity)).toEqual(['blocking','major','minor']);
    expect(result.issues).toHaveLength(3);
  });
});

describe('durable consensus lifecycle', () => {
  let workspace: TestWorkspace, service: InstanceType<typeof ConsensusReviewService>;
  let todo: q.Todo, round: q.TodoExecutionRound, profileId: string, batchId: string;
  let processes: Array<{ stdout: PassThrough; stderr: PassThrough; exit: (code: number) => void; pid: number }>;
  beforeEach(() => {
    workspace = createTestWorkspace('consensus'); db = new Database(':memory:');db.pragma('foreign_keys=ON');initDatabase(db);
    service = new ConsensusReviewService();processes = [];
    const project = q.createProject('Consensus',workspace.path);
    profileId = q.createExecutionProfile({ name: 'Reviewer',slug: 'reviewer',description: '',executors: [] }).id;
    todo = q.createTodo(project.id,'Fix code','Implement a tiny fix');q.updateTodo(todo.id,{ review_enabled: 1,review_mode: 'consensus',max_review_rounds: 3 });
    round = q.createExecutionRound(todo.id,'review',2,'round-token',{ inputPayload: 'same immutable evidence',artifactIdentity: JSON.stringify(identity) });
    vi.spyOn(reviewPipeline,'collectReviewArtifact').mockResolvedValue({ summary: 'same immutable evidence',identity });
    vi.spyOn(executorPool,'selectExecutor').mockImplementation(async input => {
      const config = { cliTool: 'claude' as const,source: 'profile' as const,model: 'test',requestedModel: 'test',modelAvailability: 'available' as const,
        effort: { nativeEffort: undefined,supportedEfforts: null,resolution: 'provider-default' as const },warnings: [],resolvedAt: new Date().toISOString() };
      return { status: 'selected',selectedConfig: config,evaluations: [],evaluatedAt: config.resolvedAt };
    });
    vi.spyOn(claudeManager,'startClaude').mockImplementation(async () => {
      const stdout = new PassThrough(), stderr = new PassThrough();let exit!: (code: number) => void;
      const exitPromise = new Promise<number>(resolve => { exit = code => { stdout.end();stderr.end();resolve(code); }; });
      const pid = 50000 + processes.length;
      processes.push({ stdout,stderr,exit,pid });
      return { stdout,stderr,exitPromise,pid,stdin: null,command: 'claude',args: [],processIdentity: { pid,startedAt: 'test' } };
    });
    vi.spyOn(claudeManager,'stopClaude').mockResolvedValue({ status: 'terminated',pid: 50000,graceful: true });
  });
  afterEach(async () => { await service.shutdown();resourceManager.resetForTesting();executorPool.resetReservations();providerQuotaService.resetForTesting();executorPool.setAvailabilityCallback(null);executorPool.resetLimits();vi.restoreAllMocks();vi.unstubAllEnvs();db.close();workspace.cleanup(); });
  function start(strategy: ConsensusStrategy = 'majority', failure_policy: 'require_all' | 'quorum' = 'require_all', count = 3, parallel = 3) {
    const policy = saveReviewPolicy({ name: 'Policy',strategy,failure_policy,min_successful_reviewers: 2,max_parallel_reviewers: parallel,
      judge_execution_profile_id: strategy.startsWith('judge') ? profileId : null,
      members: Array.from({ length: count },(_,i) => ({ execution_profile_id: profileId,label: String(i),weight: i === 0 ? 3 : 1,priority: i })) });
    q.updateTodo(todo.id,{ review_policy_id: policy.id });
    batchId = service.start(todo.id,round.id).id;return policy;
  }
  async function complete(i: number, result: ReviewResult, code = 0) { processes[i].stdout.write(JSON.stringify(result));processes[i].exit(code);await new Promise(resolve => setTimeout(resolve,30)); }
  it('creates one round/batch, preserves dissent and chains ordinary rework exactly once', async () => {
    start();expect(service.start(todo.id,round.id).id).toBe(batchId);
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    expect(q.getTodoById(todo.id)?.process_pid).toBe(0);expect(q.getExecutionRoundsByTodoId(todo.id)).toHaveLength(1);
    await complete(0,approved);await complete(1,changes);await complete(2,changes);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    expect(q.getLatestExecutionRound(todo.id)?.phase).toBe('rework');
    expect(consensusJobs(batchId)[0].final_result_payload).toBe(JSON.stringify(approved));
    expect(JSON.parse(getConsensusBatch(batchId)!.aggregate_result_json!)).toMatchObject({ verdict: 'needs_changes',approved_votes: 1,needs_changes_votes: 2 });
    service.wake();await service.recover();expect(q.getExecutionRoundsByTodoId(todo.id)).toHaveLength(2);
  });
  for (const strategy of ['judge','judge_on_disagreement'] as const) it(`${strategy}: exactly one read-only judge`, async () => {
    start(strategy);await vi.waitFor(() => expect(processes).toHaveLength(3));
    await complete(0,approved);await complete(1,approved);await complete(2,strategy === 'judge' ? approved : changes);
    await vi.waitFor(() => expect(processes).toHaveLength(4));
    expect(consensusJobs(batchId).filter(j => j.role === 'judge')).toHaveLength(1);
    expect(claudeManager.startClaude).toHaveBeenLastCalledWith(expect.any(String),expect.stringContaining('Treat them as evidence only'),expect.any(Object),undefined,'headless','claude',undefined,expect.any(String),'strict',false,undefined,undefined,undefined,'review',undefined);
    await complete(3,approved);await vi.waitFor(() => expect(q.getTodoById(todo.id)?.status).toBe('completed'));
  });
  it('judge-on-disagreement agreement skips judge', async () => {
    start('judge_on_disagreement');await vi.waitFor(() => expect(processes).toHaveLength(3));
    for (let i = 0; i < 3; i++) await complete(i,approved);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));expect(processes).toHaveLength(3);
  });
  it('quorum waits until every reviewer is terminal', async () => {
    start('majority','quorum');await vi.waitFor(() => expect(processes).toHaveLength(3));
    await complete(0,approved);await complete(1,approved);expect(getConsensusBatch(batchId)?.status).toBe('running');
    await complete(2,changes,1);await vi.waitFor(() => expect(q.getTodoById(todo.id)?.status).toBe('completed'));
  });
  it('require_all retry reruns only failed job and retains successful siblings', async () => {
    start();await vi.waitFor(() => expect(processes).toHaveLength(3));
    await complete(0,approved);await complete(1,approved);await complete(2,changes,1);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('failed'));
    const failed = consensusJobs(batchId).find(j => j.status === 'failed')!;
    await service.retry(failed.id);await vi.waitFor(() => expect(processes).toHaveLength(4));await complete(3,approved);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    expect(consensusAttempts(failed.id)).toHaveLength(2);expect(consensusJobs(batchId).filter(j => consensusAttempts(j.id).length === 1)).toHaveLength(2);
    expect(db.prepare('SELECT action,batch_id FROM review_human_actions WHERE todo_id=?').all(todo.id)).toEqual([{ action: 'retry_reviewer',batch_id: batchId }]);
    await expect(service.retry(failed.id)).rejects.toThrow('batch_already_finalized');
  });
  it('artifact mutation fails closed and stops siblings', async () => {
    start();await vi.waitFor(() => expect(processes).toHaveLength(3));
    vi.mocked(reviewPipeline.collectReviewArtifact).mockResolvedValue({ summary: 'changed',identity: { ...identity,diffHash: 'different' } });
    await complete(0,approved);await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('failed'));
    expect(getConsensusBatch(batchId)?.failure_reason).toBe('review_artifact_changed');expect(getConsensusBatch(batchId)?.aggregate_result_json).toBeNull();
    expect(claudeManager.stopClaude).toHaveBeenCalledTimes(2);expect(q.getTodoById(todo.id)?.status).toBe('failed');
  });
  it('unresolved Stop retains PID/resource ownership and blocks retry', async () => {
    start();await vi.waitFor(() => expect(processes).toHaveLength(3));
    vi.mocked(claudeManager.stopClaude).mockResolvedValue({ status: 'unresolved',pid: 50000,reason: 'unverifiable' });
    expect(await service.stop(todo.id)).toBe(false);expect(getConsensusBatch(batchId)?.status).toBe('recovery_required');
    expect(consensusAttempts(consensusJobs(batchId)[0].id)[0].process_pid).toBeGreaterThan(0);
    await expect(service.retry(consensusJobs(batchId)[0].id)).rejects.toThrow();
    vi.mocked(claudeManager.stopClaude).mockResolvedValue({ status: 'terminated',pid: 50000,graceful: true });
  });
  it('bounds parallelism and cancels pending jobs on Stop', async () => {
    start('majority','require_all',3,1);await vi.waitFor(() => expect(processes).toHaveLength(1));
    expect(await service.stop(todo.id)).toBe(true);service.wake();await new Promise(resolve => setTimeout(resolve,30));
    expect(processes).toHaveLength(1);expect(getConsensusBatch(batchId)?.status).toBe('stopped');
  });
  it('policy edits/disable do not change batch snapshots and migration is idempotent/FK clean', async () => {
    const policy = start();await vi.waitFor(() => expect(processes).toHaveLength(3));
    saveReviewPolicy({ ...policy,strategy: 'weighted',members: policy.members },policy.id);disableReviewPolicy(policy.id);
    expect(getReviewPolicy(policy.id)?.is_enabled).toBe(0);expect(getConsensusBatch(batchId)?.strategy).toBe('majority');
    initDatabase(db);expect(db.pragma('foreign_key_check')).toEqual([]);expect(q.getTodoById(todo.id)?.review_mode).toBe('consensus');
  });
  function useRealPool(policy: 'automatic' | 'fixed' | 'inherited_default' = 'inherited_default', accountId?: string) {
    vi.mocked(executorPool.selectExecutor).mockRestore();
    vi.spyOn(cliStatus,'getToolStatus').mockImplementation(async tool => ({ tool,installed: true,version: 'synthetic' }));
    const model = q.addModel('claude','synthetic-model','Synthetic');
    q.updateExecutionProfile(profileId,{ executors: [{ cli_model_id: model.id,effort_value: null,priority: 0,account_policy: policy,provider_account_id: accountId }] });
    executorPool.setAvailabilityCallback(() => service.wake());
    resourceManager.setAvailabilityCallback(() => service.wake());
    providerQuotaService.setAvailabilityCallback(() => service.wake());
    providerQuotaService.initialize();
  }
  it('real pool enforces provider/account capacity without reservation/PID double count', async () => {
    useRealPool();executorPool.setLimit('claude',1);start();
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    const account = accounts.accountCandidates('claude')[0];expect(executorPool.getActiveAccountUsage(account.id)).toBe(1);
    await complete(0,approved);await vi.waitFor(() => expect(processes).toHaveLength(2));
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    await complete(1,approved);await vi.waitFor(() => expect(processes).toHaveLength(3));await complete(2,approved);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));expect(executorPool.getActiveToolUsage('claude')).toBe(0);
  });
  it('soft diversity prefers equal-priority providers/accounts but respects fixed identity and priority', async () => {
    useRealPool();
    const claude = q.getExecutionProfileById(profileId)!.executors[0];
    const codex = q.addModel('codex','synthetic-codex','Codex');
    q.updateExecutionProfile(profileId,{ executors: [
      { cli_model_id: claude.cli_model_id,effort_value: null,priority: 0,account_policy: 'inherited_default' },
      { cli_model_id: codex.id,effort_value: null,priority: 0,account_policy: 'inherited_default' },
    ] });
    const provider = await executorPool.selectExecutor({ executionProfileId: profileId,avoidCliTools: ['claude'] });
    expect(provider.selectedConfig?.cliTool).toBe('codex');
    const inherited = accounts.accountCandidates('claude')[0];
    vi.stubEnv('CONSENSUS_DIVERSITY','synthetic');
    const other = accounts.saveProviderAccount({ provider: 'claude',slug: 'diversity',label: 'Diverse',auth_strategy: 'environment_reference',auth_config: { variable: 'CONSENSUS_DIVERSITY' } });
    q.updateExecutionProfile(profileId,{ executors: [{ cli_model_id: claude.cli_model_id,effort_value: null,priority: 0,account_policy: 'automatic' }] });
    const automatic = await executorPool.selectExecutor({ executionProfileId: profileId,avoidProviderAccountIds: [inherited.id] });
    expect(automatic.selectedConfig?.providerAccountId).toBe(other.id);
    q.updateExecutionProfile(profileId,{ executors: [
      { cli_model_id: claude.cli_model_id,effort_value: null,priority: 0,account_policy: 'fixed',provider_account_id: inherited.id },
      { cli_model_id: codex.id,effort_value: null,priority: 1,account_policy: 'inherited_default' },
    ] });
    const fixed = await executorPool.selectExecutor({ executionProfileId: profileId,avoidCliTools: ['claude'],avoidProviderAccountIds: [inherited.id] });
    expect(fixed.selectedConfig).toMatchObject({ cliTool: 'claude',providerAccountId: inherited.id });
  });
  it('reviewer resources serialize on one thread, keep waiting PID=0 and wake automatically', async () => {
    const local = db.prepare("SELECT id FROM compute_nodes WHERE transport='local'").get() as { id: string };
    const inventory = { platform: { os: 'windows',arch: 'x64',hostname: 'synthetic' },cpu: { model: 'fixture',logical_threads: 1,physical_cores: 1,threads_per_core: 1,flags: [] },memory: { total_bytes: 1000000,available_bytes: 1000000 },storage: [{ mount: workspace.path,total_bytes: 1000000,free_bytes: 1000000 }],gpus: [],capabilities: {} };
    const observation = { timestamp: new Date().toISOString(),memory_available_bytes: 1000000,storage: inventory.storage,gpus: [] };
    db.prepare('INSERT INTO inventory_snapshots VALUES (?,?,?,?,?)').run(randomUUID(),local.id,JSON.stringify(inventory),'[]',observation.timestamp);
    db.prepare('INSERT INTO resource_observations VALUES (?,?,?)').run(local.id,JSON.stringify(observation),observation.timestamp);
    db.prepare('INSERT INTO resource_policies VALUES (?,?)').run(local.id,JSON.stringify({ cpu_reserve_threads: 0,memory_reserve_bytes: 0,storage_reserve_bytes: 0,memory_safety_bytes: 0,avoid_external_gpu: true,capability_overrides: {} }));
    q.updateTodo(todo.id,{ resource_requirements: JSON.stringify({ version: 2,requires: { cpu: { threads: 1 } },prefers: {} }) });
    resourceManager.setAvailabilityCallback(() => service.wake());start();await vi.waitFor(() => expect(processes).toHaveLength(1));
    await vi.waitFor(() => expect(consensusJobs(batchId).filter(j => j.status === 'waiting_resource')).toHaveLength(2));
    for (const job of consensusJobs(batchId).filter(j => j.status === 'waiting_resource')) expect(consensusAttempts(job.id)[0].process_pid).toBe(0);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_leases WHERE owner_type='reviewer'").get()).toEqual({ count: 1 });
    await complete(0,approved);await vi.waitFor(() => expect(processes).toHaveLength(2));await complete(1,approved);
    await vi.waitFor(() => expect(processes).toHaveLength(3));await complete(2,approved);await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    expect(db.prepare('SELECT COUNT(*) count FROM resource_leases').get()).toEqual({ count: 0 });
  });
  it('account A quota -> account B attempt remains one vote, preserves chain and snapshot', async () => {
    const inherited = accounts.accountCandidates('claude')[0];accounts.saveProviderAccount({ is_enabled: false },inherited.id);
    vi.stubEnv('CONSENSUS_ACCOUNT_A','synthetic-a');vi.stubEnv('CONSENSUS_ACCOUNT_B','synthetic-b');
    const a = accounts.saveProviderAccount({ provider: 'claude',slug: 'a',label: 'A',auth_strategy: 'environment_reference',auth_config: { variable: 'CONSENSUS_ACCOUNT_A' },sort_order: 0,max_concurrency: 1 });
    const b = accounts.saveProviderAccount({ provider: 'claude',slug: 'b',label: 'B',auth_strategy: 'environment_reference',auth_config: { variable: 'CONSENSUS_ACCOUNT_B' },sort_order: 1,max_concurrency: 1 });
    useRealPool('automatic');start('majority','require_all',2,1);await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0].stderr.write('exceeded your current quota');processes[0].exit(1);
    await vi.waitFor(() => expect(processes).toHaveLength(2));await complete(1,approved);
    await vi.waitFor(() => expect(processes).toHaveLength(3));await complete(2,approved);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    const first = consensusJobs(batchId)[0], attempts = consensusAttempts(first.id);
    expect(attempts).toHaveLength(2);expect(attempts.map(attempt => JSON.parse(attempt.execution_snapshot!).providerAccountId)).toEqual([a.id,b.id]);
    expect(JSON.parse(getConsensusBatch(batchId)!.aggregate_result_json!).approved_votes).toBe(2);
    expect(db.prepare('SELECT * FROM account_failover_events WHERE owner_id=?').get(first.id)).toMatchObject({ owner_type: 'consensus_reviewer',from_account_id: a.id,to_account_id: b.id });
    expect(accounts.accountUsage(a.id)).toBeGreaterThan(0);
  });
  it('fixed quota waits at PID=0 then wakes on the same account', async () => {
    const inherited = accounts.accountCandidates('claude')[0];useRealPool('fixed',inherited.id);start('majority','require_all',2,1);
    await vi.waitFor(() => expect(processes).toHaveLength(1));processes[0].stderr.write('exceeded your current quota');processes[0].exit(1);
    await vi.waitFor(() => expect(consensusJobs(batchId)[0].status).toBe('waiting_quota'));
    expect(consensusAttempts(consensusJobs(batchId)[0].id).at(-1)?.process_pid).toBe(0);
    providerQuotaService.markAccountAvailable(inherited.id);await vi.waitFor(() => expect(processes).toHaveLength(2));await complete(1,approved);
    await vi.waitFor(() => expect(processes).toHaveLength(3));await complete(2,approved);await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    expect(consensusAttempts(consensusJobs(batchId)[0].id).map(a => JSON.parse(a.execution_snapshot ?? '{}').providerAccountId).filter(Boolean)).toEqual([inherited.id,inherited.id]);
  });
  it('crash before aggregation reuses votes and finalizes once', async () => {
    start();await vi.waitFor(() => expect(processes).toHaveLength(3));
    db.prepare("UPDATE consensus_review_attempts SET status='completed',process_pid=0,process_identity=NULL,result_payload=?").run(JSON.stringify(approved));
    db.prepare("UPDATE consensus_review_jobs SET status='completed',final_result_payload=?").run(JSON.stringify(approved));
    const recovered = new ConsensusReviewService();await recovered.recover();
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));await recovered.recover();
    expect(processes).toHaveLength(3);expect(q.getExecutionRoundsByTodoId(todo.id)).toHaveLength(1);
    await recovered.shutdown();
  });
  it('live matching PID after restart retains ownership and prevents duplicate launch', async () => {
    start();await vi.waitFor(() => expect(processes).toHaveLength(3));
    vi.spyOn(processTree,'isProcessAlive').mockReturnValue(true);vi.spyOn(processTree,'verifyProcessIdentity').mockResolvedValue('match');
    const recovered = new ConsensusReviewService();await recovered.recover();
    expect(getConsensusBatch(batchId)?.status).toBe('recovery_required');expect(processes).toHaveLength(3);
    expect(consensusJobs(batchId).every(j => j.status === 'recovery_required')).toBe(true);await recovered.shutdown();
  });
  it('restart after a dead reviewer preserves successful votes and allows only that job to retry', async () => {
    start();await vi.waitFor(() => expect(processes).toHaveLength(3));await complete(0,approved);await complete(1,approved);
    vi.spyOn(processTree,'isProcessAlive').mockReturnValue(false);
    const recovered = new ConsensusReviewService();await recovered.recover();
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('failed'));
    const failed = consensusJobs(batchId).find(j=>j.status==='failed')!;
    expect(consensusAttempts(failed.id)[0]).toMatchObject({ error_message:'controller_restart',process_pid:0 });
    await recovered.retry(failed.id);await vi.waitFor(() => expect(processes).toHaveLength(4));await complete(3,approved);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    expect(consensusJobs(batchId).filter(j=>j.id!==failed.id).every(j=>consensusAttempts(j.id).length===1)).toBe(true);
    await recovered.shutdown();
  });
  it('deletion ownership guard includes waiting batches and terminal status with retained positive PID', async () => {
    start();expect(hasActiveConsensusReview({todoId:todo.id})).toBe(true);
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    db.prepare("UPDATE consensus_review_batches SET status='failed' WHERE id=?").run(batchId);
    expect(hasActiveConsensusReview({projectId:todo.project_id})).toBe(true);
    db.prepare("UPDATE consensus_review_attempts SET status='failed',process_pid=0").run();
    expect(hasActiveConsensusReview({todoId:todo.id})).toBe(false);
  });
  it('Claude result events yield validated text and bounded telemetry without storing tool output', () => {
    const collector = new ConsensusOutputCollector(true);
    collector.push(JSON.stringify({ type: 'system',message: 'noise' })+'\n');
    collector.push(JSON.stringify({ type: 'assistant',message: { content: [{ type: 'text',text: JSON.stringify(approved) }] } })+'\n');
    collector.push(JSON.stringify({ type: 'result',result: JSON.stringify(approved),usage: { input_tokens: 10,output_tokens: 20 },total_cost_usd: 0.001 }));
    expect(JSON.parse(collector.finish())).toEqual(approved);expect(collector.usage).toEqual({ input_tokens: 10,output_tokens: 20,cost_usd: 0.001 });expect(collector.overflow).toBe(false);
  });

  it('full implementation -> consensus changes -> ordinary rework -> fresh consensus approval', async () => {
    db.prepare('DELETE FROM todo_execution_rounds WHERE todo_id=?').run(todo.id);
    const implementation = q.createExecutionRound(todo.id,'implementation',1,'implementation-token',{ status: 'running',inputPayload: todo.description });
    q.updateTodoStatus(todo.id,'running');
    const review = await reviewPipeline.advanceRoundOnSuccess(todo.id,implementation.id);
    expect(review.action).toBe('start_review');round = review.nextRound!;start();
    await vi.waitFor(() => expect(processes).toHaveLength(3));for (let i=0;i<3;i++) await complete(i,changes);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    const firstBatch = batchId,rework = q.getLatestExecutionRound(todo.id)!;
    expect(rework.phase).toBe('rework');expect(rework.input_payload).toContain('Bug');
    q.updateExecutionRound(rework.id,{ status: 'running' });q.updateTodoStatus(todo.id,'running');
    const next = await reviewPipeline.advanceRoundOnSuccess(todo.id,rework.id);
    expect(next.action).toBe('start_review');expect(next.nextRound!.input_payload).toContain('Bug');round=next.nextRound!;
    batchId=service.start(todo.id,round.id).id;expect(batchId).not.toBe(firstBatch);
    await vi.waitFor(() => expect(processes).toHaveLength(6));for(let i=3;i<6;i++) await complete(i,approved);
    await vi.waitFor(() => expect(q.getTodoById(todo.id)?.status).toBe('completed'));
    expect(q.getExecutionRoundsByTodoId(todo.id).map(r => r.phase)).toEqual(['implementation','review','rework','review']);
  });
  it('logical review budget counts cycles, not reviewer attempts', async () => {
    q.updateTodo(todo.id,{ max_review_rounds: 1 });start();await vi.waitFor(() => expect(processes).toHaveLength(3));
    for(let i=0;i<3;i++) await complete(i,changes);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));
    expect(q.getExecutionRoundsByTodoId(todo.id)).toHaveLength(1);expect(q.getTodoById(todo.id)?.status).toBe('failed');
  });
  it('judge failure has no majority fallback; Retry Judge preserves reviewer evidence', async () => {
    start('judge');await vi.waitFor(() => expect(processes).toHaveLength(3));for(let i=0;i<3;i++) await complete(i,approved);
    await vi.waitFor(() => expect(processes).toHaveLength(4));await complete(3,approved,1);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('failed'));expect(getConsensusBatch(batchId)?.failure_reason).toBe('judge_failed');
    const judge = consensusJobs(batchId).find(j=>j.role==='judge')!;await service.retry(judge.id);
    await vi.waitFor(() => expect(processes).toHaveLength(5));await complete(4,approved);
    await vi.waitFor(() => expect(getConsensusBatch(batchId)?.status).toBe('completed'));expect(consensusAttempts(judge.id)).toHaveLength(2);
    expect(consensusJobs(batchId).filter(j=>j.role==='reviewer').every(j=>consensusAttempts(j.id).length===1)).toBe(true);
    expect(db.prepare('SELECT action,batch_id FROM review_human_actions WHERE todo_id=?').all(todo.id)).toEqual([{ action: 'retry_judge',batch_id: batchId }]);
  });
  it('Stop during asynchronous spawn waits for identity persistence and signals that process safely', async () => {
    const spawn = vi.mocked(claudeManager.startClaude).getMockImplementation()!;
    let release!:()=>void;const gate = new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(claudeManager.startClaude).mockImplementation(async (...args)=>{await gate;return spawn(...args);});
    start('majority','require_all',2,1);await vi.waitFor(()=>expect(consensusJobs(batchId)[0].status).toBe('starting'));
    const stopping=service.stop(todo.id);await vi.waitFor(()=>expect(getConsensusBatch(batchId)?.status).toBe('stopping'));release();
    expect(await stopping).toBe(true);expect(processes).toHaveLength(1);expect(claudeManager.stopClaude).toHaveBeenCalledWith(50000,expect.objectContaining({pid:50000,startedAt:'test'}));
    expect(getConsensusBatch(batchId)?.status).toBe('stopped');expect(q.getTodoById(todo.id)?.status).toBe('stopped');
  });
  it('policy validates bounded reviewers, weights, quorum and judge; old single history survives migration', () => {
    const input = { name:'Invalid',members:[0,1].map(i=>({execution_profile_id:profileId,label:String(i)})) };
    expect(()=>saveReviewPolicy({...input,members:input.members.slice(0,1)})).toThrow();
    expect(()=>saveReviewPolicy({...input,strategy:'judge'})).toThrow();
    expect(()=>saveReviewPolicy({...input,failure_policy:'quorum',min_successful_reviewers:3})).toThrow();
    expect(()=>saveReviewPolicy({...input,members:input.members.map(m=>({...m,weight:11}))})).toThrow();
    expect(()=>saveReviewPolicy({...input,max_parallel_reviewers:8})).toThrow();
    const legacy = q.createTodo(todo.project_id,'Legacy review');const old = q.createExecutionRound(legacy.id,'review',1,'legacy',{status:'completed',inputPayload:'legacy'});
    q.updateExecutionRound(old.id,{result_payload:JSON.stringify(approved)});initDatabase(db);initDatabase(db);
    expect(q.getTodoById(legacy.id)?.review_mode).toBe('single');expect(q.getExecutionRoundById(old.id)?.result_payload).toBe(JSON.stringify(approved));expect(db.pragma('foreign_key_check')).toEqual([]);
  });

});
