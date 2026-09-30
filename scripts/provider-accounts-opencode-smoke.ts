import fs from 'node:fs';
import path from 'node:path';
const base = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(base, 'smoke.db'))) throw new Error('Provide a completed provider accounts smoke directory');
process.env.DB_PATH = path.join(base, 'smoke.db'); process.env.AIKOMBINAT_LOG_DIR = path.join(base, 'logs');
const queries = await import('../src/server/db/queries.js');
const { getDatabase, closeDatabase } = await import('../src/server/db/connection.js');
const { refreshModelCatalog } = await import('../src/server/services/model-sync.js');
const { orchestratorAgent } = await import('../src/server/orchestration/service.js');
const { orchestrator } = await import('../src/server/services/orchestrator.js');
const { resourceManager } = await import('../src/server/services/resource-manager.js');
const { resourceFabric } = await import('../src/server/services/resource-fabric.js');
const { providerQuotaService } = await import('../src/server/services/provider-quota.js');
const store = await import('../src/server/orchestration/store.js');
const report = JSON.parse(fs.readFileSync(path.join(base, 'report.json'), 'utf8'));
let id: string | undefined;
try {
  await refreshModelCatalog('opencode', { explicitRefresh: true });
  const model = queries.getModelsByTool('opencode').find(model => model.status === 'available' && /muse-spark-1\.3-contributor-free$/.test(model.model_value))
    ?? queries.getModelsByTool('opencode').find(model => model.status === 'available' && /free$/.test(model.model_value));
  if (!model) throw new Error('No free OpenCode model available');
  const profile = queries.createExecutionProfile({ slug: 'accountless-child', name: 'Accountless child', description: '', executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
  const project = queries.getAllProjects().find(project => project.path === path.join(base, 'repo'));
  if (!project) throw new Error('Smoke project missing');
  const primaryProfile = queries.getExecutionProfileBySlug('accounts-smoke')!;
  await orchestratorAgent.initialize();
  const parent = store.createOrchestration(project.id, { title: 'Accountless OpenCode child smoke', primary_execution_profile_id: primaryProfile.id,
    objective: `Delegate exactly one child to execution profile ${profile.id}. Child instructions: reply exactly ACCOUNTLESS-CHILD-OK, do not use tools, change files, commit or push. Disable review. Then yield on child_terminal. On the next turn verify completion and finish. No additional children or resources.`, max_turns: 4 });
  id = parent.id; await orchestratorAgent.start(id);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !['completed','failed','paused'].includes(store.getOrchestration(id).status)) await new Promise(resolve => setTimeout(resolve, 100));
  const child = store.children(id)[0]; const todo = child ? queries.getTodoById(child.todo_id) : undefined;
  const snapshot = JSON.parse(todo?.execution_snapshot ?? '{}');
  report.opencode = { realSmoke: todo?.status ?? 'no_child', parentStatus: store.getOrchestration(id).status, model: model.model_value, snapshot };
  if (todo?.status !== 'completed' || snapshot.agent !== 'opencode' || snapshot.providerAccountId !== null) throw new Error('Accountless child smoke failed');
  report.foreignKeys = getDatabase().pragma('foreign_key_check');
} catch (error) { report.opencodeError = error instanceof Error ? error.message : 'OpenCode smoke failed'; report.conclusion = 'NOT_READY'; process.exitCode = 1; }
finally {
  if (id) {
    for (const child of store.children(id)) if (queries.getTodoById(child.todo_id)?.process_pid) await orchestrator.stopTodo(child.todo_id);
    if (!store.terminalStatuses.includes(store.getOrchestration(id).status)) await orchestratorAgent.cancel(id);
  }
  await orchestratorAgent.shutdown(); resourceManager.shutdown(); resourceFabric.shutdown(); providerQuotaService.shutdown();
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2)); closeDatabase(); console.log(JSON.stringify(report.opencode, null, 2));
}
