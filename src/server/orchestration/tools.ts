import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDatabase } from '../db/connection.js';
import * as queries from '../db/queries.js';
import { orchestrator as todoOrchestrator } from '../services/orchestrator.js';
import { getComputeNodes, resourceLeaseTotals, getResourceInstances } from '../services/resource-fabric.js';
import { logger } from '../logging/logger.js';
import * as store from './store.js';
import { requestResource, releaseResource, resourceSnapshot } from './resources.js';

const descriptions: Record<string, string> = {
  checkpoint_state: 'Persist an explicit work checkpoint and plan. Do not store hidden reasoning.',
  delegate_task: 'Create an ordinary asynchronous child Todo. Include self-contained instructions, constraints, expected artifact and validation. Does not wait for completion.',
  cancel_task: 'Stop an owned child through the safe Todo lifecycle.',
  request_resources: 'Request capability-based hardware. Returns waiting or acquired immediately. Hardware is reserved before wake, with a bounded claim window.',
  release_resources: 'Release an unclaimed reservation. Child-owned resources cannot be taken away.',
  yield: 'Terminal turn action. Persist checkpoint and ANY wake conditions, then end this turn. Do not poll or sleep.',
  finish: 'Terminal turn action. Complete the objective only after all children and resources are terminal/released.',
  get_task_status: 'Inspect bounded state for one owned child.', get_resource_request: 'Inspect one owned resource reservation.',
  list_execution_profiles: 'List enabled execution profiles and executor/model labels.', list_available_capabilities: 'Get an informational hardware snapshot without secrets. Allocation requires request_resources.',
};
export const toolDefinitions = Object.entries(store.toolSchemas).map(([name, schema]) => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(schema, { unrepresentable: 'any' }) }));
const locks = new Map<string, Promise<unknown>>();
export async function callTool(id: string, turnId: string, name: string, rawInput: unknown): Promise<unknown> {
  const previous = locks.get(id) ?? Promise.resolve();
  const action = previous.catch(() => undefined).then(() => performTool(id, turnId, name, rawInput));
  locks.set(id, action);
  try { return await action; } finally { if (locks.get(id) === action) locks.delete(id); }
}
async function performTool(id: string, turnId: string, name: string, rawInput: unknown): Promise<unknown> {
  const schema = store.toolSchemas[name as keyof typeof store.toolSchemas];
  if (!schema) throw new Error('unknown_tool');
  const input = schema.parse(rawInput);
  const turn = store.getTurn(turnId), parent = store.getOrchestration(id);
  if (!turn || turn.orchestrator_id !== id || turn.status !== 'running' || ['paused','cancelling','cancelled','completed','failed'].includes(parent.status)) throw new Error('expired_turn');
  if (!('idempotency_key' in input)) {
    if (name === 'get_task_status') return store.childStatus(id, (input as { child_job_id: string }).child_job_id);
    if (name === 'get_resource_request') return resourceSnapshot(store.getHold(id, (input as { request_id: string }).request_id));
    if (name === 'list_execution_profiles') return queries.getExecutionProfiles().slice(0, 64).map(profile => ({ id: profile.id, name: profile.name, description: profile.description?.slice(0, 512), enabled: !!profile.is_enabled,
      candidates: profile.executors.slice(0, 16).map(executor => ({ executor: executor.cli_tool, model: executor.model_value, label: executor.model_label, enabled: !!executor.is_enabled })) }));
    const leased = resourceLeaseTotals();
    return getComputeNodes().slice(0, 32).map(node => ({ name: node.name, platform: node.inventory?.platform, capabilities: { ...node.inventory?.capabilities, ...node.policy.capability_overrides }, scheduler_state: node.scheduler_state,
      allocatable_cpu: Math.max(0, (node.inventory?.cpu.logical_threads ?? 0) - node.policy.cpu_reserve_threads - (leased[`node/${node.id}/cpu`] ?? 0)),
      allocatable_memory: Math.max(0, (node.inventory?.memory.total_bytes ?? 0) - node.policy.memory_reserve_bytes - (leased[`node/${node.id}/memory`] ?? 0)),
      gpus: getResourceInstances(node.id).filter(item => item.kind === 'gpu' && item.present && item.policy === 'enabled').map(item => ({ model: item.model, vram_bytes: item.vram_bytes, available: !(leased[item.id] ?? 0) })),
    }));
  }
  const key = input.idempotency_key, inputHash = store.hash({ name, input });
  const db = getDatabase();
  const previous = db.prepare('SELECT input_hash, result_json FROM orchestrator_operations WHERE orchestrator_id = ? AND idempotency_key = ?').get(id, key) as { input_hash: string; result_json: string } | undefined;
  if (previous) {
    if (previous.input_hash !== inputHash) throw new Error('idempotency_conflict');
    if (name === 'yield' || name === 'finish') {
      if (turn.terminal_action && turn.terminal_action !== name) throw new Error('turn_already_terminal');
      if (name === 'finish' && store.activeChildren(id).length) throw new Error('active_children');
      if (name === 'finish' && store.holds(id).some(hold => ['bound','waiting','claimed'].includes(hold.status))) throw new Error('active_resource_requests');
      store.updateTurn(turnId, { terminal_action: name });
    }
    return JSON.parse(previous.result_json);
  }
  if (turn.terminal_action) throw new Error('turn_already_terminal');
  if ((db.prepare('SELECT COUNT(*) AS count FROM orchestrator_operations WHERE turn_id = ?').get(turnId) as { count: number }).count >= 64) throw new Error('mutating_operation_budget_exhausted');
  if (name === 'cancel_task') {
    const args = store.toolSchemas.cancel_task.parse(input);
    const job = store.childStatus(id, args.child_job_id);
    try { await todoOrchestrator.stopTodo(job.todo_id); }
    catch (error) { if (!queries.getTodoById(job.todo_id)?.process_pid) throw error; }
  }
  return db.transaction(() => {
    const fresh = store.getTurn(turnId);
    if (fresh.status !== 'running' || fresh.terminal_action) throw new Error('expired_turn');
    let result: unknown;
    if (name === 'checkpoint_state') {
      const args = store.toolSchemas.checkpoint_state.parse(input);
      store.updateOrchestration(id, { state_summary: args.state_summary, current_plan: args.current_plan }); result = { status: 'saved' };
    } else if (name === 'delegate_task') {
      const args = store.toolSchemas.delegate_task.parse(input);
      store.validateProfile(args.execution_profile_id);
      if (parent.child_count >= parent.max_children) throw new Error('child_budget_exhausted');
      if (store.activeChildren(id).length >= parent.max_concurrent_children) throw new Error('child_concurrency_limit');
      const project = queries.getProjectById(parent.project_id)!;
      const hold = args.resource_request_id ? store.getHold(id, args.resource_request_id) : null;
      if (hold && (hold.status !== 'bound' || !hold.claim_expires_at || hold.claim_expires_at <= store.now() || db.prepare('SELECT id FROM orchestrator_child_jobs WHERE resource_request_id = ?').get(hold.id))) throw new Error('resource_not_claimable');
      if (args.review?.enabled) store.validateProfile(args.review.review_profile_id ?? project.default_review_profile_id ?? '');
      if (args.review?.rework_profile_id) store.validateProfile(args.review.rework_profile_id);
      const todo = queries.createTodo(parent.project_id, args.title, args.instructions, 0, undefined, undefined, undefined, undefined,
        args.max_turns, args.use_worktree === undefined ? project.is_git_repo ? 1 : 0 : args.use_worktree ? 1 : 0,
        'none', null, null, undefined, args.execution_profile_id, null, null,
        hold?.requirements_json ?? JSON.stringify(args.resources ?? []), args.review?.enabled ? 1 : 0,
        args.review?.review_profile_id, args.review?.rework_profile_id, args.review?.max_rounds);
      const childId = randomUUID();
      db.prepare('INSERT INTO orchestrator_child_jobs VALUES (?,?,?,?,?,?,?)').run(childId, id, todo.id, args.title, turnId, hold?.id ?? null, store.now());
      store.updateOrchestration(id, { child_count: parent.child_count + 1 });
      result = { child_job_id: childId, todo_id: todo.id, status: 'queued' };
      store.publish('child-updated', id);
      logger.info('orchestrator.child.created', { orchestratorId: id, turnId, childJobId: childId, todoId: todo.id });
      setImmediate(() => todoOrchestrator.startTodo(todo.id).catch(error => {
        const current = queries.getTodoById(todo.id);
        if (current && !current.process_pid && current.status === 'pending') { queries.updateTodoStatus(todo.id, 'failed'); queries.createTaskLog(todo.id, 'error', String(error).slice(0, 1024)); }
      }));
    } else if (name === 'cancel_task') {
      const args = store.toolSchemas.cancel_task.parse(input);
      const child = store.childStatus(id, args.child_job_id);
      result = { child_job_id: child.id, status: child.process_pid ? 'unresolved' : child.status };
    } else if (name === 'request_resources') {
      const args = store.toolSchemas.request_resources.parse(input);
      result = resourceSnapshot(requestResource(id, turnId, args.purpose, args.requirements));
    } else if (name === 'release_resources') {
      const args = store.toolSchemas.release_resources.parse(input);
      releaseResource(id, args.request_id); result = resourceSnapshot(store.getHold(id, args.request_id));
    } else if (name === 'yield') {
      const args = store.toolSchemas.yield.parse(input);
      for (const condition of args.wake_on.any) {
        if (condition.type === 'child_terminal') store.childStatus(id, condition.child_job_id);
        if (condition.type === 'resource_request') store.getHold(id, condition.request_id);
      }
      store.updateOrchestration(id, { state_summary: args.state_summary, current_plan: args.current_plan, waiting_reason: args.reason, wake_condition_json: JSON.stringify(args.wake_on) });
      store.updateTurn(turnId, { terminal_action: 'yield' }); result = { status: 'yield_accepted', end_turn: true };
      logger.info('orchestrator.yield', { orchestratorId: id, turnId });
    } else if (name === 'finish') {
      const args = store.toolSchemas.finish.parse(input);
      if (store.activeChildren(id).length) throw new Error('active_children');
      if (store.holds(id).some(hold => ['bound', 'waiting', 'claimed'].includes(hold.status))) throw new Error('active_resource_requests');
      store.updateOrchestration(id, { state_summary: args.state_summary });
      store.addMessage(id, args.summary, 'assistant', turnId);
      store.updateTurn(turnId, { terminal_action: 'finish' }); result = { status: 'finish_accepted', end_turn: true };
    }
    db.prepare('INSERT INTO orchestrator_operations VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), id, turnId, key, name, inputHash, JSON.stringify(result), store.now());
    store.publish('status-changed', id);
    return result;
  }).immediate();
}
