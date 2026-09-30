import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const base = path.resolve(process.argv[2] ?? ''), phase = process.argv[3];
if (!process.argv[2] || !['before','after'].includes(phase)) throw new Error('Usage: tsx scripts/orchestrator-restart-smoke.ts <disposable-directory> before|after');
if (phase === 'before') { if (fs.existsSync(base)) throw new Error('Directory must be new'); fs.mkdirSync(base, { recursive: true }); }
process.env.DB_PATH = path.join(base, 'restart.db'); process.env.AIKOMBINAT_LOG_DIR = path.join(base, 'logs');
const queries = await import('../src/server/db/queries.js');
const { getDatabase } = await import('../src/server/db/connection.js');
const store = await import('../src/server/orchestration/store.js');
const { callTool } = await import('../src/server/orchestration/tools.js');
const { OrchestratorAgentService } = await import('../src/server/orchestration/service.js');
const { executorPool } = await import('../src/server/services/executor-pool.js');
const { orchestrator: todoOrchestrator } = await import('../src/server/services/orchestrator.js');
const { resourceManager } = await import('../src/server/services/resource-manager.js');
const { releaseResource } = await import('../src/server/orchestration/resources.js');
const statePath = path.join(base, 'state.json');
const db = getDatabase();
let state: { parentId: string; profileId: string; childId?: string; requestId?: string };
if (phase === 'before') {
  const project = queries.createProject('Restart synthetic fixture', base);
  const model = queries.addModel('claude','fixture-primary','Synthetic primary');
  const profile = queries.createExecutionProfile({ slug: 'restart-fixture', name: 'Synthetic fixture', description: '', executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
  const node = db.prepare("SELECT id FROM compute_nodes WHERE transport = 'local'").get() as { id: string };
  db.prepare('INSERT INTO inventory_snapshots VALUES (?,?,?,?,?)').run(randomUUID(), node.id, JSON.stringify({ platform: { os: 'windows', arch: 'x64', hostname: 'fixture' }, cpu: { logical_threads: 1, physical_cores: 1, threads_per_core: 1, flags: [], model: 'fixture' }, memory: { total_bytes: 8 * 1024 ** 3, available_bytes: 8 * 1024 ** 3 }, storage: [], capabilities: {}, gpus: [] }), '[]', store.now());
  db.prepare("UPDATE compute_nodes SET scheduler_state = 'online' WHERE id = ?").run(node.id);
  const parent = store.createOrchestration(project.id, { title: 'Restart fixture', objective: 'Verify durable restart with fake primary and fake child admission', primary_execution_profile_id: profile.id });
  state = { parentId: parent.id, profileId: profile.id }; fs.writeFileSync(statePath, JSON.stringify(state));
} else state = JSON.parse(fs.readFileSync(statePath,'utf8'));
todoOrchestrator.startTodo = async () => undefined;
executorPool.selectExecutor = async () => ({ status: 'selected', evaluations: [], evaluatedAt: store.now(), selectedConfig: { cliTool: 'claude', source: 'profile', requestedModel: 'fixture-primary', model: 'fixture-primary', effectiveModel: 'fixture-primary', modelAvailability: 'available', effort: { nativeEffort: undefined, supportedEfforts: null, resolution: 'provider-default' }, warnings: [], resolvedAt: store.now() } });
let launchCount = 0;
const service = new OrchestratorAgentService(async input => {
  launchCount++;
  let resolve!: (result: { code: number; output: string; error: string }) => void;
  const exit = new Promise<{ code: number; output: string; error: string }>(done => { resolve = done; });
  setImmediate(async () => {
    try {
      const child = await callTool(input.orchestratorId, input.turnId, 'delegate_task', { idempotency_key: 'one-child', title: 'Synthetic child', instructions: 'Synthetic admission fixture; no provider executes.', execution_profile_id: state.profileId, use_worktree: false }) as { child_job_id: string; todo_id: string };
      const request = await callTool(input.orchestratorId, input.turnId, 'request_resources', { idempotency_key: 'one-request', purpose: 'Restart CPU hold', requirements: { version: 2, requires: { cpu: { threads: 1 } }, prefers: {} } }) as { request_id: string };
      if (phase === 'before') {
        state.childId = child.child_job_id; state.requestId = request.request_id; fs.writeFileSync(statePath, JSON.stringify(state));
        await callTool(input.orchestratorId, input.turnId, 'yield', { idempotency_key: 'wait-human', reason: 'Restart while waiting', state_summary: 'Durable checkpoint before controller exit', current_plan: 'Resume on human message', wake_on: { any: [{ type: 'user_message' }] } });
      } else {
        if (state.childId !== child.child_job_id || state.requestId !== request.request_id) throw new Error('Duplicate mutation after restart');
        queries.updateTodoStatus(child.todo_id, 'completed');
        await callTool(input.orchestratorId, input.turnId, 'release_resources', { idempotency_key: 'release', request_id: request.request_id });
        await callTool(input.orchestratorId, input.turnId, 'finish', { idempotency_key: 'done', summary: 'Restart passed without duplicate child/resource operations', state_summary: 'Done' });
      }
      resolve({ code: 0, output: '{}', error: '' });
    } catch (error) { process.stderr.write(String(error)); resolve({ code: 1, output: '', error: String(error) }); }
  });
  return { pid: 0, exit, revoke: async () => undefined };
});
resourceManager.initialize(); await service.initialize();
if (phase === 'before') await service.start(state.parentId);
else {
  if (store.getOrchestration(state.parentId).status !== 'waiting_event' || store.turns(state.parentId).some(turn => turn.process_pid > 0)) throw new Error('Waiting state/PID not recovered');
  if (!store.getOrchestration(state.parentId).state_summary.includes('Durable checkpoint')) throw new Error('Checkpoint lost');
  store.addMessage(state.parentId,'Wake after controller restart');
}
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const parent = store.getOrchestration(state.parentId);
  if (parent.status === (phase === 'before' ? 'waiting_event' : 'completed')) {
    const result = { phase, controllerPid: process.pid, status: parent.status, primaryPid: store.turns(parent.id).at(-1)?.process_pid, launches: launchCount,
      children: store.children(parent.id).length, requests: store.holds(parent.id).length, turns: parent.turn_count, events: store.events(parent.id).map(event => ({ type: event.type, consumed: !!event.consumed_at })) };
    fs.writeFileSync(path.join(base,`${phase}.json`),JSON.stringify(result,null,2)); process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }
  if (['failed','paused'].includes(parent.status)) throw new Error('Restart fixture failed');
  await new Promise(resolve => setTimeout(resolve, 25));
}
await service.cancel(state.parentId);
for (const hold of store.holds(state.parentId).filter(hold => ['waiting','bound'].includes(hold.status))) releaseResource(state.parentId,hold.id);
throw new Error('Restart fixture timeout');
