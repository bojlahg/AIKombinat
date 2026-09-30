import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Project, ExecutionProfile } from '../db/queries.js';
import { initDatabase, migrateOrchestratorResourceChecks } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';

let db: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => db }));
const queries = await import('../db/queries.js');
const store = await import('./store.js');
const { callTool } = await import('./tools.js');
const { createTurnTransport } = await import('./primary.js');
const { OrchestratorAgentService, buildContext } = await import('./service.js');
const { ORCHESTRATOR_CONTEXT_MAX_BYTES, ORCHESTRATOR_EVENT_BATCH_MAX_BYTES, eventSnapshot } = await import('./context-budget.js');
const { canonicalJson } = await import('../services/resource-requirements.js');
const { requestResource, reconcileResources, releaseResource, CLAIM_WINDOW_MS } = await import('./resources.js');
const { executorPool } = await import('../services/executor-pool.js');
const cliStatus = await import('../services/cli-status.js');
const { providerQuotaService } = await import('../services/provider-quota.js');
const { resourceManager } = await import('../services/resource-manager.js');
const { orchestrator: todoOrchestrator } = await import('../services/orchestrator.js');
const { broadcaster } = await import('../websocket/broadcaster.js');
const processTree = await import('../utils/process-tree.js');
let workspace: TestWorkspace;
let project: Project;
let profile: ExecutionProfile;
let services: InstanceType<typeof OrchestratorAgentService>[];

beforeEach(() => {
  workspace = createTestWorkspace('orchestrator');
  db = new Database(':memory:'); initDatabase(db);
  project = queries.createProject('Disposable', workspace.createSubdir('project'));
  profile = queries.createExecutionProfile({ slug: 'orchestrator-test', name: 'Claude', description: '', executors: [{ cli_model_id: queries.addModel('claude', 'sonnet', 'Sonnet').id, effort_value: null, priority: 0 }] });
  executorPool.resetReservations(); executorPool.resetLimits(); providerQuotaService.resetForTesting();
  vi.spyOn(cliStatus, 'getToolStatus').mockImplementation(async tool => ({ tool, installed: true, version: 'fixture' }));
  vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
  vi.spyOn(todoOrchestrator, 'startTodo').mockResolvedValue(undefined);
  services = [];
});
afterEach(async () => {
  await Promise.all(services.map(service => service.shutdown()));
  await new Promise(resolve => setImmediate(resolve));
  resourceManager.shutdown(); resourceManager.setAvailabilityCallback(null);
  executorPool.resetReservations(); executorPool.resetLimits(); providerQuotaService.resetForTesting();
  vi.restoreAllMocks(); db.close(); workspace.cleanup();
});
function parent(overrides = {}) { return store.createOrchestration(project.id, { title: 'Goal', objective: 'Create a utility and tests', primary_execution_profile_id: profile.id, ...overrides }); }
function running(id: string) { const turn = store.requestTurn(id, 'start')!; store.updateTurn(turn.id, { status: 'running' }); store.updateOrchestration(id, { status: 'running' }); return turn; }
const delegate = (key = 'child') => ({ idempotency_key: key, title: 'Implement utility', instructions: 'Implement utility and add tests.', execution_profile_id: profile.id });
function installCpu() {
  const node = db.prepare("SELECT id FROM compute_nodes WHERE transport = 'local'").get() as { id: string };
  const inventory = { platform: { os: 'windows', arch: 'x64', hostname: 'fixture' }, cpu: { model: 'fixture', logical_threads: 1, physical_cores: 1, threads_per_core: 1, flags: [] }, memory: { total_bytes: 8 * 1024 ** 3, available_bytes: 8 * 1024 ** 3 }, storage: [], gpus: [], capabilities: {} };
  db.prepare('INSERT INTO inventory_snapshots VALUES (?,?,?,?,?)').run(randomUUID(), node.id, JSON.stringify(inventory), '[]', store.now());
  db.prepare("UPDATE compute_nodes SET scheduler_state = 'online' WHERE id = ?").run(node.id);
  return node.id;
}
const cpu = { version: 2 as const, requires: { cpu: { threads: 1 } }, prefers: {} };
function fakeService(callback: (id: string, turnId: string, context: string) => Promise<void>, code = 0) {
  const launch = vi.fn(async (input: { orchestratorId: string; turnId: string; context: string }) => {
    let done!: (result: { code: number; output: string; error: string }) => void;
    const exit = new Promise<{ code: number; output: string; error: string }>(resolve => { done = resolve; });
    setImmediate(() => callback(input.orchestratorId, input.turnId, input.context).then(() => done({ code, output: '{}', error: '' })));
    return { pid: 0, exit, revoke: async () => undefined };
  });
  const service = new OrchestratorAgentService(launch); services.push(service); return { service, launch };
}

describe('durable orchestration and event delivery', () => {
  it('retries a crashed terminal action without consuming its events or duplicating terminal effects', async () => {
    const p = parent(); store.addMessage(p.id, 'Keep this event until successful exit');
    const turn = running(p.id);
    const args = { idempotency_key: 'yield-once', reason: 'Wait', state_summary: 'Saved', current_plan: 'Next', wake_on: { any: [{ type: 'user_message' }] } };
    await callTool(p.id, turn.id, 'yield', args);
    const { service } = fakeService(async (id, nextTurn) => { await callTool(id, nextTurn, 'yield', args); });
    await service.initialize();
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('waiting_event'));
    expect(store.turns(p.id).map(item => item.status)).toEqual(['failed','completed']);
    expect(store.events(p.id)[0].consumed_at).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) count FROM orchestrator_operations').get()).toEqual({ count: 1 });
  });
  it('handles parallel ANY completions and a separate integration child through ordinary Todos', async () => {
    const p = parent(), turn = running(p.id);
    const first = await callTool(p.id, turn.id, 'delegate_task', delegate('parallel-a')) as { child_job_id: string; todo_id: string };
    const second = await callTool(p.id, turn.id, 'delegate_task', delegate('parallel-b')) as { child_job_id: string; todo_id: string };
    await callTool(p.id, turn.id, 'yield', { idempotency_key: 'wait-any', reason: 'Parallel children', state_summary: '', current_plan: '', wake_on: { any: [{ type: 'child_terminal', child_job_id: first.child_job_id }, { type: 'child_terminal', child_job_id: second.child_job_id }] } });
    store.updateTurn(turn.id, { status: 'completed' }); store.updateOrchestration(p.id, { status: 'waiting_event' });
    queries.updateTodoStatus(first.todo_id, 'completed'); queries.updateTodoStatus(second.todo_id, 'completed'); store.reconcileChildren();
    const next = store.requestTurn(p.id)!; expect(store.events(p.id).filter(event => event.assigned_turn_id === next.id)).toHaveLength(2);
    store.updateTurn(next.id, { status: 'running' }); store.updateOrchestration(p.id, { status: 'running' });
    await callTool(p.id, next.id, 'delegate_task', { ...delegate('integration'), title: 'Integrate sibling artifacts', instructions: 'Integrate the two child artifacts and validate.' });
    expect(store.children(p.id)).toHaveLength(3);
  });
  it('rejects a primary profile without enabled Claude and caps budgets/UTF-8 payloads', () => {
    const codex = queries.createExecutionProfile({ slug: 'codex-only', name: 'Codex', description: '', executors: [{ cli_model_id: queries.addModel('codex', 'gpt-test', 'GPT').id, effort_value: null, priority: 0 }] });
    expect(() => parent({ primary_execution_profile_id: codex.id })).toThrow('claude_primary_profile_required');
    expect(() => parent({ max_turns: 129 })).toThrow();
    expect(() => parent({ objective: 'я'.repeat(17000) })).toThrow();
  });
  it('batches deduped events, retains them until success, and enforces one active turn', () => {
    const p = parent();
    for (let i = 0; i < 5; i++) store.addEvent(p.id, 'user.message', 'message', `m${i}`, `m${i}`, { content: `${i}` });
    store.addEvent(p.id, 'user.message', 'message', 'm0', 'm0', {});
    const turn = running(p.id);
    expect(store.events(p.id)).toHaveLength(5);
    expect(store.events(p.id).every(event => event.assigned_turn_id === turn.id && !event.consumed_at)).toBe(true);
    expect(store.requestTurn(p.id, 'start')).toBeNull();
    expect(() => db.prepare("INSERT INTO orchestrator_turns (id,orchestrator_id,turn_index,status,trigger_type,created_at) VALUES (?,?,99,'running','test',?)").run(randomUUID(), p.id, store.now())).toThrow();
  });
  it('redelivers failed events on one corrective retry and pauses at turn budget', async () => {
    const p = parent({ max_turns: 2 }); store.addMessage(p.id, 'Exact user message');
    const { service, launch } = fakeService(async () => undefined);
    await service.initialize(); await service.start(p.id);
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('failed'));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(store.turns(p.id).map(turn => turn.status)).toEqual(['protocol_error','protocol_error']);
    expect(store.events(p.id)[0].consumed_at).toBeNull();
    await service.resume(p.id);
    await vi.waitFor(() => expect(store.getOrchestration(p.id).waiting_reason).toBe('turn_budget_exhausted'));
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it('wakes on an event arriving before yield, consumes after exit, and uses fresh turns', async () => {
    const p = parent();
    const contexts: string[] = [];
    const { service, launch } = fakeService(async (id, turnId, context) => {
      contexts.push(context);
      if (store.getTurn(turnId).turn_index === 1) {
        store.addMessage(id, 'Wake with this exact content');
        await callTool(id, turnId, 'yield', { idempotency_key: 'wait', reason: 'Wait for user', state_summary: 'Saved', current_plan: 'Continue', wake_on: { any: [{ type: 'user_message' }] } });
      } else await callTool(id, turnId, 'finish', { idempotency_key: 'done', summary: 'Finished', state_summary: 'Final' });
    });
    await service.initialize(); await service.start(p.id);
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('completed'));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(contexts[1]).toContain('Wake with this exact content');
    expect(store.turns(p.id).every(turn => turn.process_pid === 0 && turn.status === 'completed')).toBe(true);
    expect(store.events(p.id).every(event => event.consumed_at)).toBe(true);
  });
  it('persists waiting across controller recreation, human messages wake, paused messages do not', async () => {
    const p = parent();
    const first = fakeService(async (id, turnId) => { await callTool(id, turnId, 'yield', { idempotency_key: 'wait', reason: 'User', state_summary: 'Checkpoint', current_plan: 'Next', wake_on: { any: [{ type: 'user_message' }] } }); });
    await first.service.initialize(); await first.service.start(p.id);
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('waiting_event'));
    first.service.shutdown();
    const second = fakeService(async (id, turnId, context) => { expect(context).toContain('Checkpoint'); await callTool(id, turnId, 'finish', { idempotency_key: 'finish', summary: 'Done', state_summary: 'Done' }); });
    await second.service.initialize();
    await second.service.pause(p.id); store.addMessage(p.id, 'While paused');
    await new Promise(resolve => setImmediate(resolve));
    expect(second.launch).not.toHaveBeenCalled();
    await second.service.resume(p.id);
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('completed'));
    expect(second.launch).toHaveBeenCalledTimes(1);
  });
  it('reconciles child terminal events durably and idempotently', async () => {
    const p = parent(), turn = running(p.id);
    const job = await callTool(p.id, turn.id, 'delegate_task', delegate()) as { child_job_id: string; todo_id: string };
    queries.updateTodoStatus(job.todo_id, 'completed'); store.reconcileChildren();
    queries.updateTodoStatus(job.todo_id, 'completed'); store.reconcileChildren();
    expect(store.events(p.id).filter(event => event.type === 'child.completed')).toHaveLength(1);
  });
});

describe('MCP mutations and security', () => {
  it('rotates capabilities across turns without persisting or exposing them in diagnostics', async () => {
    const { logger } = await import('../logging/logger.js');
    const { resetRedactionCache } = await import('../logging/redact.js');
    const records: unknown[] = [];
    logger.configure({ level: 'debug', sinks: [{ write: record => { records.push(record); } }] });
    for (const key of ['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN']) vi.stubEnv(key, `TOP_SECRET_${key}`);
    resetRedactionCache();
    const p = parent(), first = running(p.id), a = await createTurnTransport(p.id, first.id);
    try {
      logger.error('orchestrator.turn.failed', { err: new Error(`spawn failed ${a.capability} ${process.env.SESSION_SECRET} ${process.env.AUTH_PASSWORD} ${process.env.TUNNEL_TOKEN}`) });
      logger.info('orchestrator.turn.started', { orchestratorId: p.id, turnId: first.id, pid: 0 });
      store.updateTurn(first.id, { status: 'completed' }); await a.revoke();
      const second = running(p.id), b = await createTurnTransport(p.id, second.id);
      try {
        expect(a.capability === b.capability).toBe(false);
        expect((await fetch(b.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${a.capability}` }, body: '{}' })).status).toBe(403);
        const databaseState = JSON.stringify({ parent: store.getOrchestration(p.id), turns: store.turns(p.id), messages: db.prepare('SELECT * FROM orchestrator_messages').all(), operations: db.prepare('SELECT * FROM orchestrator_operations').all(), events: store.events(p.id) });
        for (const secret of [a.capability, b.capability, ...['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN'].map(key => process.env[key]!)]) {
          expect(databaseState.includes(secret)).toBe(false); expect(JSON.stringify(records).includes(secret)).toBe(false);
        }
      } finally { await b.revoke(); }
    } finally { await a.revoke(); vi.unstubAllEnvs(); resetRedactionCache(); logger.configure({ level: 'info', dir: null }); }
  });
  it('duplicate delegation returns identical IDs, changed arguments conflict, depth remains ordinary Todo', async () => {
    const p = parent(), turn = running(p.id), args = delegate();
    const result = await callTool(p.id, turn.id, 'delegate_task', args);
    expect(await callTool(p.id, turn.id, 'delegate_task', args)).toEqual(result);
    await expect(callTool(p.id, turn.id, 'delegate_task', { ...args, title: 'Changed' })).rejects.toThrow('idempotency_conflict');
    expect(queries.getTodosByProjectId(project.id)).toHaveLength(1);
    expect(queries.getTodosByProjectId(project.id)[0].use_worktree).toBe(1);
    expect(store.children(p.id)).toHaveLength(1);
  });
  it('rejects another parent child/request and an expired turn', async () => {
    const a = parent(), aTurn = running(a.id), b = parent(), bTurn = running(b.id);
    const job = await callTool(a.id, aTurn.id, 'delegate_task', delegate()) as { child_job_id: string };
    await expect(callTool(b.id, bTurn.id, 'get_task_status', { child_job_id: job.child_job_id })).rejects.toThrow('unknown_child');
    await expect(callTool(b.id, aTurn.id, 'list_execution_profiles', {})).rejects.toThrow('expired_turn');
    await expect(callTool(a.id, aTurn.id, 'get_resource_request', { request_id: randomUUID() })).rejects.toThrow('unknown_resource_request');
    store.updateTurn(aTurn.id, { status: 'completed' });
    await expect(callTool(a.id, aTurn.id, 'checkpoint_state', { idempotency_key: 'save', state_summary: '', current_plan: '' })).rejects.toThrow('expired_turn');
  });
  it('requires a random capability, scopes transport to its turn, and revokes it', async () => {
    const p = parent(), turn = running(p.id), transport = await createTurnTransport(p.id, turn.id);
    try {
      expect((await fetch(transport.endpoint, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer wrong' } })).status).toBe(403);
      const headers = { Authorization: `Bearer ${transport.capability}`, 'Content-Type': 'application/json' };
      expect((await fetch(transport.endpoint, { method: 'POST', headers, body: JSON.stringify({ method: 'tools/list' }) })).status).toBe(200);
      store.updateTurn(turn.id, { status: 'completed' });
      expect((await fetch(transport.endpoint, { method: 'POST', headers, body: '{}' })).status).toBe(403);
    } finally { await transport.revoke(); }
    await expect(fetch(transport.endpoint)).rejects.toThrow();
  });
  it('enforces child concurrency/total and mutating per-turn budgets', async () => {
    const p = parent({ max_children: 2, max_concurrent_children: 1 }), turn = running(p.id);
    const first = await callTool(p.id, turn.id, 'delegate_task', delegate('one')) as { todo_id: string };
    await expect(callTool(p.id, turn.id, 'delegate_task', delegate('two'))).rejects.toThrow('child_concurrency_limit');
    queries.updateTodoStatus(first.todo_id, 'completed');
    const second = await callTool(p.id, turn.id, 'delegate_task', delegate('two')) as { todo_id: string }; queries.updateTodoStatus(second.todo_id, 'completed');
    await expect(callTool(p.id, turn.id, 'delegate_task', delegate('three'))).rejects.toThrow('child_budget_exhausted');
    for (let i = 0; i < 62; i++) await callTool(p.id, turn.id, 'checkpoint_state', { idempotency_key: `s${i}`, state_summary: '', current_plan: '' });
    await expect(callTool(p.id, turn.id, 'checkpoint_state', { idempotency_key: 'overflow', state_summary: '', current_plan: '' })).rejects.toThrow('mutating_operation_budget_exhausted');
  });
  it('validates ANY ownership, UTF-8 and concrete hardware selectors; finish rejects active work', async () => {
    const p = parent(), turn = running(p.id);
    await expect(callTool(p.id, turn.id, 'request_resources', { idempotency_key: 'node', purpose: '', requirements: { ...cpu, requires: { node_id: randomUUID() } } })).rejects.toThrow();
    await expect(callTool(p.id, turn.id, 'checkpoint_state', { idempotency_key: 'big', state_summary: 'я'.repeat(9000), current_plan: '' })).rejects.toThrow();
    await expect(callTool(p.id, turn.id, 'yield', { idempotency_key: 'unknown', reason: '', state_summary: '', current_plan: '', wake_on: { any: [{ type: 'child_terminal', child_job_id: randomUUID() }] } })).rejects.toThrow('unknown_child');
    await callTool(p.id, turn.id, 'delegate_task', delegate());
    await expect(callTool(p.id, turn.id, 'finish', { idempotency_key: 'done', summary: 'Done', state_summary: '' })).rejects.toThrow('active_children');
  });
});

describe('aggregate primary context budget', () => {
  const unicode = (bytes: number) => 'я😀界'.repeat(Math.floor(bytes / Buffer.byteLength('я😀界')));
  it('preserves mandatory Unicode state/events/active work and omits optional history deterministically', () => {
    installCpu();
    const p = parent({ objective: unicode(32768), max_children: 100, max_active_resource_requests: 8 });
    store.updateOrchestration(p.id, { state_summary: unicode(16384), current_plan: unicode(16384) });
    for (let i = 0; i < 64; i++) store.addEvent(p.id, 'user.message', 'message', `m${i}`, `m${i}`, { content: unicode(15000) });
    for (let i = 0; i < 12; i++) store.addMessage(p.id, unicode(32768), 'assistant');
    const turn = running(p.id);
    for (let i = 0; i < 100; i++) {
      const todo = queries.createTodo(project.id, `Child ${i}`);
      queries.updateTodo(todo.id, { summary: i < 16 ? 'Active checkpoint' : '😀'.repeat(2048) });
      if (i >= 16) queries.updateTodoStatus(todo.id, 'completed');
      db.prepare('INSERT INTO orchestrator_child_jobs (id, orchestrator_id, todo_id, purpose, created_by_turn_id, created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), p.id, todo.id, 'Fixture', turn.id, store.now());
    }
    for (let i = 0; i < 40; i++) {
      const hold = requestResource(p.id, turn.id, `History ${i}`, cpu); releaseResource(p.id, hold.id);
    }
    const active = requestResource(p.id, turn.id, 'Current CPU', cpu);
    const serialized = buildContext(p.id, turn.id), context = JSON.parse(serialized);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(ORCHESTRATOR_CONTEXT_MAX_BYTES);
    expect(context.objective).toBe(p.objective);
    expect(context.state_summary).toBe(unicode(16384)); expect(context.current_plan).toBe(unicode(16384));
    const assigned = store.events(p.id).filter(event => event.assigned_turn_id === turn.id);
    expect(assigned.length).toBeLessThan(64);
    expect(Buffer.byteLength(canonicalJson(assigned.map(eventSnapshot)))).toBeLessThanOrEqual(ORCHESTRATOR_EVENT_BATCH_MAX_BYTES);
    expect(context.events).toEqual(assigned.map(eventSnapshot));
    for (const child of store.activeChildren(p.id)) expect(context.children.some((row: { child_job_id: string }) => row.child_job_id === child.id)).toBe(true);
    expect(context.resources.some((row: { request_id: string }) => row.request_id === active.id)).toBe(true);
    expect(context.context_truncated).toBe(true);
    expect(context.omitted_messages).toBe(12 - context.recent_messages.length);
    expect(context.omitted_terminal_children).toBe(100 - context.children.length);
    expect(context.omitted_historical_resources).toBe(41 - context.resources.length);
    expect(store.events(p.id).filter(event => !event.assigned_turn_id && !event.consumed_at).length).toBeGreaterThan(0);
    expect(buildContext(p.id, turn.id)).toBe(serialized); expect(store.hash(buildContext(p.id, turn.id))).toBe(store.hash(serialized));
  });
  it('leaves overflow pending, then delivers it in fresh turns even after finish', async () => {
    const p = parent();
    for (let i = 0; i < 24; i++) store.addEvent(p.id, 'child.completed', 'child', `${i}`, `${i}`, { summary: unicode(15000) });
    const delivered: string[] = [];
    const { service, launch } = fakeService(async (id, turnId, context) => {
      const events = JSON.parse(context).events;
      delivered.push(...events.map((event: { id: string }) => event.id));
      expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(ORCHESTRATOR_CONTEXT_MAX_BYTES);
      await callTool(id, turnId, 'finish', { idempotency_key: `finish:${turnId}`, summary: 'Batch acknowledged', state_summary: '' });
    });
    await service.initialize(); await service.start(p.id);
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('completed'));
    expect(launch.mock.calls.length).toBeGreaterThan(1);
    expect(delivered).toEqual(store.events(p.id).map(event => event.id));
    expect(store.events(p.id).every(event => event.consumed_at)).toBe(true);
  });
  it('rejects corrupted oversized mandatory state or event rather than silently cutting JSON', () => {
    const p = parent(), turn = running(p.id);
    store.updateOrchestration(p.id, { current_plan: '😀'.repeat(ORCHESTRATOR_CONTEXT_MAX_BYTES) });
    expect(() => buildContext(p.id, turn.id)).toThrow('orchestrator_mandatory_context_budget_exceeded');
    store.updateTurn(turn.id, { status: 'completed' });
    store.addEvent(p.id, 'user.message', 'message', 'oversize', 'oversize', {});
    db.prepare('UPDATE orchestrator_events SET payload_json = ? WHERE orchestrator_id = ?').run(JSON.stringify({ content: '😀'.repeat(ORCHESTRATOR_EVENT_BATCH_MAX_BYTES) }), p.id);
    expect(() => store.requestTurn(p.id)).toThrow('orchestrator_event_budget_exceeded');
    expect(store.turns(p.id)).toHaveLength(1);
    expect(store.events(p.id).every(event => !event.assigned_turn_id && !event.consumed_at)).toBe(true);
  });
});

describe('Resource Fabric reservations', () => {
  it('reserves before event, persists without PID, transfers same binding after admission with no reacquire', async () => {
    installCpu(); const p = parent(), turn = running(p.id);
    const blocker = queries.createTodo(project.id, 'Blocker');
    const blocked = resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: blocker.id, runToken: 'blocker', resources: cpu });
    expect(blocked.status).toBe('acquired');
    const hold = requestResource(p.id, turn.id, 'CPU child', cpu); expect(hold.status).toBe('waiting');
    resourceManager.releaseRun('blocker'); reconcileResources();
    const reserved = store.getHold(p.id, hold.id); expect(reserved.status).toBe('bound');
    expect(store.events(p.id).find(event => event.type === 'resource.fulfilled')).toBeDefined();
    const originalBinding = JSON.parse(reserved.binding_json!);
    resourceManager.recoverStaleLeases(true); expect(db.prepare("SELECT id FROM resource_leases WHERE owner_type = 'orchestrator'").all()).toHaveLength(1);
    const job = await callTool(p.id, turn.id, 'delegate_task', { ...delegate(), resource_request_id: hold.id }) as { todo_id: string };
    expect(store.getHold(p.id, hold.id).status).toBe('bound');
    const claimed = resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: job.todo_id, runToken: 'child', resources: cpu });
    expect(claimed.status === 'acquired' && claimed.binding?.id).toBe(originalBinding.id);
    expect(store.getHold(p.id, hold.id).status).toBe('claimed');
    expect(() => releaseResource(p.id, hold.id)).toThrow('resource_owned_by_child');
    expect(db.prepare('SELECT COUNT(*) count FROM resource_bindings').get()).toEqual({ count: 2 });
    resourceManager.releaseRun('child'); reconcileResources(); expect(store.getHold(p.id, hold.id).status).toBe('released');
  });
  it('expires while child waits for executor; copied requirements acquire a new attempt later', async () => {
    installCpu(); const p = parent(), turn = running(p.id), hold = requestResource(p.id, turn.id, 'CPU', cpu);
    const job = await callTool(p.id, turn.id, 'delegate_task', { ...delegate(), resource_request_id: hold.id }) as { todo_id: string };
    queries.updateTodoStatus(job.todo_id, 'waiting_executor');
    expect(Date.parse(hold.claim_expires_at!) - Date.now()).toBeLessThanOrEqual(CLAIM_WINDOW_MS);
    db.prepare('UPDATE orchestrator_resource_requests SET claim_expires_at = ? WHERE id = ?').run('2000-01-01', hold.id);
    reconcileResources(); expect(store.getHold(p.id, hold.id).status).toBe('expired');
    expect(db.prepare('SELECT * FROM resource_leases').all()).toHaveLength(0);
    const newAttempt = resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: job.todo_id, runToken: 'later', resources: cpu });
    expect(newAttempt.status).toBe('acquired');
    expect(newAttempt.status === 'acquired' && newAttempt.binding?.id).not.toBe(JSON.parse(hold.binding_json!).id);
  });
  it('enforces resource budget and idempotency, finish rejects holds, pause releases without stopping children', async () => {
    installCpu(); const p = parent({ max_active_resource_requests: 1 }), turn = running(p.id);
    const args = { idempotency_key: 'cpu', purpose: 'CPU', requirements: cpu };
    const first = await callTool(p.id, turn.id, 'request_resources', args);
    expect(await callTool(p.id, turn.id, 'request_resources', args)).toEqual(first);
    await expect(callTool(p.id, turn.id, 'request_resources', { ...args, purpose: 'changed' })).rejects.toThrow('idempotency_conflict');
    await expect(callTool(p.id, turn.id, 'request_resources', { ...args, idempotency_key: 'other' })).rejects.toThrow('resource_request_budget_exhausted');
    await expect(callTool(p.id, turn.id, 'finish', { idempotency_key: 'done', summary: 'Done', state_summary: '' })).rejects.toThrow('active_resource_requests');
    const child = await callTool(p.id, turn.id, 'delegate_task', delegate()) as { todo_id: string };
    const service = new OrchestratorAgentService(); services.push(service); await service.pause(p.id);
    expect(queries.getTodoById(child.todo_id)?.status).toBe('pending');
    expect(store.holds(p.id)[0].status).toBe('released');
  });
});

describe('ExecutorPool and cancel ownership', () => {
  it('retains matching/unverifiable startup PID ownership and never signals a mismatched process', async () => {
    const p = parent(), turn = running(p.id);
    store.updateTurn(turn.id, { process_pid: 777777, process_identity: JSON.stringify({ pid: 777777, startedAt: 'fixture' }) });
    vi.spyOn(processTree, 'isProcessAlive').mockReturnValue(true);
    const verify = vi.spyOn(processTree, 'verifyProcessIdentity').mockResolvedValue('unverifiable');
    const terminate = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(false);
    const service = new OrchestratorAgentService(); services.push(service);
    await service.recover();
    expect(store.getTurn(turn.id).process_pid).toBe(777777);
    expect(store.getOrchestration(p.id).status).toBe('paused');
    await expect(service.resume(p.id)).rejects.toThrow('primary_recovery_required');
    verify.mockResolvedValue('mismatch'); await service.recover();
    expect(store.getTurn(turn.id).process_pid).toBe(0);
    expect(terminate).not.toHaveBeenCalled();
  });
  it('chooses Claude despite higher-priority Codex, waits for executor/quota, counts persisted primary ownership', async () => {
    const mixed = queries.createExecutionProfile({ slug: 'mixed', name: 'Mixed', description: '', executors: [
      { cli_model_id: queries.addModel('codex', 'gpt-primary', 'Codex').id, effort_value: null, priority: 0 },
      { cli_model_id: profile.executors[0].cli_model_id, effort_value: null, priority: 1 },
    ] });
    const selected = await executorPool.selectExecutor({ executionProfileId: mixed.id, allowedCliTools: ['claude'] });
    expect(selected.selectedConfig?.cliTool).toBe('claude');
    executorPool.setLimit('claude', 0);
    expect((await executorPool.selectExecutor({ executionProfileId: mixed.id, allowedCliTools: ['claude'] })).status).toBe('waiting_executor');
    executorPool.setLimit('claude', 2);
    vi.spyOn(providerQuotaService, 'getAccountQuotaState').mockReturnValue({ state: 'exhausted', tool: 'claude', reason: 'fixture', source: 'test', nextCheckAt: null } as never);
    expect((await executorPool.selectExecutor({ executionProfileId: mixed.id, allowedCliTools: ['claude'] })).status).toBe('waiting_quota');
    const p = parent(), turn = running(p.id); store.updateTurn(turn.id, { status: 'failed', process_pid: 999999 });
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
  });
  it('cancel retains cancelling for unresolved child and completes after safe stop', async () => {
    installCpu(); const p = parent(), turn = running(p.id);
    const job = await callTool(p.id, turn.id, 'delegate_task', delegate()) as { todo_id: string };
    requestResource(p.id, turn.id, 'Hold', cpu);
    queries.updateTodo(job.todo_id, { process_pid: 12345 }); queries.updateTodoStatus(job.todo_id, 'running');
    const stop = vi.spyOn(todoOrchestrator, 'stopTodo').mockRejectedValue(new Error('unresolved'));
    const service = new OrchestratorAgentService(); services.push(service); await service.cancel(p.id);
    expect(store.getOrchestration(p.id).status).toBe('cancelling');
    expect(store.holds(p.id)[0].status).toBe('released');
    stop.mockImplementation(async id => { queries.updateTodo(id, { process_pid: 0 }); queries.updateTodoStatus(id, 'stopped'); });
    await service.cancel(p.id); expect(store.getOrchestration(p.id).status).toBe('cancelled');
  });
});

describe('V2 migration', () => {
  it('rebuilds owner/status CHECKs without changing IDs, bindings or FKs and remains idempotent', () => {
    installCpu(); const todo = queries.createTodo(project.id, 'Existing');
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'legacy', resources: cpu });
    const session = queries.createSession(project.id, 'Existing session');
    resourceManager.acquireAtomic({ ownerType: 'session', ownerId: session.id, runToken: 'legacy-session', resources: { version: 2, requires: { platform: { os: 'windows' } }, prefers: {} } });
    const before = db.prepare('SELECT * FROM resource_requests').all(), leases = db.prepare('SELECT * FROM resource_leases').all();
    db.pragma('foreign_keys = OFF');
    for (const name of ['resource_requests','resource_leases']) {
      const definition = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql
        .replace(`CREATE TABLE ${name}`, `CREATE TABLE ${name}_v2`).replace(", 'orchestrator'", '').replace(", 'claimed', 'released', 'expired'", '');
      db.exec(definition); db.exec(`INSERT INTO ${name}_v2 SELECT * FROM ${name}`); db.exec(`DROP TABLE ${name}`); db.exec(`ALTER TABLE ${name}_v2 RENAME TO ${name}`);
    }
    db.pragma('foreign_keys = ON'); migrateOrchestratorResourceChecks(db); initDatabase(db); initDatabase(db);
    expect(db.prepare('SELECT * FROM resource_requests').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM resource_leases').all()).toEqual(leases);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(queries.getTodoById(todo.id)?.title).toBe('Existing');
    expect(queries.getSessionById(session.id)?.title).toBe('Existing session');
    const p = parent(), turn = running(p.id); expect(requestResource(p.id, turn.id, 'CPU', cpu).status).toBe('waiting');
  });

  it('automatic primary accounts may change between turns while each snapshot retains its account', async () => {
    const accounts = await import('../services/provider-account-service.js');
    for (const account of accounts.listProviderAccounts().filter(account => account.provider === 'claude')) accounts.saveProviderAccount({ is_enabled: false }, account.id);
    const a = accounts.saveProviderAccount({ provider: 'claude', slug: 'a', label: 'A', auth_strategy: 'environment_reference', auth_config: { variable: 'ACCOUNT_A' } });
    const b = accounts.saveProviderAccount({ provider: 'claude', slug: 'b', label: 'B', auth_strategy: 'environment_reference', auth_config: { variable: 'ACCOUNT_B' } });
    accounts.setAccountHealth(a.id, 'available');
    queries.updateExecutionProfile(profile.id, { executors: [{ cli_model_id: profile.executors[0].cli_model_id, effort_value: null, priority: 0, account_policy: 'automatic' }] });
    const p = parent();
    let calls = 0;
    const { service } = fakeService(async (id, turnId) => {
      if (++calls === 1) await callTool(id, turnId, 'yield', { idempotency_key: 'wait-account', reason: 'User', state_summary: '', current_plan: '', wake_on: { any: [{ type: 'user_message' }] } });
      else await callTool(id, turnId, 'finish', { idempotency_key: 'done-account', summary: 'Done', state_summary: 'Done' });
    });
    await service.initialize(); await service.start(p.id);
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('waiting_event'));
    accounts.saveProviderAccount({ is_enabled: false }, a.id); store.addMessage(p.id, 'Continue');
    await vi.waitFor(() => expect(store.getOrchestration(p.id).status).toBe('completed'));
    expect(store.turns(p.id).map(turn => JSON.parse(turn.execution_snapshot!).providerAccountId)).toEqual([a.id, b.id]);
  });
});
