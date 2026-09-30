import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { getDatabase } from '../db/connection.js';
import * as queries from '../db/queries.js';
import { canonicalJson, requirementsSchema } from '../services/resource-requirements.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { logger } from '../logging/logger.js';

export const orchestrationSignals = new EventEmitter();
export const now = () => new Date().toISOString();
export const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const bounded = (bytes: number) => z.string().refine(value => Buffer.byteLength(value, 'utf8') <= bytes, 'payload_too_large');
const identifier = z.string().uuid();
export const createSchema = z.object({
  title: z.string().trim().min(1).max(256), objective: bounded(32768).refine(value => value.trim().length > 0),
  primary_execution_profile_id: identifier,
  max_turns: z.number().int().min(1).max(128).default(32),
  max_children: z.number().int().min(1).max(100).default(24),
  max_concurrent_children: z.number().int().min(1).max(16).default(4),
  max_active_resource_requests: z.number().int().min(1).max(8).default(2),
}).strict();
export const patchSchema = createSchema.partial();
export type Orchestration = z.infer<typeof createSchema> & {
  id: string; project_id: string; status: string; state_summary: string; current_plan: string;
  waiting_reason: string | null; wake_condition_json: string | null; turn_count: number; child_count: number;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
};
export interface Turn {
  id: string; orchestrator_id: string; turn_index: number; status: string; trigger_type: string;
  process_pid: number; process_identity: string | null; terminal_action: 'yield' | 'finish' | null;
  retry_count: number; execution_snapshot: string | null; error_message: string | null;
}
export interface InboxEvent {
  id: string; orchestrator_id: string; type: string; source_id: string; payload_json: string;
  assigned_turn_id: string | null; consumed_at: string | null; created_at: string;
}
export interface ChildJob {
  id: string; orchestrator_id: string; todo_id: string; resource_request_id: string | null;
  purpose: string; created_by_turn_id: string;
}
export interface Hold {
  id: string; orchestrator_id: string; purpose: string; status: string; run_token: string;
  requirements_json: string; claim_expires_at: string | null; claimed_todo_id: string | null;
  reasons_json: string; binding_json: string | null;
  created_at: string;
}
export const terminalStatuses = ['completed', 'failed', 'cancelled'];
export function getOrchestration(id: string): Orchestration {
  const row = getDatabase().prepare('SELECT * FROM orchestrators WHERE id = ?').get(id) as Orchestration | undefined;
  if (!row) throw new Error('orchestrator_not_found');
  return row;
}
export function listOrchestrations(projectId?: string): Orchestration[] {
  return getDatabase().prepare(`SELECT * FROM orchestrators ${projectId ? 'WHERE project_id = ?' : ''} ORDER BY created_at, id`).all(...(projectId ? [projectId] : [])) as Orchestration[];
}
export function validateProfile(id: string, primary = false): void {
  const profile = queries.getExecutionProfileById(id);
  if (!profile?.is_enabled || !profile.executors.some(candidate => candidate.is_enabled && (!primary || candidate.cli_tool === 'claude'))) throw new Error(primary ? 'claude_primary_profile_required' : 'enabled_execution_profile_required');
}
export function createOrchestration(projectId: string, input: unknown): Orchestration {
  if (!queries.getProjectById(projectId)) throw new Error('project_not_found');
  const data = createSchema.parse(input);
  validateProfile(data.primary_execution_profile_id, true);
  const id = randomUUID(), timestamp = now();
  const keys = Object.keys(data);
  getDatabase().prepare(`INSERT INTO orchestrators (id, project_id, ${keys.join(',')}, created_at, updated_at) VALUES (${Array(keys.length + 4).fill('?').join(',')})`).run(id, projectId, ...Object.values(data), timestamp, timestamp);
  publish('created', id);
  logger.info('orchestrator.created', { orchestratorId: id, projectId });
  return getOrchestration(id);
}
export function updateOrchestration(id: string, updates: Partial<Orchestration>): void {
  const entries = Object.entries({ ...updates, updated_at: now() });
  getDatabase().prepare(`UPDATE orchestrators SET ${entries.map(([key]) => `${key} = ?`).join(',')} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
}
export function publish(type: string, id: string): void {
  const row = getOrchestration(id);
  broadcaster.broadcast({ type: `orchestrator:${type}` as 'orchestrator:status-changed', orchestratorId: id, projectId: row.project_id });
}
export function addEvent(id: string, type: string, sourceType: string, sourceId: string, dedupeKey: string, payload: unknown): boolean {
  const json = canonicalJson(payload);
  bounded(16384).parse(json);
  const result = getDatabase().prepare('INSERT OR IGNORE INTO orchestrator_events (id, orchestrator_id, type, source_type, source_id, dedupe_key, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), id, type, sourceType, sourceId, dedupeKey, json, now());
  if (result.changes) { publish('event', id); queueMicrotask(() => orchestrationSignals.emit('wake')); }
  return result.changes > 0;
}
export function addMessage(id: string, content: string, role = 'user', turnId: string | null = null): string {
  getOrchestration(id);
  bounded(role === 'assistant' ? 32768 : 16384).parse(content);
  if (!content.trim()) throw new Error('empty_message');
  const messageId = randomUUID();
  getDatabase().transaction(() => {
    getDatabase().prepare('INSERT INTO orchestrator_messages VALUES (?,?,?,?,?,?)').run(messageId, id, turnId, role, content, now());
    if (role === 'user') addEvent(id, 'user.message', 'message', messageId, `message:${messageId}`, { message_id: messageId, content });
  }).immediate();
  publish('message', id);
  return messageId;
}
export function children(id: string): ChildJob[] {
  return getDatabase().prepare('SELECT * FROM orchestrator_child_jobs WHERE orchestrator_id = ? ORDER BY created_at, id').all(id) as ChildJob[];
}
export function childStatus(id: string, childId: string) {
  const job = children(id).find(row => row.id === childId);
  if (!job) throw new Error('unknown_child');
  const todo = queries.getTodoById(job.todo_id)!;
  const snapshot = todo.execution_snapshot ? JSON.parse(todo.execution_snapshot) : null;
  const profile = todo.execution_profile_id ? queries.getExecutionProfileById(todo.execution_profile_id) : null;
  const latestError = (getDatabase().prepare("SELECT substr(message, -2048) AS message FROM task_logs WHERE todo_id = ? AND log_type = 'error' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(todo.id) as { message: string } | undefined)?.message;
  return { ...job, title: todo.title, status: todo.status, pipeline_phase: todo.pipeline_phase, summary: todo.summary?.slice(0, 2048),
    diff_files: todo.diff_files, diff_lines: todo.diff_lines, branch_name: todo.branch_name, worktree_path: todo.worktree_path,
    process_pid: todo.process_pid, execution_profile_id: todo.execution_profile_id,
    execution_profile_name: profile?.name, executor: snapshot?.agent, model: snapshot?.effectiveModel ?? snapshot?.model,
    resource_binding: snapshot?.resourceBinding ? { id: snapshot.resourceBinding.id, capacity: snapshot.resourceBinding.capacity, transport: snapshot.resourceBinding.transport } : null,
    latest_error: latestError?.slice(-2048), execution_snapshot: snapshot };
}
export function activeChildren(id: string): ChildJob[] {
  return children(id).filter(job => { const todo = queries.getTodoById(job.todo_id)!; return !!todo.process_pid || !['completed', 'failed', 'stopped', 'merged'].includes(todo.status); });
}
export function holds(id: string): Hold[] {
  return getDatabase().prepare(`SELECT o.*, r.status, r.run_token, r.requirements_json, r.reasons_json, b.binding_json
    FROM orchestrator_resource_requests o JOIN resource_requests r ON r.id = o.id LEFT JOIN resource_bindings b ON b.request_id = r.id WHERE o.orchestrator_id = ? ORDER BY o.created_at, o.id`).all(id) as Hold[];
}
export function getHold(id: string, requestId: string): Hold {
  const hold = holds(id).find(row => row.id === requestId);
  if (!hold) throw new Error('unknown_resource_request');
  return hold;
}
export function events(id: string): InboxEvent[] {
  return getDatabase().prepare('SELECT * FROM orchestrator_events WHERE orchestrator_id = ? ORDER BY created_at, id').all(id) as InboxEvent[];
}
export function turns(id: string): Turn[] { return getDatabase().prepare('SELECT * FROM orchestrator_turns WHERE orchestrator_id = ? ORDER BY turn_index').all(id) as Turn[]; }
export function getTurn(id: string): Turn { return getDatabase().prepare('SELECT * FROM orchestrator_turns WHERE id = ?').get(id) as Turn; }
export function updateTurn(id: string, updates: Record<string, unknown>): void {
  const entries = Object.entries(updates);
  getDatabase().prepare(`UPDATE orchestrator_turns SET ${entries.map(([key]) => `${key} = ?`).join(',')} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
}
export const wakeSchema = z.object({ any: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('child_terminal'), child_job_id: identifier }).strict(),
  z.object({ type: z.literal('resource_request'), request_id: identifier }).strict(),
  z.object({ type: z.literal('user_message') }).strict(),
])).min(1).max(108) }).strict();
export function matches(event: InboxEvent, orchestration: Orchestration): boolean {
  if (event.type === 'user.message' || event.type === 'system.resumed') return true;
  if (!orchestration.wake_condition_json) return true;
  return wakeSchema.parse(JSON.parse(orchestration.wake_condition_json)).any.some(condition =>
    condition.type === 'child_terminal' ? event.type.startsWith('child.') && condition.child_job_id === event.source_id :
      condition.type === 'resource_request' ? event.type.startsWith('resource.') && condition.request_id === event.source_id : event.type === 'user.message');
}
export function requestTurn(id: string, trigger = 'event', retry = 0): Turn | null {
  return getDatabase().transaction(() => {
    const orchestration = getOrchestration(id);
    const active = turns(id).find(turn => turn.process_pid > 0 || ['pending', 'waiting_executor', 'waiting_quota', 'starting', 'running'].includes(turn.status));
    if (active || terminalStatuses.includes(orchestration.status) || ['paused', 'cancelling'].includes(orchestration.status)) return null;
    if (orchestration.turn_count >= orchestration.max_turns) {
      updateOrchestration(id, { status: 'paused', waiting_reason: 'turn_budget_exhausted' });
      addEvent(id, 'system.budget_warning', 'budget', id, `budget:turns:${orchestration.max_turns}`, { reason: 'turn_budget_exhausted', max_turns: orchestration.max_turns });
      publish('status-changed', id); return null;
    }
    const pending = events(id).filter(event => !event.consumed_at && !event.assigned_turn_id && matches(event, orchestration));
    if (trigger === 'event' && !pending.length) return null;
    const turnId = randomUUID();
    getDatabase().prepare(`INSERT INTO orchestrator_turns (id, orchestrator_id, turn_index, status, trigger_type, retry_count, created_at) VALUES (?,?,?,'pending',?,?,?)`).run(turnId, id, orchestration.turn_count + 1, trigger, retry, now());
    for (const event of pending.slice(0, 64)) getDatabase().prepare('UPDATE orchestrator_events SET assigned_turn_id = ? WHERE id = ?').run(turnId, event.id);
    updateOrchestration(id, { turn_count: orchestration.turn_count + 1, status: 'pending' });
    logger.info('orchestrator.turn.requested', { orchestratorId: id, turnId, trigger });
    return getTurn(turnId);
  }).immediate();
}
export function reconcileChildren(): void {
  const jobs = getDatabase().prepare('SELECT * FROM orchestrator_child_jobs').all() as ChildJob[];
  for (const job of jobs) {
    const todo = queries.getTodoById(job.todo_id)!;
    if (todo.process_pid || !['completed', 'failed', 'stopped', 'merged'].includes(todo.status)) continue;
    const type = todo.status === 'merged' ? 'completed' : todo.status;
    const inserted = addEvent(job.orchestrator_id, `child.${type}`, 'child', job.id, `child:${job.id}:${todo.status}:${queries.getLatestExecutionRound(todo.id)?.id ?? todo.round_count}`, {
      child_job_id: job.id, todo_id: todo.id, title: todo.title.slice(0, 256), status: todo.status,
      summary: todo.summary?.slice(0, 2048), pipeline_phase: todo.pipeline_phase, diff_files: todo.diff_files, diff_lines: todo.diff_lines,
    });
    if (inserted) {
      publish('child-updated', job.orchestrator_id);
      logger.info('orchestrator.child.terminal', { orchestratorId: job.orchestrator_id, childJobId: job.id, todoId: todo.id, status: todo.status });
    }
  }
}
export const agentRequirements = requirementsSchema.refine(value => [value.requires, value.prefers].every(part => !part.node_id && !(part.resources ?? []).some(item => item.key)), 'concrete_resource_ids_forbidden');
const operationKey = z.string().min(1).max(128);
export const toolSchemas = {
  checkpoint_state: z.object({ idempotency_key: operationKey, state_summary: bounded(16384), current_plan: bounded(16384) }).strict(),
  delegate_task: z.object({ idempotency_key: operationKey, title: z.string().min(1).max(256), instructions: bounded(32768).refine(value => value.trim().length > 0), execution_profile_id: identifier,
    use_worktree: z.boolean().optional(), max_turns: z.number().int().min(1).max(128).default(20),
    review: z.object({ enabled: z.boolean(), review_profile_id: identifier.optional(), rework_profile_id: identifier.optional(), max_rounds: z.number().int().min(1).max(10).default(2) }).strict().optional(),
    resources: agentRequirements.optional(), resource_request_id: identifier.optional(),
  }).strict().refine(value => !(value.resources && value.resource_request_id), 'resource_requirement_conflict'),
  cancel_task: z.object({ idempotency_key: operationKey, child_job_id: identifier }).strict(),
  request_resources: z.object({ idempotency_key: operationKey, purpose: bounded(2048), requirements: agentRequirements }).strict(),
  release_resources: z.object({ idempotency_key: operationKey, request_id: identifier }).strict(),
  yield: z.object({ idempotency_key: operationKey, reason: bounded(2048), state_summary: bounded(16384), current_plan: bounded(16384), wake_on: wakeSchema }).strict(),
  finish: z.object({ idempotency_key: operationKey, summary: bounded(32768).refine(value => value.trim().length > 0), state_summary: bounded(16384) }).strict(),
  get_task_status: z.object({ child_job_id: identifier }).strict(),
  get_resource_request: z.object({ request_id: identifier }).strict(),
  list_execution_profiles: z.object({}).strict(), list_available_capabilities: z.object({}).strict(),
};
