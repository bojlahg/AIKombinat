import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createChildEnvironment, SERVER_ONLY_ENV_KEYS } from '../src/server/utils/child-environment.js';

const base = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || fs.existsSync(base)) throw new Error('Provide a new disposable smoke directory');
fs.mkdirSync(base, { recursive: true });
process.env.DB_PATH = path.join(base, 'smoke.db');
process.env.AIKOMBINAT_LOG_DIR = path.join(base, 'logs');
process.env.SESSION_SECRET = 'ORCHESTRATOR_SECRET_CANARY';
const queries = await import('../src/server/db/queries.js');
const { closeDatabase, getDatabase } = await import('../src/server/db/connection.js');
const { refreshModelCatalog } = await import('../src/server/services/model-sync.js');
const { getToolStatus } = await import('../src/server/services/cli-status.js');
const { orchestratorAgent } = await import('../src/server/orchestration/service.js');
const store = await import('../src/server/orchestration/store.js');
const { resourceManager } = await import('../src/server/services/resource-manager.js');
const { resourceFabric } = await import('../src/server/services/resource-fabric.js');
const { providerQuotaService } = await import('../src/server/services/provider-quota.js');
const report: Record<string, unknown> = { date: new Date().toISOString(), platform: process.platform, node: process.version };
let id: string | undefined;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
try {
  const childEnv = createChildEnvironment();
  const boundary = JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(SERVER_ONLY_ENV_KEYS)}.map(k=>[k,Object.hasOwn(process.env,k)]))))`], { env: childEnv, encoding: 'utf8' }));
  ensure(Object.values(boundary).every(value => value === false), 'Server canary inherited by synthetic child');
  report.environment_boundary = boundary;
  report.claude = await getToolStatus('claude');
  await refreshModelCatalog('claude', { explicitRefresh: true });
  const model = queries.getModelsByTool('claude').find(row => row.model_value === (process.env.ORCHESTRATOR_SMOKE_CLAUDE_MODEL ?? 'claude-opus-4-7'));
  ensure(model, 'Requested exact Claude model absent from discovered catalog');
  report.model = model.model_value;
  const profile = queries.createExecutionProfile({ slug: 'security-primary', name: 'Security smoke Claude', description: '', executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
  const project = queries.createProject('Security smoke disposable', base);
  const parent = store.createOrchestration(project.id, { title: 'Security closure smoke', primary_execution_profile_id: profile.id,
    objective: 'One-turn protocol smoke. Do not create children or request resources. Call list_execution_profiles, then checkpoint_state with state_summary "Security smoke checkpoint" and current_plan "Finish protocol smoke", then finish with summary "Security smoke passed" and state_summary "Security smoke complete". End immediately after finish. Do not inspect files or environment.' });
  id = parent.id;
  await orchestratorAgent.initialize(); await orchestratorAgent.start(id);
  const deadline = Date.now() + 180_000;
  while (!['completed', 'failed', 'paused'].includes(store.getOrchestration(id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const turns = store.turns(id);
  const operations = getDatabase().prepare('SELECT tool_name FROM orchestrator_operations WHERE orchestrator_id = ? ORDER BY created_at, rowid').all(id) as { tool_name: string }[];
  report.orchestrator_id = id; report.status = store.getOrchestration(id).status;
  report.turns = turns; report.operations = operations;
  ensure(report.status === 'completed' && turns.length === 1, 'Real Claude must complete exactly one turn');
  ensure(turns[0].terminal_action === 'finish' && turns[0].process_pid === 0, 'Terminal action/PID cleanup missing');
  ensure(operations.some(operation => operation.tool_name === 'checkpoint_state'), 'MCP checkpoint did not run');
  report.conclusion = 'PASSED';
} catch (error) {
  report.error = error instanceof Error ? error.message : 'smoke_failed'; report.conclusion = 'FAILED'; process.exitCode = 1;
} finally {
  if (id && !store.terminalStatuses.includes(store.getOrchestration(id).status)) await orchestratorAgent.cancel(id);
  await orchestratorAgent.shutdown(); resourceManager.shutdown(); resourceFabric.shutdown(); providerQuotaService.shutdown();
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2)); closeDatabase();
  process.stdout.write(JSON.stringify({ conclusion: report.conclusion, error: report.error, report: path.join(base, 'report.json') }) + '\n');
}
