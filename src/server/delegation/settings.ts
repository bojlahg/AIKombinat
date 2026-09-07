import { getSetting, setSetting } from '../db/app-settings.js';
import { getExecutionProfileById } from '../db/queries.js';
import type { DelegationMode } from './store.js';

const DELEGATION_WORKER_TOOLS = new Set(['claude', 'codex', 'antigravity']);

export interface DelegationSettings {
  enabled: boolean;
  mode: DelegationMode;
  workerExecutionProfileId: string | null;
  fullFileThresholdLines: number;
  maxTargetedReadLines: number;
  maxInputBytes: number;
  maxInputLines: number;
  maxWorkerRanges: number;
  maxTotalRecommendedLines: number;
  workerTimeoutSeconds: number;
  telemetryRetentionDays: number;
}

const DEFAULTS: DelegationSettings = {
  enabled: false,
  mode: 'telemetry',
  workerExecutionProfileId: null,
  fullFileThresholdLines: 400,
  maxTargetedReadLines: 250,
  maxInputBytes: 1024 * 1024,
  maxInputLines: 20_000,
  maxWorkerRanges: 8,
  maxTotalRecommendedLines: 800,
  workerTimeoutSeconds: 60,
  telemetryRetentionDays: 30,
};

const KEYS: Record<keyof DelegationSettings, string> = {
  enabled: 'delegation.enabled',
  mode: 'delegation.mode',
  workerExecutionProfileId: 'delegation.worker_execution_profile_id',
  fullFileThresholdLines: 'delegation.bulk_read.full_file_threshold_lines',
  maxTargetedReadLines: 'delegation.bulk_read.max_targeted_read_lines',
  maxInputBytes: 'delegation.bulk_read.max_input_bytes',
  maxInputLines: 'delegation.bulk_read.max_input_lines',
  maxWorkerRanges: 'delegation.bulk_read.max_worker_ranges',
  maxTotalRecommendedLines: 'delegation.bulk_read.max_total_recommended_lines',
  workerTimeoutSeconds: 'delegation.worker_timeout_seconds',
  telemetryRetentionDays: 'delegation.telemetry_retention_days',
};

const readInt = (key: string, fallback: number): number => {
  const parsed = Number(getSetting(key));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function getDelegationSettings(): DelegationSettings {
  const rawMode = getSetting(KEYS.mode);
  const mode: DelegationMode = rawMode === 'disabled' || rawMode === 'suggest' || rawMode === 'enforce_bulk_read' || rawMode === 'telemetry'
    ? rawMode : DEFAULTS.mode;
  return {
    enabled: getSetting(KEYS.enabled) === '1',
    mode,
    workerExecutionProfileId: getSetting(KEYS.workerExecutionProfileId),
    fullFileThresholdLines: readInt(KEYS.fullFileThresholdLines, DEFAULTS.fullFileThresholdLines),
    maxTargetedReadLines: readInt(KEYS.maxTargetedReadLines, DEFAULTS.maxTargetedReadLines),
    maxInputBytes: readInt(KEYS.maxInputBytes, DEFAULTS.maxInputBytes),
    maxInputLines: readInt(KEYS.maxInputLines, DEFAULTS.maxInputLines),
    maxWorkerRanges: readInt(KEYS.maxWorkerRanges, DEFAULTS.maxWorkerRanges),
    maxTotalRecommendedLines: readInt(KEYS.maxTotalRecommendedLines, DEFAULTS.maxTotalRecommendedLines),
    workerTimeoutSeconds: readInt(KEYS.workerTimeoutSeconds, DEFAULTS.workerTimeoutSeconds),
    telemetryRetentionDays: readInt(KEYS.telemetryRetentionDays, DEFAULTS.telemetryRetentionDays),
  };
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function updateDelegationSettings(input: Partial<DelegationSettings>): DelegationSettings {
  if (input.mode !== undefined && !['disabled', 'telemetry', 'suggest', 'enforce_bulk_read'].includes(input.mode)) {
    throw new Error('Invalid Delegation Router mode.');
  }
  if (input.workerExecutionProfileId !== undefined && input.workerExecutionProfileId !== null) {
    const profile = getExecutionProfileById(input.workerExecutionProfileId);
    if (!profile || !profile.is_enabled) throw new Error('Delegation Worker Execution Profile does not exist or is disabled.');
    if (!profile.executors.some((executor) => executor.is_enabled && DELEGATION_WORKER_TOOLS.has(executor.cli_tool))) {
      throw new Error('Delegation Worker Execution Profile must include an enabled Claude, Codex, or Antigravity executor.');
    }
  }
  if (input.enabled !== undefined) setSetting(KEYS.enabled, input.enabled ? '1' : '0');
  if (input.mode !== undefined) setSetting(KEYS.mode, input.mode);
  if (input.workerExecutionProfileId !== undefined) setSetting(KEYS.workerExecutionProfileId, input.workerExecutionProfileId);

  const bounds: Array<[keyof DelegationSettings, number, number]> = [
    ['fullFileThresholdLines', 10, 1_000_000],
    ['maxTargetedReadLines', 1, 100_000],
    ['maxInputBytes', 1024, 100 * 1024 * 1024],
    ['maxInputLines', 10, 1_000_000],
    ['maxWorkerRanges', 1, 100],
    ['maxTotalRecommendedLines', 1, 100_000],
    ['workerTimeoutSeconds', 1, 600],
    ['telemetryRetentionDays', 1, 365],
  ];
  for (const [key, min, max] of bounds) {
    if (input[key] !== undefined) setSetting(KEYS[key], String(boundedInteger(input[key], key, min, max)));
  }
  return getDelegationSettings();
}

export const delegationDefaults = DEFAULTS;
