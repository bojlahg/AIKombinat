import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const base = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || fs.existsSync(base)) throw new Error('Provide a new disposable smoke directory');
fs.mkdirSync(base, { recursive: true });
process.env.DB_PATH = path.join(base, 'smoke.db');
process.env.AIKOMBINAT_LOG_DIR = path.join(base, 'logs');
const queries = await import('../src/server/db/queries.js');
const { getDatabase, closeDatabase } = await import('../src/server/db/connection.js');
const { refreshModelCatalog } = await import('../src/server/services/model-sync.js');
const { getToolStatus } = await import('../src/server/services/cli-status.js');
const { orchestrator: todoOrchestrator } = await import('../src/server/services/orchestrator.js');
const { orchestratorAgent } = await import('../src/server/orchestration/service.js');
const store = await import('../src/server/orchestration/store.js');
const { resourceManager } = await import('../src/server/services/resource-manager.js');
const { resourceFabric, getComputeNodes } = await import('../src/server/services/resource-fabric.js');
const { executorPool } = await import('../src/server/services/executor-pool.js');
const { providerQuotaService } = await import('../src/server/services/provider-quota.js');
const { broadcaster } = await import('../src/server/websocket/broadcaster.js');
const report: Record<string, unknown> = { environment: { node: process.version, platform: process.platform, baseline: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim() }, timeline: [] };
const timeline = report.timeline as Record<string, unknown>[];
const originalBroadcast = broadcaster.broadcast.bind(broadcaster);
broadcaster.broadcast = event => {
  originalBroadcast(event);
  if (event.type.startsWith('orchestrator:') || event.type === 'resource-binding:updated' || event.type === 'todo:status-changed') timeline.push({ timestamp: store.now(), ...event });
};
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
async function wait(predicate: () => boolean, reason: string, timeout = 480_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${reason}`);
}
function state(id: string) {
  return { orchestration: store.getOrchestration(id), turns: store.turns(id), children: store.children(id).map(child => ({ ...store.childStatus(id, child.id), rounds: queries.getExecutionRoundsByTodoId(child.todo_id).map(round => ({ id: round.id, phase: round.phase, status: round.status, execution_snapshot: round.execution_snapshot })) })), resources: store.holds(id), events: store.events(id), operations: getDatabase().prepare('SELECT tool_name, idempotency_key, result_json, created_at FROM orchestrator_operations WHERE orchestrator_id = ?').all(id) };
}
const orchestrationIds: string[] = [];
try {
  report.claude = await getToolStatus('claude');
  report.opencode = await getToolStatus('opencode');
  await refreshModelCatalog('claude', { explicitRefresh: true });
  await refreshModelCatalog('opencode', { explicitRefresh: true });
  const primaryModel = queries.getModelsByTool('claude').find(model => model.model_value === (process.env.ORCHESTRATOR_SMOKE_CLAUDE_MODEL ?? 'claude-opus-4-7'));
  const childModel = queries.getModelsByTool('opencode').find(model => model.status === 'available' && /muse-spark-1\.3-contributor-free$/.test(model.model_value));
  ensure(primaryModel && childModel, 'Discovered strong Claude and exact free Muse model required; no paid fallback');
  const primary = queries.createExecutionProfile({ slug: 'smoke-primary', name: 'Smoke strong Claude', description: '', executors: [{ cli_model_id: primaryModel.id, effort_value: null, priority: 0 }] });
  const child = queries.createExecutionProfile({ slug: 'smoke-cheap', name: 'Smoke Muse free', description: '', executors: [{ cli_model_id: childModel.id, effort_value: null, priority: 0 }] });
  report.profiles = { primary: { id: primary.id, model: primaryModel.model_value }, child: { id: child.id, model: childModel.model_value } };
  const fixture = path.join(base, 'repo'); fs.mkdirSync(fixture);
  const git = (args: string[]) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', windowsHide: true });
  git(['init','-b','main']); git(['config','user.name','Orchestrator Smoke']); git(['config','user.email','orchestrator-smoke@example.invalid']);
  fs.writeFileSync(path.join(fixture,'add.cjs'), 'module.exports = (a,b) => a - b;\n');
  fs.writeFileSync(path.join(fixture,'add.test.cjs'), "const assert = require('node:assert/strict'); const add = require('./add.cjs'); assert.equal(add(2,3),5);\n");
  git(['add','.']); git(['commit','-m','Disposable smoke baseline']);
  const project = queries.createProject('Orchestrator smoke disposable', fixture);
  queries.updateProject(project.id, { default_review_profile_id: primary.id, max_concurrent: 4 });
  resourceManager.setAvailabilityCallback(() => { void todoOrchestrator.wakeWaitingResources(); orchestratorAgent.wake(); });
  executorPool.setAvailabilityCallback(() => { void todoOrchestrator.wakeWaitingExecutors(); orchestratorAgent.wake(); });
  providerQuotaService.setAvailabilityCallback(() => { void todoOrchestrator.wakeWaitingQuota(); orchestratorAgent.wake(); });
  resourceFabric.setAvailabilityCallback(() => { void todoOrchestrator.wakeWaitingResources(); orchestratorAgent.wake(); });
  resourceManager.initialize();
  await resourceFabric.scan(getComputeNodes().find(node => node.transport === 'local')!.id);
  await orchestratorAgent.initialize();
  if (process.argv[3] === 'parallel') {
    const b = store.createOrchestration(project.id, { title: 'Smoke B parallel integration', primary_execution_profile_id: primary.id,
      objective: `Delegate two independent children immediately, both to profile ${child.id}, in separate worktrees. First child: create alpha.cjs exporting x => x * 2, and alpha.test.cjs asserting alpha(3)===6; run the test; commit only those files; do not push. Second child: create beta.cjs exporting x => x + 1, and beta.test.cjs asserting beta(3)===4; run the test; commit only those files; do not push. Yield on ANY of their child_terminal events. Inspect completed children with get_task_status. If another remains active, yield for it. After both completed, create exactly one integration child to the same profile, including exact branch names from task status. Integration instructions: cherry-pick the two committed child branches in the integration worktree, run node alpha.test.cjs and node beta.test.cjs, do not change the fixture add utility, do not push. Yield for integration child completion. Finish only after integration completed. Use stable keys, no direct implementation, no automatic sibling merge.` });
    orchestrationIds.push(b.id); await orchestratorAgent.start(b.id);
    await wait(() => ['completed','failed','paused'].includes(store.getOrchestration(b.id).status), 'B integration', 600_000);
    report.smokeB = state(b.id);
    ensure(store.getOrchestration(b.id).status === 'completed' && store.children(b.id).length === 3, 'B parallel children/integration failed');
    const integration = store.children(b.id).at(-1)!;
    const integrationPath = queries.getTodoById(integration.todo_id)!.worktree_path!;
    execFileSync('node',['alpha.test.cjs'],{cwd:integrationPath}); execFileSync('node',['beta.test.cjs'],{cwd:integrationPath});
  } else {
  const a = store.createOrchestration(project.id, { title: 'Smoke A utility', primary_execution_profile_id: primary.id,
    objective: `Fix the add utility and tests in this disposable project. Delegate exactly one implementation child to execution profile ${child.id}. Child instructions: fix add.cjs to add correctly and add test coverage including negative numbers; run node add.test.cjs; do not push. Enable the existing review pipeline using review_profile_id ${primary.id}, max_rounds 2. Yield on that child_terminal event and wait for review completion. In the fresh next turn inspect get_task_status and finish only when the child is completed and reviewed. Do not implement directly or create extra tasks.` });
  orchestrationIds.push(a.id); report.smokeAId = a.id;
  await orchestratorAgent.start(a.id);
  await wait(() => ['waiting_event','failed','paused'].includes(store.getOrchestration(a.id).status), 'A yield');
  const waitingA = state(a.id); report.smokeAWaiting = waitingA;
  ensure(waitingA.orchestration.status === 'waiting_event' && waitingA.turns.every(turn => turn.process_pid === 0), 'A must yield with PID zero');
  await wait(() => ['completed','failed','paused'].includes(store.getOrchestration(a.id).status), 'A completion');
  report.smokeA = state(a.id);
  ensure(store.getOrchestration(a.id).status === 'completed' && store.turns(a.id).length >= 2 && store.children(a.id).length === 1, 'A delegation/review/wake failed');
  const node = getComputeNodes().find(node => node.transport === 'local')!;
  resourceFabric.updatePolicy(node.id, { ...node.policy, cpu_reserve_threads: node.inventory!.cpu.logical_threads - 1 });
  const requirements = { version: 2, requires: { cpu: { threads: 1 } }, prefers: {} };
  const blocker = queries.createTodo(project.id, 'CPU blocker', 'Start-Sleep -Seconds 180', 0, 'raw-shell', undefined, undefined, undefined, 20, 1, 'none', null, null, undefined, null, null, null, JSON.stringify(requirements));
  await todoOrchestrator.startTodo(blocker.id); report.blocker = blocker.id;
  ensure(queries.getTodoById(blocker.id)?.status === 'running', 'Blocker must own CPU');
  const c = store.createOrchestration(project.id, { title: 'Smoke C reservation', primary_execution_profile_id: primary.id,
    objective: `Request exactly 1 CPU thread through request_resources with requirements ${JSON.stringify(requirements)} and purpose CPU child. If waiting, yield on that resource_request. Once bound, delegate exactly one child using resource_request_id and execution profile ${child.id}. Child instructions: run node add.test.cjs, fix add.cjs if needed so the tests pass, do not push. Yield on child_terminal. After child completed, inspect resource request and finish after lease release. Do not release and reacquire the reserved binding. Do not implement directly.` });
  orchestrationIds.push(c.id); report.smokeCId = c.id;
  await orchestratorAgent.start(c.id);
  await wait(() => store.getOrchestration(c.id).status === 'waiting_event' || ['failed','paused'].includes(store.getOrchestration(c.id).status), 'C resource wait');
  report.smokeCWaiting = state(c.id);
  ensure(store.getOrchestration(c.id).status === 'waiting_event' && store.holds(c.id).some(hold => hold.status === 'waiting'), 'C must wait for CPU');
  timeline.push({ timestamp: store.now(), type: 'smoke.blocker-release' }); await todoOrchestrator.stopTodo(blocker.id);
  await wait(() => ['completed','failed','paused'].includes(store.getOrchestration(c.id).status), 'C completion');
  report.smokeC = state(c.id);
  ensure(store.getOrchestration(c.id).status === 'completed', 'C did not finish');
  const hold = store.holds(c.id)[0], binding = JSON.parse(hold.binding_json!);
  const job = store.children(c.id)[0], snapshot = JSON.parse(queries.getTodoById(job.todo_id)!.execution_snapshot!);
  ensure(snapshot.resourceBinding.id === binding.id && hold.status === 'released', 'C same-binding handoff and release required');
  const fulfilled = store.events(c.id).find(event => event.type === 'resource.fulfilled')!;
  const bindingRow = getDatabase().prepare('SELECT created_at FROM resource_bindings WHERE id = ?').get(binding.id) as { created_at: string };
  ensure(bindingRow.created_at <= fulfilled.created_at, 'Binding must precede wake event');
  const d = store.createOrchestration(project.id, { title: 'Smoke D human wake', primary_execution_profile_id: primary.id, objective: 'First turn: checkpoint then yield only on user_message. When a later user says ACCEPT-MESSAGE-42, finish with that exact message in your summary. Do not create children or resources.' });
  orchestrationIds.push(d.id); await orchestratorAgent.start(d.id);
  await wait(() => ['waiting_event','failed','paused'].includes(store.getOrchestration(d.id).status), 'D waiting');
  ensure(store.getOrchestration(d.id).status === 'waiting_event', 'D must yield');
  report.smokeDWaiting = state(d.id); store.addMessage(d.id, 'ACCEPT-MESSAGE-42');
  await wait(() => ['completed','failed','paused'].includes(store.getOrchestration(d.id).status), 'D completion');
  report.smokeD = state(d.id); ensure(store.getOrchestration(d.id).status === 'completed', 'D failed');
  }
  report.conclusion = 'READY_WITH_LIMITATIONS';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); report.conclusion = 'NOT_READY';
  for (const id of orchestrationIds) report[`failureState:${id}`] = state(id);
  process.exitCode = 1;
} finally {
  for (const id of orchestrationIds) if (!store.terminalStatuses.includes(store.getOrchestration(id).status)) await orchestratorAgent.cancel(id);
  if (typeof report.blocker === 'string' && queries.getTodoById(report.blocker)?.process_pid) await todoOrchestrator.stopTodo(report.blocker);
  await orchestratorAgent.shutdown(); resourceManager.shutdown(); resourceFabric.shutdown(); providerQuotaService.shutdown();
  fs.writeFileSync(path.join(base,'report.json'), JSON.stringify(report, null, 2));
  closeDatabase();
  process.stdout.write(JSON.stringify({ conclusion: report.conclusion, error: report.error, report: path.join(base,'report.json') }) + '\n');
}
