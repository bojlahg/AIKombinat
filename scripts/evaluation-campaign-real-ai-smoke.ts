import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { acceptanceNotice, assertInside, parseOptions, selectCandidates, withCleanup, writeReport, type Candidate } from './evaluation-campaign-real-ai-support.js';

const options = parseOptions(process.argv.slice(2));
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(process.env.DB_PATH ?? path.join(checkout, fs.existsSync(path.join(checkout, 'aikombinat.db')) ? 'aikombinat.db' : 'clitrigger.db'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-campaign-real-ai-'));
const seed = path.join(root, 'seed-repo');
process.env.DB_PATH = path.join(root, 'smoke.db');
process.env.AIKOMBINAT_LOG_DIR = path.join(root, 'logs');
process.env.AIKOMBINAT_LOG_LEVEL = 'warn';
process.env.DISABLE_AUTH = 'true';
process.env.TUNNEL_ENABLED = 'false';
const startedAt = new Date().toISOString();
const report: Record<string, any> = {
  status: 'FAIL', startedAt, finishedAt: null,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8', windowsHide: true }).trim(),
  scriptSha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, root,
  cliVersions: [], baselineSha: null, campaign: null, profiles: null, candidates: [], selected: {}, analytics: null,
  humanFeedback: { autoCreated: false, coverage: 0 }, cleanup: {}, limitations: [acceptanceNotice],
};
const candidates: Candidate[] = report.candidates;
const deadline = Date.now() + options.timeout * 1000;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
function checkDeadline() { if (interrupted || Date.now() >= deadline) throw new Error('smoke_timeout'); }
function git(directory: string, args: string[]) {
  assertInside(root, directory);
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536 }).trim();
}
function seedTests(directory: string) {
  assertInside(root, directory);
  const result = spawnSync(process.execPath, ['--test'], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16384 });
  return { status: result.status === 0 ? 'PASS' : 'FAIL', exitCode: result.status, error: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null };
}
function createSeed() {
  fs.mkdirSync(path.join(seed, 'src'), { recursive: true }); fs.mkdirSync(path.join(seed, 'test'));
  fs.writeFileSync(path.join(seed, '.gitignore'), '.worktrees/\n.claude/\n');
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }) + '\n');
  fs.writeFileSync(path.join(seed, 'src', 'math.js'), 'export function clamp(value, min, max) {\n  return Math.min(min, Math.max(max, value));\n}\n');
  fs.writeFileSync(path.join(seed, 'test', 'math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/math.js';\ntest('below minimum', () => assert.equal(clamp(-2, 0, 10), 0));\ntest('inside range', () => assert.equal(clamp(5, 0, 10), 5));\ntest('above maximum', () => assert.equal(clamp(12, 0, 10), 10));\n");
  git(seed, ['init', '-b', 'main']); git(seed, ['add', '.']);
  git(seed, ['-c', 'user.name=Acceptance smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'Disposable clamp defect']);
  report.baselineSha = git(seed, ['rev-parse', 'HEAD']); report.preTest = seedTests(seed);
  assert.equal(report.preTest.status, 'FAIL'); assert.equal(report.preTest.error, null); assert.notEqual(report.preTest.exitCode, null);
}
let server: Server | undefined, base = '', projectId = '';
let db: Database.Database | undefined;
let services: any;
async function request(url: string, method = 'GET', body?: unknown, expected = 200, cleanup = false): Promise<any> {
  if (!cleanup) checkDeadline();
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(cleanup ? 30000 : Math.max(1, Math.min(30000, deadline - Date.now()))) });
  assert.equal(response.status, expected, `${method} ${url}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
function rows(sql: string, ...params: string[]): any[] { return db!.prepare(sql).all(...params); }
function parse(value: string | null) { return value ? JSON.parse(value) : null; }
function snapshot(value: string | null) {
  const data = parse(value);
  if (!data) return null;
  return Object.fromEntries(['configuration', 'profileId', 'executorCandidateId', 'agent', 'providerAccountId', 'providerAccountStrategy', 'accountPolicy',
    'cliModelId', 'model', 'effectiveModel', 'effort', 'resolvedAt'].map(key => [key, data[key] ?? null]));
}
function identity(value: string | null) {
  const data = parse(value);
  return data ? { pid: data.pid, startedAt: data.startedAt, command: data.command ?? null } : null;
}
function copySelectionState(source: Database.Database) {
  const has = (table: string) => !!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  // Only configuration metadata enters the fresh DB. No Todos, sessions, logs, credentials or process ownership are copied.
  db!.transaction(() => {
    for (const table of ['execution_profile_executors', 'execution_profiles', 'cli_models', 'cli_versions', 'provider_account_quota_state', 'provider_accounts']) db!.prepare(`DELETE FROM ${table}`).run();
    for (const table of ['cli_models', 'cli_versions', 'provider_accounts', 'provider_account_quota_state', 'execution_profiles', 'execution_profile_executors', 'review_policies', 'review_policy_members']) {
      if (!has(table)) continue;
      const columns = (db!.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);
      const values = source.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[];
      for (const value of values) {
        if (table === 'provider_accounts' && (value.auth_strategy !== 'inherited' || value.auth_config_json !== '{}')) continue;
        if (table === 'provider_account_quota_state' && !db!.prepare('SELECT 1 FROM provider_accounts WHERE id=?').get(value.provider_account_id)) continue;
        if (table === 'execution_profile_executors' && value.provider_account_id && !db!.prepare('SELECT 1 FROM provider_accounts WHERE id=?').get(value.provider_account_id)) continue;
        const keys = columns.filter(key => key in value);
        db!.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => value[key]));
      }
    }
  })();
}
async function initialize() {
  const connection = await import('../src/server/db/connection.js'); db = connection.getDatabase();
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try { copySelectionState(source); } finally { source.close(); }
  // Older stores predate account metadata; migration creates inherited-login contexts only in the disposable DB.
  const { migrateProviderAccounts } = await import('../src/server/db/provider-accounts.js'); migrateProviderAccounts(db);
  const modules = await Promise.all([
    import('../src/server/services/orchestrator.js'), import('../src/server/services/consensus-review.js'),
    import('../src/server/services/review-pipeline.js'), import('../src/server/services/executor-pool.js'),
    import('../src/server/services/resource-manager.js'), import('../src/server/services/resource-fabric.js'),
    import('../src/server/services/provider-quota.js'), import('../src/server/services/provider-account-service.js'),
    import('../src/server/db/queries.js'), import('../src/server/logging/logger.js'),
  ]);
  services = Object.assign({ connection }, ...modules);
  services.hashReviewExperimentConfig = (await import('../src/server/services/evaluation-campaign-definition.js')).hashReviewExperimentConfig;
  db.function('smoke_review_hash', (todoId: string) => services.hashReviewExperimentConfig(services.getTodoById(todoId)));
  const { orchestrator, consensusReview, resourceManager, resourceFabric, providerQuotaService, executorPool, logger } = services;
  db.exec(`CREATE TABLE smoke_processes (owner TEXT, round_id TEXT, phase TEXT, pid INTEGER, identity TEXT, snapshot TEXT, PRIMARY KEY(owner,round_id,pid));
    CREATE TABLE smoke_exits (pid INTEGER, code INTEGER, at TEXT);
    CREATE TABLE smoke_review_hashes (todo_id TEXT, round_id TEXT, hash TEXT, PRIMARY KEY(todo_id,round_id));
    CREATE TABLE smoke_implementation_tests (todo_id TEXT, round_id TEXT, result TEXT, PRIMARY KEY(todo_id,round_id));
    CREATE TRIGGER smoke_todo_process AFTER UPDATE ON todos WHEN NEW.process_pid > 0 AND NEW.process_identity IS NOT NULL BEGIN
      INSERT OR REPLACE INTO smoke_processes SELECT NEW.id,r.id,r.phase,NEW.process_pid,NEW.process_identity,NEW.execution_snapshot
      FROM todo_execution_rounds r WHERE r.todo_id=NEW.id AND r.status='running';
      INSERT OR IGNORE INTO smoke_review_hashes SELECT NEW.id,r.id,smoke_review_hash(NEW.id)
      FROM todo_execution_rounds r WHERE r.todo_id=NEW.id AND r.phase='review' AND r.status='running'; END;
    CREATE TRIGGER smoke_reviewer_process AFTER UPDATE ON consensus_review_attempts WHEN NEW.process_pid > 0 AND NEW.process_identity IS NOT NULL BEGIN
      INSERT OR REPLACE INTO smoke_processes VALUES(NEW.id,NEW.review_job_id,'consensus_review',NEW.process_pid,NEW.process_identity,NEW.execution_snapshot);
      INSERT OR IGNORE INTO smoke_review_hashes SELECT b.todo_id,b.review_round_id,smoke_review_hash(b.todo_id)
      FROM consensus_review_jobs j JOIN consensus_review_batches b ON b.id=j.batch_id WHERE j.id=NEW.review_job_id; END;`);
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  let loggedBytes = 0;
  logger.configure({ level: 'info', sinks: [{ write(record: any) {
    if (record.event === 'cli.exited') db!.prepare('INSERT INTO smoke_exits VALUES(?,?,?)').run(record.fields.pid, record.fields.exitCode, record.time.toISOString());
    if (record.event === 'review.artifact' && typeof record.fields.todoId === 'string') {
      const todo = services.getTodoById(record.fields.todoId);
      const completed = services.getExecutionRoundsByTodoId(todo.id).filter((round: any) => ['implementation', 'rework'].includes(round.phase) && round.status === 'completed').at(-1);
      if (completed && todo.worktree_path && !db!.prepare('SELECT 1 FROM smoke_implementation_tests WHERE round_id=?').get(completed.id)) {
        const result = seedTests(todo.worktree_path);
        db!.prepare('INSERT INTO smoke_implementation_tests VALUES(?,?,?)').run(todo.id, completed.id, JSON.stringify(result));
      }
    }
    if (record.event === 'todo.started' || record.event === 'review.artifact') captureReviewHashes();
    const line = JSON.stringify({ at: record.time, event: record.event, level: record.level,
      ...Object.fromEntries(['pid', 'exitCode', 'todoId', 'roundId', 'agent', 'tool', 'durationMs'].filter(key => key in record.fields).map(key => [key, record.fields[key]])) }) + '\n';
    if (loggedBytes + Buffer.byteLength(line) <= 131072) { fs.appendFileSync(path.join(root, 'logs', 'events.jsonl'), line); loggedBytes += Buffer.byteLength(line); }
  } }] });
  resourceManager.initialize(); resourceFabric.start(); providerQuotaService.initialize();
  resourceManager.setAvailabilityCallback(() => { void orchestrator.wakeWaitingResources(); consensusReview.wake(); });
  resourceFabric.setAvailabilityCallback(() => { void orchestrator.wakeWaitingResources(); consensusReview.wake(); });
  providerQuotaService.setAvailabilityCallback(() => { void orchestrator.wakeWaitingQuota(); consensusReview.wake(); });
  executorPool.setAvailabilityCallback(() => { void orchestrator.wakeWaitingExecutors(); consensusReview.wake(); });
  consensusReview.setContinuation((todoId: string, result: any) => orchestrator.completeConsensus(todoId, result));
  await consensusReview.recover();
  const app = express(); app.use(express.json());
  for (const name of ['projects', 'todos', 'execution', 'evaluation-campaigns', 'execution-profiles', 'models', 'provider-accounts']) {
    app.use('/api', (await import(`../src/server/routes/${name}.js`)).default);
  }
  server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api`;
}
function captureReviewHashes() {
  if (!services || !db) return;
  for (const round of rows("SELECT r.id,r.todo_id FROM todo_execution_rounds r WHERE r.phase='review' AND r.status='running'")) {
    db.prepare('INSERT OR IGNORE INTO smoke_review_hashes VALUES(?,?,?)').run(round.todo_id, round.id, services.hashReviewExperimentConfig(services.getTodoById(round.todo_id)));
  }
}
async function selectProfiles() {
  const { getToolStatus } = await import('../src/server/services/cli-status.js');
  const { refreshModelCatalog } = await import('../src/server/services/model-sync.js');
  report.cliVersions = (await Promise.all(['opencode', 'claude', 'codex'].map(tool => getToolStatus(tool)))).filter(Boolean).map(status => ({ tool: status!.tool, installed: status!.installed, version: status!.version, usable: status!.usable }));
  const profiles = services.getExecutionProfiles();
  const diagnostics: any[] = []; report.selectionDiagnostics = diagnostics;
  const discoveries = new Map<string, Set<string>>();
  for (const cli of report.cliVersions.filter((cli: any) => cli.installed && cli.usable !== false)) {
    checkDeadline();
    const refreshed = await refreshModelCatalog(cli.tool, { version: cli.version ?? '', explicitRefresh: true });
    diagnostics.push({ provider: cli.tool, catalog: { authoritative: refreshed.authoritative, source: refreshed.source, succeeded: refreshed.primarySucceeded } });
    if (refreshed.primarySucceeded) discoveries.set(cli.tool, new Set(refreshed.models.map(model => model.value)));
  }
  for (const account of services.listProviderAccounts().filter((account: any) => account.is_enabled && ['claude', 'codex'].includes(account.provider))) {
    checkDeadline(); await services.probeProviderAccount(account.id);
  }
  report.accounts = services.listProviderAccounts().map((account: any) => ({ id: account.id, provider: account.provider, strategy: account.auth_strategy, enabled: !!account.is_enabled, health: account.health_state }));
  const eligible: any[] = [];
  for (const original of profiles) {
    const profile = services.getExecutionProfileById(original.id);
    const enabled = profile.executors.filter((executor: any) => executor.is_enabled);
    if (!enabled.length) continue;
    let safe = true, rank = 99;
    for (const executor of enabled) {
      checkDeadline();
      const model = services.getModelById(executor.cli_model_id);
      if (!['opencode', 'claude', 'codex'].includes(executor.cli_tool) || model?.status !== 'available' || !discoveries.get(executor.cli_tool)?.has(model.model_value)) {
        diagnostics.push({ profileId: profile.id, candidateId: executor.id, status: 'unverified_catalog' }); safe = false; continue;
      }
      const evaluation = await services.executorPool.evaluateCandidate(executor, { allowedCliTools: ['opencode', 'claude', 'codex'] });
      const account = evaluation.providerAccountId ? services.getProviderAccount(evaluation.providerAccountId) : null;
      const freeLocal = executor.cli_tool === 'opencode' && /(?:-free(?:#|$)|^(?:ollama|lmstudio)\/)/i.test(model.model_value);
      const authorized = account?.auth_strategy === 'inherited' && account.health_state === 'available';
      diagnostics.push({ profileId: profile.id, candidateId: executor.id, status: evaluation.status, catalogSource: model.source, authorized: !!authorized, freeLocal });
      if (evaluation.status !== 'available' || !(freeLocal || authorized)) safe = false;
      rank = Math.min(rank, freeLocal ? 0 : /(?:cheap|low.cost|haiku|mini)/i.test(`${profile.name} ${model.model_label}`) ? 1 : 2);
    }
    if (safe) eligible.push({ profile, rank });
  }
  eligible.sort((a, b) => a.rank - b.rank || a.profile.sort_order - b.profile.sort_order || a.profile.id.localeCompare(b.profile.id));
  const choose = (id: string) => id ? eligible.find(item => item.profile.id === id)?.profile : eligible[0]?.profile;
  const implementation = choose(options.implementationProfile), reviewer = choose(options.singleReviewProfile);
  if (!implementation || !reviewer) return null;
  const { getReviewPolicy, saveReviewPolicy } = await import('../src/server/services/review-policy.js');
  const policy = options.consensusPolicy ? getReviewPolicy(options.consensusPolicy) : saveReviewPolicy({ name: 'Real AI acceptance unanimous', strategy: 'unanimous', failure_policy: 'require_all', max_parallel_reviewers: 2,
    members: [0, 1].map(priority => ({ label: `Reviewer ${priority + 1}`, execution_profile_id: reviewer.id, priority })) });
  const members = policy?.members.filter(member => member.is_enabled) ?? [];
  if (!policy?.is_enabled || policy.failure_policy !== 'require_all' || policy.max_parallel_reviewers !== 2 || members.length < 2 || members.length > 3
    || !['unanimous', 'majority'].includes(policy.strategy) || policy.strategy === 'majority' && members.length !== 3 || members.some(member => !choose(member.execution_profile_id))) return null;
  return { implementation, reviewer, policy };
}
function processes(ownerIds: string[]) {
  return rows('SELECT * FROM smoke_processes').filter(row => ownerIds.includes(row.owner)).map(row => ({ ownerId: row.owner, roundId: row.round_id, phase: row.phase,
    pid: row.pid, identity: identity(row.identity), snapshot: snapshot(row.snapshot), exits: rows('SELECT code,at FROM smoke_exits WHERE pid=?', row.pid) }));
}
async function runTodo(candidate: Candidate, kind: 'control' | 'experiment') {
  checkDeadline(); assert.equal(git(seed, ['rev-parse', 'HEAD']), report.baselineSha);
  const evidence: any = { todoId: candidate.todoId, assignmentId: candidate.assignmentId, bucket: candidate.bucket, finalStatus: null };
  report.selected[kind] = evidence;
  await request(`/todos/${candidate.todoId}/start`, 'POST', { mode: 'headless' });
  while (true) {
    checkDeadline(); captureReviewHashes();
    const todo = services.getTodoById(candidate.todoId);
    evidence.finalStatus = todo.status;
    if (['completed', 'failed', 'stopped', 'review_failed', 'review_max_rounds'].includes(todo.status)) break;
    await pause();
  }
  const todo = services.getTodoById(candidate.todoId);
  const rounds = services.getExecutionRoundsByTodoId(todo.id);
  const batches = rows('SELECT * FROM consensus_review_batches WHERE todo_id=?', todo.id);
  const jobs = batches.flatMap(batch => rows('SELECT * FROM consensus_review_jobs WHERE batch_id=?', batch.id));
  const attempts = jobs.flatMap(job => rows('SELECT * FROM consensus_review_attempts WHERE review_job_id=?', job.id));
  const observed = processes([todo.id, ...attempts.map(attempt => attempt.id)]);
  evidence.processes = observed;
  evidence.implementationTests = rows('SELECT round_id,result FROM smoke_implementation_tests WHERE todo_id=?', todo.id).map(row => ({ roundId: row.round_id, ...parse(row.result) }));
  evidence.rounds = rounds.map((round: any) => ({ id: round.id, phase: round.phase, index: round.round_index, status: round.status, startedAt: round.started_at, finishedAt: round.finished_at,
    snapshot: snapshot(round.execution_snapshot), artifact: parse(round.artifact_identity), verdict: parse(round.result_payload)?.verdict ?? null }));
  evidence.batches = batches.map(batch => ({ id: batch.id, status: batch.status, artifact: parse(batch.artifact_identity_json), evidenceHash: batch.evidence_hash, verdict: parse(batch.aggregate_result_json)?.verdict ?? null }));
  evidence.jobs = jobs.map(job => ({ id: job.id, batchId: job.batch_id, profileId: job.execution_profile_id, status: job.status }));
  evidence.attempts = attempts.map(attempt => ({ id: attempt.id, jobId: attempt.review_job_id, status: attempt.status, snapshot: snapshot(attempt.execution_snapshot),
    durationMs: attempt.duration_ms, costUsd: attempt.cost_usd, inputTokens: attempt.input_tokens, outputTokens: attempt.output_tokens }));
  evidence.assignment = await request(`/todos/${todo.id}/evaluation-assignment?projectId=${projectId}`);
  evidence.reviewStartHashes = rows('SELECT round_id,hash FROM smoke_review_hashes WHERE todo_id=?', todo.id);
  assert.equal(todo.status, 'completed', `${kind} did not complete`);
  assertInside(root, todo.worktree_path);
  evidence.tests = seedTests(todo.worktree_path);
  evidence.changedFiles = git(todo.worktree_path, ['diff', '--name-only', report.baselineSha]).split('\n').filter(Boolean);
  assert.equal(evidence.tests.status, 'PASS');
  assert.equal(git(todo.worktree_path, ['diff', report.baselineSha, '--', 'test', 'package.json']), '', 'Tests or test command changed');
  assert.equal(fs.readFileSync(path.join(todo.worktree_path, 'test', 'math.test.js'), 'utf8').replace(/\r\n/g, '\n'), fs.readFileSync(path.join(seed, 'test', 'math.test.js'), 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(evidence.changedFiles.includes('src/math.js'), 'Source implementation unchanged');
  evidence.baseline = parse(todo.review_baseline);
  assert.equal(evidence.baseline?.baseCommit, report.baselineSha);
  assert.equal(evidence.baseline?.startingHead, report.baselineSha);
  assert.equal(evidence.assignment.integrity_state, 'clean');
  const reviews = rounds.filter((round: any) => round.phase === 'review');
  assert.ok(reviews.length >= 1 && reviews.length <= 2);
  const { parseReviewResult } = await import('../src/server/services/review-result-parser.js');
  for (const review of reviews) {
    assert.equal(review.status, 'completed');
    assert.ok(parseReviewResult(review.result_payload ?? '').ok, 'Invalid durable ReviewResult');
    assert.ok(evidence.reviewStartHashes.some((hash: any) => hash.round_id === review.id && hash.hash === evidence.assignment.assigned_review_config_hash));
  }
  const implementation = observed.filter(process => process.phase === 'implementation');
  assert.ok(implementation.length >= 1, 'No persisted real implementation process');
  for (const round of rounds.filter((round: any) => ['implementation', 'rework'].includes(round.phase) && round.status === 'completed')) {
    assert.ok(evidence.implementationTests.some((test: any) => test.roundId === round.id && test.status === 'PASS'), 'Implementation tests did not pass before review');
  }
  for (const process of observed) {
    assert.ok(process.pid > 0 && process.identity?.pid === process.pid && process.identity?.startedAt && process.snapshot?.agent && process.snapshot?.effectiveModel);
    assert.ok(process.exits.length > 0, 'Actual process exit missing');
  }
  if (kind === 'control') {
    assert.equal(todo.review_mode, 'single'); assert.equal(batches.length, 0);
    assert.equal(observed.filter(process => process.phase === 'review').length, reviews.length);
  } else {
    assert.equal(todo.review_mode, 'consensus'); assert.equal(batches.length, reviews.length);
    for (const batch of batches) {
      assert.equal(batch.status, 'completed');
      const reviewerJobs = jobs.filter(job => job.batch_id === batch.id && job.role === 'reviewer');
      assert.ok(reviewerJobs.length >= 2);
      assert.ok(reviewerJobs.every(job => attempts.some(attempt => attempt.review_job_id === job.id && attempt.status === 'completed' && observed.some(process => process.ownerId === attempt.id))), 'Missing real reviewer attempt');
      const reviewerProcesses = observed.filter(process => attempts.some(attempt => attempt.id === process.ownerId && reviewerJobs.some(job => job.id === attempt.review_job_id)));
      assert.ok(new Set(reviewerProcesses.map(process => JSON.stringify(process.identity))).size >= 2, 'Reviewers lack independent process identities');
    }
  }
  const lastReview = reviews.at(-1);
  const artifact = await services.reviewPipeline.collectReviewArtifact(todo, services.getProjectById(projectId));
  evidence.artifactUnchanged = JSON.stringify(artifact.identity) === lastReview.artifact_identity;
  assert.ok(evidence.artifactUnchanged);
  if (kind === 'experiment') assert.equal(JSON.stringify(artifact.identity), batches.at(-1).artifact_identity_json);
  assert.equal(todo.process_pid, 0);
  assert.ok(attempts.every(attempt => attempt.process_pid === 0 && !['starting', 'running', 'recovery_required'].includes(attempt.status)));
  assert.equal(git(seed, ['rev-parse', 'HEAD']), report.baselineSha);
}
async function cleanup() {
  writeReport(root, report);
  const errors: string[] = [];
  if (services) {
    for (const candidate of candidates) {
      const todo = services.getTodoById(candidate.todoId);
      if (['completed', 'merged'].includes(todo.status) && !todo.process_pid) continue;
      if (candidate.integrity === 'excluded' && !todo.process_pid && todo.status === 'pending') continue;
      try { await request(`/todos/${candidate.todoId}/stop`, 'POST', {}, 200, true); }
      catch { errors.push(`stop_failed:${candidate.todoId}`); }
    }
    await services.consensusReview.shutdown();
    services.orchestrator.stopStaleProcessChecker();
    services.resourceManager.shutdown(); services.resourceFabric.shutdown(); services.providerQuotaService.shutdown();
    const owners = rows('SELECT id,process_pid,process_identity FROM todos WHERE process_pid>0');
    const attempts = rows("SELECT id,process_pid,process_identity FROM consensus_review_attempts WHERE process_pid>0 OR status IN ('starting','running','recovery_required')");
    report.cleanup = { todoPids: owners.map(row => ({ id: row.id, pid: row.process_pid })), reviewerAttempts: attempts.map(row => ({ id: row.id, pid: row.process_pid })),
      leases: rows('SELECT owner_id,resource_key FROM resource_leases'), reservations: services.executorPool.getReservations().map((reservation: any) => ({ ownerId: reservation.ownerId, tool: reservation.tool })), errors };
    const { verifyProcessIdentity, parseProcessIdentity, isProcessAlive } = await import('../src/server/utils/process-tree.js');
    report.cleanup.observedProcesses = [];
    for (const process of rows('SELECT * FROM smoke_processes')) {
      const stored = parseProcessIdentity(process.identity);
      const alive = isProcessAlive(process.pid);
      const verdict = alive && stored ? await verifyProcessIdentity(process.pid, stored) : 'dead';
      report.cleanup.observedProcesses.push({ pid: process.pid, verdict });
      if (alive && verdict !== 'mismatch') errors.push(`unresolved_owned_process:${process.pid}`);
    }
    report.cleanup.safe = !owners.length && !attempts.length && !report.cleanup.leases.length && !report.cleanup.reservations.length && !errors.length;
    if (!report.cleanup.safe) { if (report.status !== 'TIMEOUT') report.status = 'FAIL'; report.limitations.push('Cleanup unresolved; disposable data retained for recovery.'); }
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (report.cleanup.safe && !options.keep) {
      for (const candidate of candidates) {
        const todo = services.getTodoById(candidate.todoId);
        if (todo?.worktree_path && fs.existsSync(todo.worktree_path)) {
          assertInside(root, todo.worktree_path); git(seed, ['worktree', 'remove', '--force', todo.worktree_path]);
        }
      }
    }
    services.logger.flush(); services.logger.close(); services.connection.closeDatabase();
  } else {
    db?.close(); report.cleanup = { safe: true, processesLaunched: false, errors };
  }
  report.finishedAt = new Date().toISOString();
  report.cleanup.retained = options.keep || !report.cleanup.safe;
  writeReport(root, report);
  if (!report.cleanup.retained) {
    for (const target of [seed, path.join(root, 'smoke.db'), path.join(root, 'smoke.db-wal'), path.join(root, 'smoke.db-shm')]) {
      if (fs.existsSync(target)) { assertInside(root, target); fs.rmSync(target, { recursive: true, force: true }); }
    }
  }
}

await withCleanup(async () => {
  try {
    if (process.env.CI || process.env.VITEST || !fs.existsSync(sourcePath)) {
      report.status = 'SKIPPED_ENVIRONMENT'; report.limitations.push('Manual provider execution requires existing local configuration outside CI.'); return;
    }
    createSeed(); await initialize();
    const profiles = await selectProfiles();
    if (!profiles) { report.status = 'SKIPPED_ENVIRONMENT'; report.limitations.push('No existing execution profile has verified current catalog and safe authorized inherited/free-local candidates.'); return; }
    const { implementation, reviewer, policy } = profiles;
    report.profiles = { implementation: { id: implementation.id, candidates: implementation.executors.map((executor: any) => ({ id: executor.id, provider: executor.cli_tool, model: executor.model_value, effort: executor.effort_value })) }, singleReviewer: reviewer.id,
      consensusPolicy: policy.id, consensusReviewers: policy.members.filter(member => member.is_enabled).map(member => ({ memberId: member.id, profileId: member.execution_profile_id })) };
    const project = await request('/projects', 'POST', { name: 'Real AI Campaign Acceptance', path: seed, default_branch: 'main' }, 201); projectId = project.id;
    await request(`/projects/${projectId}`, 'PUT', { sandbox_mode: 'strict', npm_auto_install: 0, use_worktree: 1, max_concurrent: 1, debug_logging: 0, auto_delegate: 0 });
    const campaign = await request(`/projects/${projectId}/evaluation-campaigns`, 'POST', { name: 'Real AI Review Acceptance', auto_enroll: 0, arms: [
      { name: 'Control', is_control: 1, weight: 1, sort_order: 0, review_mode: 'single', review_profile_id: reviewer.id, rework_profile_id: implementation.id, max_review_rounds: 2 },
      { name: 'Experiment', is_control: 0, weight: 1, sort_order: 1, review_mode: 'consensus', review_policy_id: policy.id, rework_profile_id: implementation.id, max_review_rounds: 2 },
    ] }, 201);
    report.campaign = await request(`/evaluation-campaigns/${campaign.id}/start`, 'POST', { projectId });
    const selected = await selectCandidates(async () => {
      const todo = await request(`/projects/${projectId}/todos`, 'POST', { title: 'Fix the bug in clamp so all existing tests pass.', description: 'Do not modify the tests.\nKeep the implementation minimal.\nRun the existing test suite.',
        execution_profile_id: implementation.id, resource_requirements: [], priority: 0, use_worktree: 1, max_review_rounds: 2, memory_inject_mode: 'none',
        evaluation_campaign_id: campaign.id, evaluation_campaign_enroll: true }, 201);
      const assignment = await request(`/todos/${todo.id}/evaluation-assignment?projectId=${projectId}`);
      return { todoId: todo.id, assignmentId: assignment.id, armId: assignment.arm_id, control: !!assignment.arm_snapshot.is_control, bucket: assignment.assignment_bucket, integrity: assignment.integrity_state };
    }, async candidate => {
      const assignment = await request(`/todos/${candidate.todoId}/evaluation-assignment/withdraw`, 'POST', { projectId });
      assert.equal(assignment.integrity_state, 'excluded'); assert.equal(assignment.first_execution_at, null); candidate.integrity = assignment.integrity_state;
    }, candidates);
    report.excludedExtras = selected.extras.map(candidate => candidate.todoId); report.executionOrder = [selected.control.todoId, selected.experiment.todoId];
    const control = services.getTodoById(selected.control.todoId), experiment = services.getTodoById(selected.experiment.todoId);
    for (const field of ['title', 'description', 'execution_profile_id', 'resource_requirements', 'priority', 'use_worktree', 'cli_tool', 'cli_model', 'cli_effort']) assert.equal(control[field], experiment[field]);
    assert.equal(control.use_worktree, 1); assert.equal(control.execution_profile_id, implementation.id);
    await runTodo(selected.control, 'control'); await runTodo(selected.experiment, 'experiment');
    const analytics = await request(`/evaluation-campaigns/${campaign.id}/analytics?projectId=${projectId}`);
    report.analytics = { arms: analytics.arms, assignments: (await request(`/evaluation-campaigns/${campaign.id}/assignments?projectId=${projectId}`)).assignments };
    for (const arm of analytics.arms) {
      for (const protocol of ['itt', 'pp']) {
        assert.equal(arm[protocol].assignments, 1); assert.equal(arm[protocol].started, 1); assert.equal(arm[protocol].reachedReview, 1); assert.equal(arm[protocol].terminal, 1);
        assert.equal(arm[protocol].feedback.responses, 0); assert.equal(arm[protocol].feedback.responseCoverage, 0);
      }
    }
    assert.equal(rows('SELECT * FROM evaluation_campaign_assignment_feedback').length, 0);
    assert.equal(rows('SELECT * FROM review_evaluation_feedback').length, 0);
    report.status = 'PASS'; writeReport(root, report);
    if (options.serve) {
      process.stdout.write(`Disposable controller: ${base}\nReport: ${path.join(root, 'report.json')}\nInterrupt to close.\n`);
      while (!interrupted) await pause();
    }
  } catch (error) {
    report.status = interrupted || Date.now() >= deadline || (error instanceof Error && error.message === 'smoke_timeout') ? 'TIMEOUT' : 'FAIL';
    report.failure = error instanceof assert.AssertionError ? `acceptance_assertion:${error.operator}` : error instanceof Error && ['assignment_distribution_unlucky', 'smoke_timeout'].includes(error.message) ? error.message : error instanceof Error ? error.name : 'Unknown failure';
  }
}, cleanup).catch(() => { report.status = 'FAIL'; report.cleanup.error = 'Cleanup failed; disposable data retained'; writeReport(root, report); });
process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
process.stdout.write('Campaign Real-AI Smoke\n');
for (const [label, key] of [['Control', 'control'], ['Experiment', 'experiment']]) {
  const selected = report.selected[key];
  process.stdout.write(`${label}:\n  assignment: ${selected?.assignmentId ?? 'none'}\n  implementation: ${selected?.processes?.find((process: any) => process.phase === 'implementation')?.pid ?? 'not executed'}\n  tests: ${selected?.tests?.status ?? 'not reached'}\n  review: ${selected?.rounds?.filter((round: any) => round.phase === 'review').map((round: any) => round.verdict).join(', ') || 'not reached'}\n`);
  if (key === 'experiment') process.stdout.write(`  reviewers: ${selected?.attempts?.length ?? 0}\n  consensus: ${selected?.batches?.map((batch: any) => batch.status).join(', ') || 'not reached'}\n`);
}
process.stdout.write(`Analytics: ITT/PP ${report.analytics ? 'verified' : 'not reached'}\nCleanup: ${report.cleanup.safe ? 'verified' : 'unresolved'}\nResult: ${report.status}\nReport: ${path.join(root, 'report.json')}\n${acceptanceNotice}\n`);
process.exitCode = ['PASS', 'SKIPPED_ENVIRONMENT'].includes(report.status) ? 0 : 1;
