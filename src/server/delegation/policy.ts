import crypto from 'crypto';
import { executorPool } from '../services/executor-pool.js';
import { logger } from '../logging/logger.js';
import { getDelegationSettings } from './settings.js';
import { DelegationFileError, getCachedFileMetadata, readDelegationFile } from './file-access.js';
import { consumeFallback, recordObservation, type ParentExecutionRow } from './store.js';

export type DelegationOperation =
  | { type: 'read_file'; path: string; offset?: number | null; limit?: number | null }
  | { type: 'shell'; commandKind?: string | null; rawLength: number; commandHash?: string }
  | { type: 'unknown_tool'; toolName: string };

export interface HookDecision {
  decision: 'allow' | 'suggest_bulk_read' | 'deny_use_bulk_read';
  reason: string;
  message?: string;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const numberOrNull = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;

function shellOperation(input: Record<string, unknown>): DelegationOperation {
  const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
  const first = command.trim().match(/^([^\s]+)/)?.[1]?.toLowerCase() ?? null;
  return {
    type: 'shell', commandKind: first, rawLength: command.length,
    commandHash: command ? crypto.createHash('sha256').update(command).digest('hex') : undefined,
  };
}

export function normalizeHookOperation(provider: 'claude' | 'codex', payload: unknown): { toolName: string; operation: DelegationOperation } {
  const event = asRecord(payload);
  const toolName = String(event.tool_name ?? event.toolName ?? event.name ?? 'unknown');
  const input = asRecord(event.tool_input ?? event.toolInput ?? event.arguments ?? event.input);
  const lower = toolName.toLowerCase();
  if (provider === 'claude' && lower === 'read') {
    return {
      toolName,
      operation: {
        type: 'read_file',
        path: String(input.file_path ?? input.path ?? ''),
        offset: numberOrNull(input.offset),
        limit: numberOrNull(input.limit),
      },
    };
  }
  if (['bash', 'powershell', 'shell', 'exec_command', 'unified_exec', 'local_shell'].some((name) => lower.includes(name))) {
    return { toolName, operation: shellOperation(input) };
  }
  return { toolName, operation: { type: 'unknown_tool', toolName } };
}

export async function decideHookOperation(
  provider: 'claude' | 'codex',
  parent: ParentExecutionRow,
  payload: unknown,
  delegationDepth = 0,
  managedDefinitionHash?: string | null,
): Promise<HookDecision> {
  const startedAt = Date.now();
  const settings = getDelegationSettings();
  const mode = parent.policy_mode;
  const { toolName, operation } = normalizeHookOperation(provider, payload);
  let decision: HookDecision = { decision: 'allow', reason: 'unsupported_tool' };
  let sourcePathRelative: string | null = null;
  let fileSize: number | null = null;

  if (!settings.enabled || mode === 'disabled') {
    decision = { decision: 'allow', reason: 'disabled' };
  } else if (delegationDepth > 0) {
    decision = { decision: 'allow', reason: 'delegation_depth' };
  } else if (operation.type === 'read_file') {
    if (operation.limit !== null && operation.limit !== undefined && operation.limit <= settings.maxTargetedReadLines) {
      decision = { decision: 'allow', reason: 'targeted_read' };
    } else {
      try {
        const metadata = getCachedFileMetadata(parent.work_dir, operation.path, settings.fullFileThresholdLines, settings.maxInputBytes);
        sourcePathRelative = metadata.relativePath;
        fileSize = metadata.size;
        if (metadata.lines < settings.fullFileThresholdLines) {
          decision = { decision: 'allow', reason: 'small_file' };
        } else if (mode === 'telemetry') {
          decision = { decision: 'allow', reason: 'telemetry_only' };
        } else if (mode === 'suggest') {
          decision = {
            decision: 'suggest_bulk_read', reason: 'bulk_read_suggested',
            message: 'This is a large exploratory read. Consider kombinat.bulk_read, then perform targeted reads of the returned ranges.',
          };
        } else if (!settings.workerExecutionProfileId) {
          decision = { decision: 'allow', reason: 'worker_unconfigured' };
        } else {
          const identity = readDelegationFile(parent.work_dir, operation.path, settings.maxInputBytes, settings.maxInputLines);
          if (consumeFallback(parent.id, identity.canonicalPath, identity.sha256)) {
            decision = { decision: 'allow', reason: 'fallback_grant' };
          } else {
            const selection = await executorPool.selectExecutor({
              executionProfileId: settings.workerExecutionProfileId,
              allowedCliTools: ['claude', 'codex', 'antigravity'],
              requireDelegationWorkerIsolation: true,
            });
            if (selection.status !== 'selected') {
              decision = { decision: 'allow', reason: 'worker_unavailable' };
            } else {
              decision = {
                decision: 'deny_use_bulk_read', reason: 'bulk_read_required',
                message: `Large full-file reads are routed through kombinat.bulk_read. Call it with path "${sourcePathRelative}" and a focused query, then Read only the returned ranges.`,
              };
            }
          }
        }
      } catch (err) {
        decision = { decision: 'allow', reason: err instanceof DelegationFileError ? err.code : 'outside_workspace' };
      }
    }
  } else if (operation.type === 'shell') {
    decision = { decision: 'allow', reason: mode === 'telemetry' ? 'telemetry_only' : 'unsupported_tool' };
  }

  const hookLatencyMs = Date.now() - startedAt;
  recordObservation({
    parentExecution: parent,
    toolName,
    operationType: operation.type,
    sourcePathRelative,
    requestedOffset: operation.type === 'read_file' ? operation.offset : null,
    requestedLimit: operation.type === 'read_file' ? operation.limit : null,
    fileSize,
    commandKind: operation.type === 'shell' ? operation.commandKind : null,
    commandRawLength: operation.type === 'shell' ? operation.rawLength : null,
    commandHash: operation.type === 'shell' ? operation.commandHash : null,
    decision: decision.decision,
    decisionReason: decision.reason,
    hookLatencyMs,
    managedDefinitionHash,
  });
  logger.info('delegation.policy.decision', {
    msg: `delegation policy ${decision.decision}`,
    parentExecutionId: parent.id, provider, toolName, decision: decision.decision,
    reason: decision.reason, latencyMs: hookLatencyMs,
  });
  return decision;
}

export function formatHookResponse(_provider: 'claude' | 'codex', decision: HookDecision): unknown | null {
  if (decision.decision === 'allow') return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(decision.decision === 'deny_use_bulk_read'
        ? { permissionDecision: 'deny', permissionDecisionReason: decision.message }
        : { additionalContext: decision.message }),
    },
  };
}
