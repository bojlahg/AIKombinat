import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const base = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: npx tsx scripts/smoke-opencode.ts <disposable-output-directory>');
if (fs.existsSync(base)) throw new Error('Smoke output directory must not already exist');
fs.mkdirSync(base, { recursive: true });
process.env.DB_PATH = path.join(base, 'smoke.db');
process.env.AIKOMBINAT_LOG_DIR = path.join(base, 'logs');
const queries = await import('../src/server/db/queries.js');
const { getDatabase, closeDatabase } = await import('../src/server/db/connection.js');
const { refreshModelCatalog } = await import('../src/server/services/model-sync.js');
const { getToolStatus } = await import('../src/server/services/cli-status.js');
const { orchestrator } = await import('../src/server/services/orchestrator.js');
const { claudeManager } = await import('../src/server/services/claude-manager.js');

const report: Record<string, unknown> = { os: process.platform, node: process.version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (cwd: string) => createHash('sha256').update(fs.readFileSync(path.join(cwd, 'add.cjs')))
  .update(fs.readFileSync(path.join(cwd, 'add.test.cjs'))).digest('hex');
async function waitForTodo(id: string, timeout = 240_000) {
  const started = Date.now();
  let pid = 0;
  let reviewHash: string | undefined;
  while (Date.now() - started < timeout) {
    const todo = queries.getTodoById(id)!;
    if (todo.process_pid && !pid) pid = todo.process_pid;
    if (todo.pipeline_phase === 'review' && todo.worktree_path && !reviewHash) reviewHash = hash(todo.worktree_path);
    if (['completed', 'failed', 'stopped', 'pending_review'].includes(todo.status) && !todo.process_pid) {
      return { status: todo.status, pid, finalPid: todo.process_pid, latencyMs: Date.now() - started,
        worktree: todo.worktree_path, snapshot: JSON.parse(todo.execution_snapshot ?? '{}'),
        rounds: queries.getExecutionRoundsByTodoId(id).map((round) => ({ phase: round.phase, status: round.status })),
        reviewFilesUnchanged: reviewHash && todo.worktree_path ? reviewHash === hash(todo.worktree_path) : null,
        diagnostics: queries.getTaskLogsByTodoId(id).filter((log) => log.log_type === 'error').map((log) => log.message.slice(-500)) };
    }
    await sleep(100);
  }
  await orchestrator.stopTodo(id);
  throw new Error(`Smoke Todo timed out: ${id}`);
}

try {
  report.cli = await getToolStatus('opencode');
  const discovery = await refreshModelCatalog('opencode', { explicitRefresh: true });
  const catalog = queries.getModelsByTool('opencode');
  report.discovery = { success: discovery.primarySucceeded, count: catalog.length, authoritative: discovery.authoritative,
    diagnostics: discovery.diagnostics };
  const muse = catalog.find((model) => /muse-spark-1\.3-contributor-free$/.test(model.model_value));
  report.muse = muse?.model_value ?? 'unavailable';
  const selected = muse ?? catalog.find((model) => /free$/.test(model.model_value));
  if (!selected) throw new Error('No discovered free model available; no paid model was substituted');
  const profile = queries.createExecutionProfile({ name: 'OpenCode Free Smoke', slug: 'opencode-free-smoke', description: '',
    executors: [{ cli_model_id: selected.id, effort_value: null, priority: 0 }] });
  report.profile = { id: profile.id, name: profile.name, model: selected.model_value };
  const fixture = path.join(base, 'fixture'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: { test: 'node --test add.test.cjs' } }));
  fs.writeFileSync(path.join(fixture, '.gitignore'), '.worktrees/\n');
  fs.writeFileSync(path.join(fixture, 'add.cjs'), 'exports.add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(fixture, 'add.test.cjs'), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('./add.cjs');\ntest('zero', () => assert.equal(add(0, 0), 0));\n");
  git(fixture, ['init', '-b', 'main']); git(fixture, ['config', 'user.name', 'AIKombinat Smoke']);
  git(fixture, ['config', 'user.email', 'smoke@example.invalid']); git(fixture, ['add', '.']); git(fixture, ['commit', '-m', 'Smoke baseline']);
  const project = queries.createProject('OpenCode Smoke', fixture);
  queries.updateProject(project.id, { use_worktree: 1, npm_auto_install: 0, memory_auto_ingest: 0, default_review_profile_id: profile.id });
  const todo = queries.createTodo(project.id, 'Fix addition and test it',
    'Fix add.cjs to add its two inputs. Add a regression test for add(2, 3) === 5 in add.test.cjs. Run node --test add.test.cjs. Commit the change locally. Do not push.',
    0, undefined, undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, profile.id,
    null, null, null, 1, profile.id, profile.id, 1);
  await orchestrator.startTodo(todo.id);
  const implementation = await waitForTodo(todo.id);
  report.implementationAndReview = implementation;
  if (implementation.worktree) {
    report.filesChanged = git(implementation.worktree, ['diff', '--name-only', 'main', 'HEAD']).split('\n').filter(Boolean);
    try { report.fixtureTests = execFileSync(process.execPath, ['--test', 'add.test.cjs'], { cwd: implementation.worktree, encoding: 'utf8' }).includes('# fail 0'); }
    catch { report.fixtureTests = false; }
  }
  const invalid = queries.addModel('opencode', 'aikombinat-invalid/model-missing', 'Invalid smoke', []);
  const invalidProfile = queries.createExecutionProfile({ name: 'Invalid smoke', slug: 'invalid-smoke', description: '',
    executors: [{ cli_model_id: invalid.id, effort_value: null, priority: 0 }] });
  const failureTodo = queries.createTodo(project.id, 'Invalid model smoke', 'Reply OK', 0, undefined, undefined,
    undefined, undefined, undefined, 1, 'none', null, null, undefined, invalidProfile.id);
  await orchestrator.startTodo(failureTodo.id); report.invalidModel = await waitForTodo(failureTodo.id, 60_000);
  const stopTodo = queries.createTodo(project.id, 'Stop smoke', 'Read the fixture and propose ten detailed improvements. Do not modify files.',
    0, undefined, undefined, undefined, undefined, undefined, 1, 'none', null, null, undefined, profile.id);
  await orchestrator.startTodo(stopTodo.id);
  const stopPid = queries.getTodoById(stopTodo.id)?.process_pid;
  await sleep(1000);
  await orchestrator.stopTodo(stopTodo.id);
  report.stop = { pid: stopPid, status: queries.getTodoById(stopTodo.id)?.status,
    finalPid: queries.getTodoById(stopTodo.id)?.process_pid, stillRunning: stopPid ? claudeManager.isRunning(stopPid) : null };
  const before = catalog.map((model) => [model.id, model.status]);
  await refreshModelCatalog('opencode', { discover: async () => ({ models: [], source: 'opencode-models', authoritative: false, primarySucceeded: false }) });
  report.failedRefreshPreservedCatalog = before.every(([id, state]) => queries.getModelById(id)?.status === state);
  report.foreignKeys = getDatabase().pragma('foreign_key_check');
  const invalidResult = report.invalidModel as Awaited<ReturnType<typeof waitForTodo>>;
  const stopResult = report.stop as { status: string; finalPid: number; stillRunning: boolean };
  if (!discovery.primarySucceeded || implementation.status !== 'completed' || !implementation.reviewFilesUnchanged
    || report.fixtureTests !== true || invalidResult.status !== 'failed' || invalidResult.finalPid !== 0
    || stopResult.status !== 'stopped' || stopResult.finalPid !== 0 || stopResult.stillRunning !== false
    || report.failedRefreshPreservedCatalog !== true || (report.foreignKeys as unknown[]).length !== 0) {
    throw new Error('One or more smoke assertions failed; inspect report.json');
  }
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  await claudeManager.killAll();
  closeDatabase();
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
process.exit(report.error ? 1 : 0);
