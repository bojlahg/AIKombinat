import { get, post, put } from './client';

export type DelegationMode = 'disabled' | 'telemetry' | 'suggest' | 'enforce_bulk_read';

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
  workerProfile: { id: string; name: string; executors: Array<{ provider: string; model: string; effort: string | null; enabled: boolean }> } | null;
}

export interface DelegationHookStatus {
  provider: 'claude' | 'codex';
  state: 'not_installed' | 'installed_unverified' | 'needs_trust' | 'verified' | 'incompatible' | 'manual_action_required' | 'error';
  installed: boolean;
  launcherRunnable: boolean;
  definitionHash: string | null;
  verified: boolean;
  needsTrust: boolean;
  version: string | null;
  error: string | null;
}

export interface DelegationStatistics {
  toolObservations: number;
  largeReadsObserved: number;
  averageHookLatencyMs: number | null;
  bulkReadRuns: number;
  bulkReadSucceeded: number;
  fallbacks: number;
  sourceCharsProcessed: number;
  returnedChars: number;
  contextAvoidedChars: number;
  workerInputTokens: number | null;
  workerOutputTokens: number | null;
  averageLatencyMs: number | null;
}

export const getDelegationSettings = () => get<DelegationSettings>('/api/delegation');
export const updateDelegationSettings = (value: Partial<DelegationSettings>) => put<DelegationSettings>('/api/delegation/settings', value);
export const getDelegationHooks = () => get<DelegationHookStatus[]>('/api/delegation/hooks');
export const installDelegationHook = (provider: 'claude' | 'codex') => post<DelegationHookStatus>(`/api/delegation/hooks/${provider}/install`);
export const removeDelegationHook = (provider: 'claude' | 'codex') => post<DelegationHookStatus>(`/api/delegation/hooks/${provider}/remove`);
export const getDelegationStatistics = () => get<DelegationStatistics>('/api/delegation/statistics');
