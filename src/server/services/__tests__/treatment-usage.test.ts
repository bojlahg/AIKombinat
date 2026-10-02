import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { initDatabase } from '../../db/schema.js';

let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
const q = await import('../../db/queries.js');
const { getTodoTreatmentUsage, persistExecutionRoundUsage } = await import('../treatment-usage.js');
const { ConsensusOutputCollector } = await import('../consensus-output.js');
const { LogStreamer } = await import('../log-streamer.js');
let todoId: string, profileId: string;
const now = '2026-10-02T00:00:00.000Z';
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initDatabase(db);
  todoId = q.createTodo(q.createProject('Usage', '/tmp/usage').id, 'Usage').id;
  profileId = q.createExecutionProfile({ name: 'Reviewer', slug: 'reviewer', description: '', executors: [] }).id;
  db.prepare(`INSERT INTO review_policies (id,name,strategy,failure_policy,min_successful_reviewers,diversity_policy,max_parallel_reviewers,created_at,updated_at)
    VALUES ('policy','Policy','majority','quorum',2,'none',2,?,?)`).run(now, now);
});
afterEach(() => db.close());
function round(phase: q.RoundPhase, cost: number | null, options: { started?: boolean; status?: q.RoundStatus; retry?: string } = {}) {
  const r = q.createExecutionRound(todoId, phase, q.getNextExecutionRoundIndex(todoId), randomUUID(), {
    status: options.status ?? 'completed', startedAt: options.started === false ? null : now, retryOfRoundId: options.retry,
  });
  persistExecutionRoundUsage(r.id, { cost_usd: cost }); return r;
}
function consensus() {
  const r = round('review', null);
  const batch = randomUUID();
  db.prepare(`INSERT INTO consensus_review_batches (id,todo_id,review_round_id,review_policy_id,strategy,failure_policy,min_successful_reviewers,diversity_policy,max_parallel_reviewers,status,artifact_identity_json,evidence_hash,created_at,updated_at)
    VALUES (?,?,?,'policy','majority','quorum',2,'none',2,'completed','{}','hash',?,?)`).run(batch, todoId, r.id, now, now);
  return (role: 'reviewer' | 'judge', costs: (number | null)[], started = true) => {
    const job = randomUUID();
    db.prepare(`INSERT INTO consensus_review_jobs (id,batch_id,role,execution_profile_id,label,weight,priority,status,created_at,updated_at)
      VALUES (?,?,?,?,'Reviewer',1,0,'completed',?,?)`).run(job, batch, role, profileId, now, now);
    let previous: string | null = null;
    costs.forEach((cost, i) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO consensus_review_attempts (id,review_job_id,attempt_index,status,run_token,retry_of_attempt_id,cost_usd,started_at,created_at,updated_at)
        VALUES (?,?,?, ?,?,?,?,?,?,?)`).run(id, job, i + 1, i < costs.length - 1 ? 'failed' : 'completed', randomUUID(), previous, cost, started ? now : null, now, now);
      previous = id;
    });
    return previous!;
  };
}
describe('whole treatment accounting', () => {
  it('separates wall and provider duration with partial coverage and no waiting denominator', () => {
    const implementation = round('implementation', null);
    const review = round('review', null);
    const rework = round('rework', null, { status: 'stopped' });
    const failed = round('implementation', null, { status: 'failed' });
    round('implementation', null, { started: false, status: 'waiting_executor' });
    for (const r of [implementation, review, rework, failed]) q.updateExecutionRound(r.id, { finished_at: '2026-10-02T00:00:00.150Z' });
    persistExecutionRoundUsage(implementation.id, { provider_duration_ms: 120 });
    persistExecutionRoundUsage(review.id, { provider_duration_ms: 0 });
    const usage = getTodoTreatmentUsage(todoId);
    expect(usage.attemptWallDuration).toEqual({ known: 600, attemptsKnown: 4, attemptsTotal: 4, coverage: 1 });
    expect(usage.providerDuration).toEqual({ known: 120, attemptsKnown: 2, attemptsTotal: 4, coverage: .5 });
    expect(usage.phases.singleReview.providerDuration.known).toBe(0);
    expect(usage.phases.rework.attemptWallDuration.known).toBe(150);
    expect(q.getExecutionRoundById(failed.id)?.provider_duration_ms).toBeNull();
  });
  it('backfills each historical duration only to its proven metric and preserves explicit values', () => {
    const ordinary = round('implementation', null);
    const attempt = consensus()('reviewer', [null]);
    db.prepare('UPDATE todo_execution_rounds SET duration_ms=123 WHERE id=?').run(ordinary.id);
    db.prepare('UPDATE consensus_review_attempts SET duration_ms=456 WHERE id=?').run(attempt);
    for (const table of ['todo_execution_rounds', 'consensus_review_attempts']) {
      for (const column of ['provider_duration_ms', 'attempt_wall_duration_ms']) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    initDatabase(db); initDatabase(db);
    expect(q.getExecutionRoundById(ordinary.id)).toMatchObject({ provider_duration_ms: 123, attempt_wall_duration_ms: null });
    expect(db.prepare('SELECT * FROM consensus_review_attempts WHERE id=?').get(attempt)).toMatchObject({ provider_duration_ms: null, attempt_wall_duration_ms: 456 });
    db.prepare('UPDATE todo_execution_rounds SET provider_duration_ms=0,attempt_wall_duration_ms=150 WHERE id=?').run(ordinary.id);
    db.prepare('UPDATE consensus_review_attempts SET provider_duration_ms=350,attempt_wall_duration_ms=500 WHERE id=?').run(attempt);
    initDatabase(db); initDatabase(db);
    expect(q.getExecutionRoundById(ordinary.id)).toMatchObject({ provider_duration_ms: 0, attempt_wall_duration_ms: 150 });
    expect(db.prepare('SELECT * FROM consensus_review_attempts WHERE id=?').get(attempt)).toMatchObject({ provider_duration_ms: 350, attempt_wall_duration_ms: 500 });
    expect(getTodoTreatmentUsage(todoId).providerDuration.known).toBe(350);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('ignores invalid duration telemetry and invalid local timestamps', () => {
    const r = round('implementation', null);
    for (const value of [-1, NaN, Infinity]) persistExecutionRoundUsage(r.id, { provider_duration_ms: value, attempt_wall_duration_ms: value });
    q.updateExecutionRound(r.id, { finished_at: 'invalid' });
    expect(q.getExecutionRoundById(r.id)).toMatchObject({ provider_duration_ms: null, attempt_wall_duration_ms: null });
    q.updateExecutionRound(r.id, { finished_at: '2026-10-01T00:00:00Z' });
    expect(q.getExecutionRoundById(r.id)?.attempt_wall_duration_ms).toBeNull();
  });
  it('keeps overlapping streams isolated by run token and retains duration-only telemetry', async () => {
    const streamer = new LogStreamer();
    const first = new PassThrough(), second = new PassThrough(), err1 = new PassThrough(), err2 = new PassThrough();
    const drains = [streamer.streamJsonToDb(todoId, first, err1, false, 'old'), streamer.streamJsonToDb(todoId, second, err2, false, 'new')];
    second.end('{"type":"result","total_cost_usd":0.03}'); err2.end();
    first.end('{"type":"result","duration_ms":123}'); err1.end();
    await Promise.all(drains);
    expect(streamer.getTokenUsage(todoId, 'old')).toMatchObject({ duration_ms: 123, total_cost: null });
    expect(streamer.getTokenUsage(todoId, 'old')).toBeNull();
    expect(streamer.getTokenUsage(todoId, 'new')).toMatchObject({ total_cost: .03, duration_ms: null });
  });
  it('reproduces the exact observed retry: $0.1526221 and 4/4 cost coverage', () => {
    const failed = round('implementation', .0426689, { status: 'failed' });
    round('implementation', .0356593, { retry: failed.id });
    q.updateTodo(todoId, { total_cost_usd: .0356593 });
    const attempt = consensus(); attempt('reviewer', [.0566660]); attempt('reviewer', [.0176279]);
    const usage = getTodoTreatmentUsage(todoId);
    expect(usage.processAttempts).toEqual({ total: 4, ordinary: 2, consensusReviewer: 2, judge: 0 });
    expect(usage.cost.known).toBeCloseTo(.1526221, 10);
    expect(usage.cost.known).not.toBeCloseTo(.0356593, 10);
    expect(usage.cost).toMatchObject({ attemptsKnown: 4, attemptsTotal: 4, coverage: 1 });
    expect(usage.phases.implementation.cost.known).toBeCloseTo(.0783282, 10);
    expect(usage.phases.consensusReviewer.cost.known).toBeCloseTo(.0742939, 10);
  });
  it('includes implementation and Single Review and every rework/review round', () => {
    round('implementation', .04); round('review', .02);
    expect(getTodoTreatmentUsage(todoId).cost).toEqual({ known: .06, attemptsKnown: 2, attemptsTotal: 2, coverage: 1 });
    round('rework', .03); round('review', .01);
    const usage = getTodoTreatmentUsage(todoId);
    expect(usage.processAttempts.ordinary).toBe(4); expect(usage.cost.known).toBeCloseTo(.10);
    expect(usage.phases.singleReview.processAttempts.total).toBe(2);
  });
  it('includes failed Consensus retries and judges, excluding waiting attempts', () => {
    const attempt = consensus(); attempt('reviewer', [.01, .02]); attempt('reviewer', [null], false); attempt('judge', [.03]);
    const usage = getTodoTreatmentUsage(todoId);
    expect(usage.processAttempts).toEqual({ total: 3, ordinary: 0, consensusReviewer: 2, judge: 1 });
    expect(usage.cost.known).toBeCloseTo(.06); expect(usage.cost.coverage).toBe(1);
  });
  it('counts quota failover independently with idempotent final fields', () => {
    const failed = round('implementation', .01, { status: 'failed' });
    q.updateExecutionRound(failed.id, { error_message: 'account_quota_failover' });
    const retry = round('implementation', .03, { retry: failed.id });
    persistExecutionRoundUsage(retry.id, { cost_usd: .03 }); persistExecutionRoundUsage(retry.id, { cost_usd: null });
    expect(q.getExecutionRoundById(failed.id)?.cost_usd).toBe(.01);
    expect(getTodoTreatmentUsage(todoId).cost).toEqual({ known: .04, attemptsKnown: 2, attemptsTotal: 2, coverage: 1 });
  });
  it('keeps partial cost, I/O, cache and duration coverage separate', () => {
    const a = round('implementation', .01); round('review', null); const b = round('rework', .03);
    persistExecutionRoundUsage(a.id, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300, duration_ms: 100 });
    persistExecutionRoundUsage(b.id, { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 0, duration_ms: 200 });
    const usage = getTodoTreatmentUsage(todoId);
    expect(usage.cost).toEqual({ known: .04, attemptsKnown: 2, attemptsTotal: 3, coverage: 2 / 3 });
    expect(usage.ioTokens).toEqual({ known: 45, attemptsKnown: 2, attemptsTotal: 3, coverage: 2 / 3 });
    expect(usage.cacheReadTokens).toEqual({ known: 300, attemptsKnown: 2, attemptsTotal: 3, coverage: 2 / 3 });
    expect(usage.cacheCreationTokens.coverage).toBe(1 / 3); expect(usage.providerDuration.known).toBe(300);
  });
  it('distinguishes known zero, unknown, incomplete I/O and zero started attempts', () => {
    round('implementation', 0, { started: false });
    expect(getTodoTreatmentUsage(todoId).cost).toEqual({ known: null, attemptsKnown: 0, attemptsTotal: 0, coverage: null });
    const a = round('implementation', 0); const b = round('review', null);
    persistExecutionRoundUsage(a.id, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
    persistExecutionRoundUsage(b.id, { input_tokens: 4 });
    const usage = getTodoTreatmentUsage(todoId);
    expect(usage.cost).toEqual({ known: 0, attemptsKnown: 1, attemptsTotal: 2, coverage: .5 });
    expect(usage.ioTokens).toEqual({ known: 0, attemptsKnown: 1, attemptsTotal: 2, coverage: .5 });
    expect(usage.cacheCreationTokens.known).toBeNull();
  });
  it('rejects negative and non-finite telemetry and never fabricates historical usage', () => {
    const r = round('implementation', null);
    persistExecutionRoundUsage(r.id, { cost_usd: Infinity, input_tokens: -1, output_tokens: NaN, duration_ms: -100 });
    q.updateTodo(todoId, { total_cost_usd: 999, total_tokens: 999 });
    initDatabase(db); initDatabase(db);
    expect(q.getExecutionRoundById(r.id)).toMatchObject({ cost_usd: null, input_tokens: null, output_tokens: null, duration_ms: null });
    expect(getTodoTreatmentUsage(todoId).cost.coverage).toBe(0); expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('adds nullable columns idempotently to a legacy DB without backfill', () => {
    const r = round('implementation', null);
    for (const column of ['duration_ms', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cost_usd']) db.exec(`ALTER TABLE todo_execution_rounds DROP COLUMN ${column}`);
    for (const column of ['cache_read_input_tokens', 'cache_creation_input_tokens']) db.exec(`ALTER TABLE consensus_review_attempts DROP COLUMN ${column}`);
    initDatabase(db); initDatabase(db);
    expect(q.getExecutionRoundById(r.id)?.cost_usd).toBeNull();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('captures Consensus cache telemetry from an unterminated result line and keeps omitted fields null', () => {
    const collector = new ConsensusOutputCollector(true);
    collector.push(JSON.stringify({ type: 'result', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }, total_cost_usd: 0 }));
    collector.finish();
    expect(collector.usage).toEqual({ provider_duration_ms: null, input_tokens: 2, output_tokens: 3, cost_usd: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 });
    const empty = new ConsensusOutputCollector(true); empty.push('{"type":"result","usage":{"input_tokens":-2}}'); empty.finish();
    expect(Object.values(empty.usage).every(v => v === null)).toBe(true);
  });
});
