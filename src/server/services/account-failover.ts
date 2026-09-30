import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import * as queries from '../db/queries.js';
import type { ResolvedExecutionConfig } from './execution-config.js';
import type { ProviderFailureClassification } from './failure-classifier.js';
import { providerQuotaService } from './provider-quota.js';
import { logger } from '../logging/logger.js';
import { broadcaster } from '../websocket/broadcaster.js';

export const QUOTA_RECOVERY_PROMPT = 'Previous attempt ended because provider account quota was exhausted. Continue the current phase from the existing workspace state. Do not assume the previous attempt made no changes. Inspect current files/tests first. For review, review the current artifact state.';
export function failoverLimit(): number {
  const value = Number(process.env.MAX_ACCOUNT_FAILOVERS_PER_PHASE ?? 3);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 8) : 3;
}
export function quotaChain(ownerType: 'todo' | 'orchestrator', ownerId: string): string | null {
  const table = ownerType === 'todo' ? 'todos' : 'orchestrator_turns';
  return (getDatabase().prepare(`SELECT quota_chain_id FROM ${table} WHERE id=?`).get(ownerId) as { quota_chain_id: string | null })?.quota_chain_id ?? null;
}
export function setQuotaChain(ownerType: 'todo' | 'orchestrator', ownerId: string, chainId: string | null): void {
  const table = ownerType === 'todo' ? 'todos' : 'orchestrator_turns';
  getDatabase().prepare(`UPDATE ${table} SET quota_chain_id=? WHERE id=?`).run(chainId, ownerId);
}
export function attemptedAccounts(ownerType: string, ownerId: string, chainId: string | null): string[] {
  if (!chainId) return [];
  return (getDatabase().prepare('SELECT from_account_id FROM account_failover_events WHERE owner_type=? AND owner_id=? AND chain_id=? ORDER BY created_at, attempt_index_from')
    .all(ownerType, ownerId, chainId) as { from_account_id: string }[]).map(row => row.from_account_id);
}
export function recordFailover(ownerType: string, ownerId: string, chainId: string, roundId: string, config: ResolvedExecutionConfig, classification: ProviderFailureClassification): boolean {
  const attempted = attemptedAccounts(ownerType, ownerId, chainId);
  if (!config.providerAccountId || attempted.includes(config.providerAccountId)) return false;
  getDatabase().prepare(`INSERT INTO account_failover_events
    (id,owner_type,owner_id,chain_id,round_id,from_account_id,provider,reason,classification,reset_at,attempt_index_from,created_at)
    VALUES (?,?,?,?,?,?,?,'account_quota_failover',?,?,?,?)`).run(randomUUID(), ownerType, ownerId, chainId, roundId,
      config.providerAccountId, config.cliTool, classification.category,
      providerQuotaService.getAccountQuotaState(config.providerAccountId).resetAt, attempted.length + 1, new Date().toISOString());
  logger.info('execution.account-failover.requested', { ownerType, ownerId, roundId, fromAccountId: config.providerAccountId, classification: classification.category, attempt: attempted.length + 1 });
  return attempted.length < failoverLimit();
}
export function bindFailoverTarget(ownerType: string, ownerId: string, chainId: string | null, accountId?: string | null): void {
  if (!chainId || !accountId) return;
  const result = getDatabase().prepare(`UPDATE account_failover_events SET to_account_id=?,attempt_index_to=attempt_index_from+1
    WHERE owner_type=? AND owner_id=? AND chain_id=? AND to_account_id IS NULL
    AND attempt_index_from=(SELECT MAX(attempt_index_from) FROM account_failover_events WHERE owner_type=? AND owner_id=? AND chain_id=?)`)
    .run(accountId, ownerType, ownerId, chainId, ownerType, ownerId, chainId);
  if (result.changes) logger.info('execution.account-failover.started', { ownerType, ownerId, toAccountId: accountId });
}
export function prepareTodoQuotaRetry(todoId: string, round: queries.TodoExecutionRound, config: ResolvedExecutionConfig, classification: ProviderFailureClassification, confirmedExitedPid = 0): queries.TodoExecutionRound | null {
  return getDatabase().transaction(() => {
    const todo = queries.getTodoById(todoId);
    const fresh = queries.getExecutionRoundById(round.id);
    if (!todo || ((todo.process_pid ?? 0) > 0 && todo.process_pid !== confirmedExitedPid) || todo.status !== 'running' || !fresh || fresh.status !== 'running') return null;
    const chain = quotaChain('todo', todoId) ?? round.id;
    queries.updateExecutionRound(round.id, { status: 'failed', error_message: `account_quota_failover: ${classification.category}`, finished_at: new Date().toISOString() });
    queries.updateTodo(todoId, { process_pid: 0, process_identity: null });
    providerQuotaService.markAccountExhausted(config.providerAccountId!, { source: 'runtime_rejection', reason: classification.reason, resetAt: classification.resetAt });
    setQuotaChain('todo', todoId, chain);
    if (config.accountPolicy === 'automatic' && !recordFailover('todo', todoId, chain, round.id, config, classification)) {
      queries.updateTodoStatus(todoId, 'failed');
      queries.createTaskLog(todoId, 'error', 'failover_budget_exhausted', round.round_index);
      return null;
    }
    const next = queries.createExecutionRound(todoId, round.phase, queries.getNextExecutionRoundIndex(todoId), randomUUID(), {
      status: 'pending', inputPayload: `${QUOTA_RECOVERY_PROMPT}\n\n${round.input_payload ?? todo.description ?? todo.title}`,
      retryOfRoundId: round.id, attemptIndex: (round.attempt_index ?? 1) + 1, artifactIdentity: round.artifact_identity,
    });
    queries.updateTodo(todoId, { execution_snapshot: null, pipeline_phase: round.phase });
    queries.updateTodoStatus(todoId, 'pending');
    queries.createTaskLog(todoId, 'warning', `quota exhausted; account_quota_failover: ${config.providerAccountLabel ?? config.providerAccountId} → fresh ${round.phase} attempt ${next.attempt_index}`, next.round_index);
    broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: queries.getExecutionRoundById(round.id)! });
    broadcaster.broadcast({ type: 'todo:round-created', todoId, round: next });
    return next;
  })();
}
