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
const accounts = await import('../src/server/services/provider-account-service.js');
const { getToolStatus } = await import('../src/server/services/cli-status.js');
const { orchestrator } = await import('../src/server/services/orchestrator.js');
const { orchestratorAgent } = await import('../src/server/orchestration/service.js');
const store = await import('../src/server/orchestration/store.js');
const { resourceManager } = await import('../src/server/services/resource-manager.js');
const { resourceFabric } = await import('../src/server/services/resource-fabric.js');
const { providerQuotaService } = await import('../src/server/services/provider-quota.js');
const report: Record<string, unknown> = { baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), OS: process.platform };
const todoIds: string[] = [];
let orchestrationId: string | null = null;
async function waitFor(predicate: () => boolean, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Smoke timeout');
}
try {
  report.providers = {};
  for (const provider of ['claude', 'codex', 'antigravity', 'opencode'] as const) {
    const status = await getToolStatus(provider);
    const account = accounts.listProviderAccounts().find(account => account.provider === provider);
    const health = account && status?.installed ? await accounts.probeProviderAccount(account.id) : account;
    (report.providers as Record<string, unknown>)[provider] = { installed: status?.installed ?? false, version: status?.version ?? null,
      strategies: provider === 'opencode' ? [] : accounts.providerAccountAdapters[provider].strategies,
      health: health?.health_state ?? null, method: provider === 'claude' ? 'auth status --json' : provider === 'codex' ? 'login status' : null };
  }
  report.compatibilityAccounts = accounts.listProviderAccounts().map(account => ({ id: account.id, provider: account.provider, strategy: account.auth_strategy }));
  const fixture = path.join(base, 'repo'); fs.mkdirSync(fixture);
  const git = (args: string[]) => execFileSync('git', args, { cwd: fixture, windowsHide: true });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Provider Accounts Smoke']); git(['config', 'user.email', 'smoke@example.invalid']);
  fs.writeFileSync(path.join(fixture, 'README.md'), 'Disposable provider accounts smoke.\n'); git(['add', '.']); git(['commit', '-m', 'Smoke fixture']);
  const project = queries.createProject('Provider Accounts smoke', fixture);
  const model = queries.addModel('claude', 'sonnet', 'Claude default Sonnet', null);
  const profile = queries.createExecutionProfile({ slug: 'accounts-smoke', name: 'Accounts smoke', description: '',
    executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
  const todo = queries.createTodo(project.id, 'Reply exactly ACCOUNT-COMPATIBILITY-OK. Do not use tools or modify files.', undefined, 0,
    'claude', undefined, undefined, undefined, 3, 0, 'none', null, null, undefined, profile.id);
  todoIds.push(todo.id);
  await orchestrator.startTodo(todo.id);
  await waitFor(() => ['completed', 'failed', 'waiting_quota', 'waiting_executor'].includes(queries.getTodoById(todo.id)!.status));
  const result = queries.getTodoById(todo.id)!;
  report.todo = { status: result.status, snapshot: JSON.parse(result.execution_snapshot ?? '{}') };
  if (result.status !== 'completed' || !JSON.parse(result.execution_snapshot ?? '{}').providerAccountId) throw new Error('Real compatibility Todo failed');
  await orchestratorAgent.initialize();
  const primary = store.createOrchestration(project.id, { title: 'Account identity primary smoke', primary_execution_profile_id: profile.id,
    objective: 'This smoke only checks your execution identity. Do not create children, request resources, inspect files, or change files. Call finish immediately with summary ACCOUNT-PRIMARY-OK and an idempotency key.', max_turns: 3 });
  orchestrationId = primary.id; await orchestratorAgent.start(primary.id);
  await waitFor(() => ['completed', 'failed', 'paused'].includes(store.getOrchestration(primary.id).status));
  report.orchestrator = { status: store.getOrchestration(primary.id).status, turns: store.turns(primary.id).map(turn => ({ status: turn.status, snapshot: JSON.parse(turn.execution_snapshot ?? '{}') })) };
  if (store.getOrchestration(primary.id).status !== 'completed') throw new Error('Real primary smoke failed');
  const openCode = await getToolStatus('opencode');
  report.opencode = { realSmoke: openCode?.installed ? 'available; choose a configured model to run' : 'unavailable', accountIdentity: null };
  report.foreignKeys = getDatabase().pragma('foreign_key_check');
  report.conclusion = 'READY_WITH_LIMITATIONS';
} catch (error) { report.error = error instanceof Error ? error.message : 'Smoke failed'; report.conclusion = 'NOT_READY'; process.exitCode = 1; }
finally {
  for (const id of todoIds) if (queries.getTodoById(id)?.process_pid) await orchestrator.stopTodo(id);
  if (orchestrationId && !store.terminalStatuses.includes(store.getOrchestration(orchestrationId).status)) await orchestratorAgent.cancel(orchestrationId);
  await orchestratorAgent.shutdown(); resourceManager.shutdown(); resourceFabric.shutdown(); providerQuotaService.shutdown();
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  closeDatabase();
  console.log(JSON.stringify(report, null, 2));
}
