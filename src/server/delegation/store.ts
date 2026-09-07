import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/connection.js';

export type DelegationMode = 'disabled' | 'telemetry' | 'suggest' | 'enforce_bulk_read';
export type DelegationRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'recovery_required';

export interface ParentExecutionRow {
  id: string;
  owner_type: 'todo';
  owner_id: string;
  work_dir: string;
  execution_snapshot: string;
  provider: string;
  model: string | null;
  effective_model: string | null;
  policy_mode: DelegationMode;
  capability_hash: string;
  status: string;
  process_pid: number | null;
  process_identity: string | null;
}

export interface DelegationRunRow {
  id: string;
  parent_execution_id: string;
  parent_owner_id: string;
  status: DelegationRunStatus;
  execution_snapshot: string | null;
  process_pid: number | null;
  process_identity: string | null;
  source_path_relative: string;
  source_sha256: string;
  finished_at?: string | null;
}

export interface DelegationProcessOwnership {
  pid: number;
  processIdentity: string | null;
}

export const hashCapability = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
export const hashPath = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export function createParentExecution(input: {
  id?: string;
  ownerId: string;
  workDir: string;
  executionSnapshot: unknown;
  provider: string;
  model?: string | null;
  effectiveModel?: string | null;
  policyMode: DelegationMode;
  capability: string;
}): ParentExecutionRow {
  const id = input.id ?? uuidv4();
  getDatabase().prepare(`INSERT INTO delegation_parent_executions
    (id, owner_type, owner_id, work_dir, execution_snapshot, provider, model, effective_model, policy_mode, capability_hash)
    VALUES (?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.ownerId, input.workDir, JSON.stringify(input.executionSnapshot), input.provider,
      input.model ?? null, input.effectiveModel ?? null, input.policyMode, hashCapability(input.capability),
    );
  return getParentExecution(id)!;
}

export function getParentExecution(id: string): ParentExecutionRow | undefined {
  return getDatabase().prepare('SELECT * FROM delegation_parent_executions WHERE id = ?').get(id) as ParentExecutionRow | undefined;
}

export function authenticateParentExecution(id: string, capability: string): ParentExecutionRow | undefined {
  const row = getParentExecution(id);
  if (!row || !capability) return undefined;
  const expected = Buffer.from(row.capability_hash, 'hex');
  const actual = Buffer.from(hashCapability(capability), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? row : undefined;
}

export function updateParentExecution(id: string, updates: {
  status?: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  processPid?: number | null;
  processIdentity?: string | null;
  finished?: boolean;
}): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.processPid !== undefined) { fields.push('process_pid = ?'); values.push(updates.processPid); }
  if (updates.processIdentity !== undefined) { fields.push('process_identity = ?'); values.push(updates.processIdentity); }
  if (updates.finished) fields.push('finished_at = CURRENT_TIMESTAMP');
  if (!fields.length) return;
  values.push(id);
  getDatabase().prepare(`UPDATE delegation_parent_executions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function recordObservation(input: {
  parentExecution: ParentExecutionRow;
  toolName: string;
  operationType: string;
  sourcePathRelative?: string | null;
  requestedOffset?: number | null;
  requestedLimit?: number | null;
  fileSize?: number | null;
  commandKind?: string | null;
  commandRawLength?: number | null;
  commandHash?: string | null;
  decision: string;
  decisionReason: string;
  hookLatencyMs: number;
  managedDefinitionHash?: string | null;
}): string {
  const id = uuidv4();
  getDatabase().prepare(`INSERT INTO delegation_tool_observations
    (id, parent_execution_id, parent_provider, parent_model, parent_effective_model, tool_name,
     operation_type, source_path_relative, requested_offset, requested_limit, file_size, command_kind,
     command_raw_length, command_hash, policy_mode, decision, decision_reason, hook_latency_ms,
     managed_definition_hash, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.parentExecution.id, input.parentExecution.provider, input.parentExecution.model,
      input.parentExecution.effective_model, input.toolName, input.operationType,
      input.sourcePathRelative ?? null, input.requestedOffset ?? null, input.requestedLimit ?? null,
      input.fileSize ?? null, input.commandKind ?? null, input.commandRawLength ?? null,
      input.commandHash ?? null, input.parentExecution.policy_mode, input.decision,
      input.decisionReason, input.hookLatencyMs, input.managedDefinitionHash ?? null, new Date().toISOString(),
    );
  return id;
}

export function createDelegationRun(input: {
  id?: string;
  parent: ParentExecutionRow;
  executionProfileId: string;
  sourcePathRelative: string;
  sourceSha256: string;
  sourceBytes: number;
  sourceChars: number;
  sourceLines: number;
  queryHash: string;
  queryLength: number;
}): string {
  const id = input.id ?? uuidv4();
  getDatabase().prepare(`INSERT INTO delegation_runs
    (id, parent_execution_id, parent_owner_type, parent_owner_id, operation, status,
     execution_profile_id, source_path_relative, source_sha256, source_bytes, source_chars,
     source_lines, query_hash, query_length)
    VALUES (?, ?, ?, ?, 'bulk_read', 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.parent.id, input.parent.owner_type, input.parent.owner_id, input.executionProfileId,
      input.sourcePathRelative, input.sourceSha256, input.sourceBytes, input.sourceChars,
      input.sourceLines, input.queryHash, input.queryLength,
    );
  return id;
}

export function updateDelegationRun(id: string, updates: {
  status?: DelegationRunStatus;
  executionSnapshot?: unknown;
  processPid?: number | null;
  processIdentity?: string | null;
  latencyMs?: number;
  workerInputTokens?: number | null;
  workerOutputTokens?: number | null;
  returnedChars?: number | null;
  contextAvoidedChars?: number | null;
  errorCode?: string | null;
  errorDetailBounded?: string | null;
  fallbackGranted?: boolean;
  finished?: boolean;
}): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  const put = (column: string, value: unknown) => { fields.push(`${column} = ?`); values.push(value); };
  if (updates.status !== undefined) put('status', updates.status);
  if (updates.executionSnapshot !== undefined) put('execution_snapshot', JSON.stringify(updates.executionSnapshot));
  if (updates.processPid !== undefined) put('process_pid', updates.processPid);
  if (updates.processIdentity !== undefined) put('process_identity', updates.processIdentity);
  if (updates.latencyMs !== undefined) put('latency_ms', updates.latencyMs);
  if (updates.workerInputTokens !== undefined) put('worker_input_tokens', updates.workerInputTokens);
  if (updates.workerOutputTokens !== undefined) put('worker_output_tokens', updates.workerOutputTokens);
  if (updates.returnedChars !== undefined) put('returned_chars', updates.returnedChars);
  if (updates.contextAvoidedChars !== undefined) put('context_avoided_chars', updates.contextAvoidedChars);
  if (updates.errorCode !== undefined) put('error_code', updates.errorCode);
  if (updates.errorDetailBounded !== undefined) put('error_detail_bounded', updates.errorDetailBounded?.slice(0, 1000) ?? null);
  if (updates.fallbackGranted !== undefined) put('fallback_granted', updates.fallbackGranted ? 1 : 0);
  if (updates.finished) fields.push('finished_at = CURRENT_TIMESTAMP');
  if (!fields.length) return;
  values.push(id);
  getDatabase().prepare(`UPDATE delegation_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function adoptDelegationRunProcess(
  id: string,
  ownership: DelegationProcessOwnership,
): 'running' | 'cancelled' | 'superseded' {
  return getDatabase().transaction(() => {
    const current = getDelegationRun(id);
    if (!current || current.process_pid !== null) return 'superseded' as const;
    const nextStatus = current.status === 'starting' ? 'running' : 'cancelled';
    const changed = getDatabase().prepare(`UPDATE delegation_runs
      SET status = ?, process_pid = ?, process_identity = ?, finished_at = NULL
      WHERE id = ? AND status = ? AND process_pid IS NULL`).run(
        nextStatus, ownership.pid, ownership.processIdentity, id, current.status,
      ).changes;
    return changed === 1 ? nextStatus : 'superseded';
  })();
}

export function updateOwnedDelegationRun(
  id: string,
  ownership: DelegationProcessOwnership,
  expectedStatuses: readonly DelegationRunStatus[],
  updates: {
    status?: DelegationRunStatus;
    processPid?: number | null;
    processIdentity?: string | null;
    latencyMs?: number;
    errorCode?: string | null;
    errorDetailBounded?: string | null;
    fallbackGranted?: boolean;
    finished?: boolean;
  },
): boolean {
  if (!expectedStatuses.length) return false;
  const fields: string[] = [];
  const values: unknown[] = [];
  const put = (column: string, value: unknown) => { fields.push(`${column} = ?`); values.push(value); };
  if (updates.status !== undefined) put('status', updates.status);
  if (updates.processPid !== undefined) put('process_pid', updates.processPid);
  if (updates.processIdentity !== undefined) put('process_identity', updates.processIdentity);
  if (updates.latencyMs !== undefined) put('latency_ms', updates.latencyMs);
  if (updates.errorCode !== undefined) put('error_code', updates.errorCode);
  if (updates.errorDetailBounded !== undefined) put('error_detail_bounded', updates.errorDetailBounded?.slice(0, 1000) ?? null);
  if (updates.fallbackGranted !== undefined) put('fallback_granted', updates.fallbackGranted ? 1 : 0);
  if (updates.finished) fields.push('finished_at = CURRENT_TIMESTAMP');
  if (!fields.length) return false;
  const placeholders = expectedStatuses.map(() => '?').join(', ');
  values.push(id, ownership.pid, ownership.processIdentity, ...expectedStatuses);
  return getDatabase().prepare(`UPDATE delegation_runs SET ${fields.join(', ')}
    WHERE id = ? AND process_pid = ? AND process_identity IS ? AND status IN (${placeholders})`).run(...values).changes === 1;
}

export function getDelegationRun(id: string): DelegationRunRow | undefined {
  return getDatabase().prepare('SELECT * FROM delegation_runs WHERE id = ?').get(id) as DelegationRunRow | undefined;
}

export function getDelegationRunsWithPersistedProcess(): DelegationRunRow[] {
  return getDatabase().prepare(
    'SELECT * FROM delegation_runs WHERE process_pid IS NOT NULL AND process_pid > 0'
  ).all() as DelegationRunRow[];
}

export function getActiveDelegationRunsForOwner(ownerId: string): DelegationRunRow[] {
  return getDatabase().prepare(
    "SELECT * FROM delegation_runs WHERE parent_owner_id = ? AND status IN ('starting', 'running', 'recovery_required')"
  ).all(ownerId) as DelegationRunRow[];
}

export function getActiveDelegationUsage(provider: string): number {
  const rows = getDatabase().prepare(`SELECT execution_snapshot FROM delegation_runs
    WHERE process_pid IS NOT NULL AND process_pid > 0`).all() as Array<{ execution_snapshot: string | null }>;
  return rows.reduce((count, row) => {
    if (!row.execution_snapshot) return count;
    try { return JSON.parse(row.execution_snapshot)?.agent === provider ? count + 1 : count; }
    catch { return count; }
  }, 0);
}

export function grantFallback(parentExecutionId: string, canonicalPath: string, sourceSha256: string, ttlMs = 60_000): void {
  getDatabase().prepare(`INSERT INTO delegation_fallback_grants
    (id, parent_execution_id, canonical_path_hash, source_sha256, expires_at)
    VALUES (?, ?, ?, ?, ?)`).run(
      uuidv4(), parentExecutionId, hashPath(canonicalPath), sourceSha256,
      new Date(Date.now() + ttlMs).toISOString(),
    );
}

export function consumeFallback(parentExecutionId: string, canonicalPath: string, sourceSha256: string): boolean {
  const db = getDatabase();
  const row = db.prepare(`SELECT id FROM delegation_fallback_grants
    WHERE parent_execution_id = ? AND canonical_path_hash = ? AND source_sha256 = ?
      AND uses_remaining > 0 AND expires_at > ? ORDER BY created_at LIMIT 1`).get(
        parentExecutionId, hashPath(canonicalPath), sourceSha256, new Date().toISOString(),
      ) as { id: string } | undefined;
  if (!row) return false;
  return db.prepare('UPDATE delegation_fallback_grants SET uses_remaining = uses_remaining - 1 WHERE id = ? AND uses_remaining > 0').run(row.id).changes === 1;
}

export function cleanupDelegationTelemetry(retentionDays: number): number {
  const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000).toISOString();
  const db = getDatabase();
  const observations = db.prepare('DELETE FROM delegation_tool_observations WHERE created_at < ?').run(cutoff).changes;
  const runs = db.prepare(`DELETE FROM delegation_runs
    WHERE started_at < ? AND process_pid IS NULL AND status NOT IN ('running', 'recovery_required')`).run(cutoff).changes;
  const grants = db.prepare('DELETE FROM delegation_fallback_grants WHERE expires_at < ? OR uses_remaining <= 0').run(new Date().toISOString()).changes;
  const parents = db.prepare(`DELETE FROM delegation_parent_executions
    WHERE finished_at IS NOT NULL AND finished_at < ? AND process_pid IS NULL
      AND status IN ('completed', 'failed', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM delegation_runs WHERE parent_execution_id = delegation_parent_executions.id)
      AND NOT EXISTS (SELECT 1 FROM delegation_tool_observations WHERE parent_execution_id = delegation_parent_executions.id)
      AND NOT EXISTS (SELECT 1 FROM delegation_fallback_grants WHERE parent_execution_id = delegation_parent_executions.id)`).run(cutoff).changes;
  return observations + runs + grants + parents;
}

export function getDelegationStatistics(ownerId?: string) {
  const db = getDatabase();
  const ownerWhere = ownerId ? ' WHERE p.owner_id = ?' : '';
  const args = ownerId ? [ownerId] : [];
  const observed = db.prepare(`SELECT
      COUNT(*) AS toolObservations,
      SUM(CASE WHEN o.decision_reason IN ('bulk_read_suggested', 'bulk_read_required', 'telemetry_only') AND o.file_size IS NOT NULL THEN 1 ELSE 0 END) AS largeReadsObserved,
      AVG(o.hook_latency_ms) AS averageHookLatencyMs
    FROM delegation_tool_observations o JOIN delegation_parent_executions p ON p.id = o.parent_execution_id${ownerWhere}`).get(...args) as Record<string, number | null>;
  const runs = db.prepare(`SELECT
      COUNT(*) AS bulkReadRuns,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS bulkReadSucceeded,
      SUM(r.fallback_granted) AS fallbacks,
      SUM(r.source_chars) AS sourceCharsProcessed,
      SUM(r.returned_chars) AS returnedChars,
      SUM(r.context_avoided_chars) AS contextAvoidedChars,
      SUM(r.worker_input_tokens) AS workerInputTokens,
      SUM(r.worker_output_tokens) AS workerOutputTokens,
      AVG(r.latency_ms) AS averageLatencyMs
    FROM delegation_runs r JOIN delegation_parent_executions p ON p.id = r.parent_execution_id${ownerWhere}`).get(...args) as Record<string, number | null>;
  return {
    toolObservations: observed.toolObservations ?? 0,
    largeReadsObserved: observed.largeReadsObserved ?? 0,
    averageHookLatencyMs: observed.averageHookLatencyMs ?? null,
    bulkReadRuns: runs.bulkReadRuns ?? 0,
    bulkReadSucceeded: runs.bulkReadSucceeded ?? 0,
    fallbacks: runs.fallbacks ?? 0,
    sourceCharsProcessed: runs.sourceCharsProcessed ?? 0,
    returnedChars: runs.returnedChars ?? 0,
    contextAvoidedChars: runs.contextAvoidedChars ?? 0,
    workerInputTokens: runs.workerInputTokens ?? null,
    workerOutputTokens: runs.workerOutputTokens ?? null,
    averageLatencyMs: runs.averageLatencyMs ?? null,
  };
}
