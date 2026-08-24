import { get, post } from './client';

export interface CliToolStatus {
  tool: string;
  installed: boolean;
  version: string | null;
}

export interface ProviderQuotaState {
  tool: 'claude' | 'codex' | 'antigravity';
  state: 'available' | 'exhausted' | 'unknown';
  source: string;
  observedAt: string;
  reason: string | null;
  resetAt: string | null;
}

export function getCliStatus(): Promise<CliToolStatus[]> {
  return get('/api/cli/status');
}

export function refreshCliStatus(): Promise<CliToolStatus[]> {
  return post('/api/cli/status/refresh');
}

export function getProviderQuotaStates(): Promise<ProviderQuotaState[]> {
  return get('/api/cli/quota');
}

