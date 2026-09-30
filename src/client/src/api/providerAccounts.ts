import { get, post, patch, del } from './client';
export interface ProviderAccount {
  id: string; provider: 'claude' | 'codex' | 'antigravity'; slug: string; label: string; description: string;
  auth_strategy: 'inherited' | 'environment_reference'; auth_config_json: string;
  is_enabled: number; health_state: 'unknown' | 'available' | 'auth_error' | 'unavailable'; health_reason: string | null;
  quota?: { state: 'available' | 'exhausted' | 'unknown'; source: string; reason: string | null; resetAt: string | null; observedAt: string };
  last_health_at?: string | null;
  max_concurrency: number; active_usage: number; strategies: string[];
}
export const getAccounts = () => get<ProviderAccount[]>('/api/provider-accounts');
export const saveAccount = (id: string | null, input: object) => id ? patch<ProviderAccount>(`/api/provider-accounts/${id}`, input) : post<ProviderAccount>('/api/provider-accounts', input);
export const testAccount = (id: string) => post<ProviderAccount>(`/api/provider-accounts/${id}/test`, {});
export const deleteAccount = (id: string) => del(`/api/provider-accounts/${id}`);

export const resetAccountQuota = (id: string) => post(`/api/provider-accounts/${id}/quota/reset`, {});
