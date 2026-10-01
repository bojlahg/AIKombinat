import { get, post } from './client';
export type Health = 'ready' | 'degraded' | 'unknown' | 'blocked' | 'disabled';
export interface ReconciledCandidate {
  candidateId: string; provider: string; priority: number; enabled: boolean;
  currentModel: { id: string; value: string; label: string; status: string; source: string; lastSeenAt: string | null } | null;
  catalogState: string; catalogReasonCode: string; runtimeState: string; runtimeReasonCode: string;
  effort: { configured: string | null; supported: string[] | null; state: string };
  account: { policy: string; accountId: string | null; state: string };
  suggestions: Array<{ modelId: string; modelValue: string; label: string; reasonCode: string; requiresEffortChoice: boolean }>;
}
export interface ReconciledProfile {
  id: string; name: string; updatedAt: string; health: Health; usable: boolean; candidates: ReconciledCandidate[];
  references: { reviewPolicies: Array<{ id: string; name: string }>; runningCampaigns: Array<{ id: string; name: string }> };
}
export interface Reconciliation {
  generatedAt: string;
  providers: Array<{ provider: string; refreshId: string | null; primarySucceeded: boolean }>;
  profiles: ReconciledProfile[];
}
export const getReconciliation = () => get<Reconciliation>('/api/execution-profiles/reconciliation');
export const rebindCandidate = (profileId: string, candidateId: string, value: {
  newModelId: string; newEffort: string | null; expectedOldModelId: string; expectedProfileUpdatedAt: string; confirmActiveCampaignImpact: boolean;
}) => post(`/api/execution-profiles/${profileId}/executors/${candidateId}/rebind`, { ...value, source: 'manual_ui' });
