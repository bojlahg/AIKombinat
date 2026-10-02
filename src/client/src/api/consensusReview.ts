import { get, post, patch, del } from './client';
import type { ReviewResult } from '../types';

export interface PolicyMember {
  id?: string; execution_profile_id: string; label: string; weight: number; priority: number; is_enabled: number;
}
export interface ReviewPolicy {
  id: string; name: string; description: string;
  strategy: 'majority' | 'unanimous' | 'weighted' | 'judge' | 'judge_on_disagreement';
  failure_policy: 'require_all' | 'quorum'; min_successful_reviewers: number;
  judge_execution_profile_id: string | null; diversity_policy: 'none' | 'prefer_provider' | 'prefer_provider_and_account';
  max_parallel_reviewers: number; is_enabled: number; sort_order: number; members: PolicyMember[];
}
export interface ConsensusAttempt {
  id: string; attempt_index: number; status: string; execution_snapshot: string | null;
  process_pid: number; error_message: string | null; duration_ms: number | null; attempt_wall_duration_ms: number | null; provider_duration_ms: number | null;
  input_tokens: number | null; output_tokens: number | null; cost_usd: number | null;
}
export interface ConsensusJob {
  id: string; role: 'reviewer' | 'judge'; execution_profile_id: string; label: string; weight: number;
  status: string; final_result_payload: string | null; final_error_message: string | null; attempts: ConsensusAttempt[];
}
export interface ConsensusBatch {
  id: string; review_round_id: string; status: string; strategy: string; failure_reason: string | null;
  aggregate_result_json: string | null; jobs: ConsensusJob[];
}
export interface ConsensusDecision extends ReviewResult {
  approved_votes: number; needs_changes_votes: number; approved_weight: number; needs_changes_weight: number;
}
export const getPolicies = () => get<ReviewPolicy[]>('/api/review-policies');
export const savePolicy = (policy: Omit<ReviewPolicy,'id'>, id?: string) => id
  ? patch<ReviewPolicy>(`/api/review-policies/${id}`,policy) : post<ReviewPolicy>('/api/review-policies',policy);
export const disablePolicy = (id: string) => del<void>(`/api/review-policies/${id}`);
export const getConsensusHistory = (todoId: string) => get<ConsensusBatch[]>(`/api/todos/${todoId}/consensus-reviews`);
export const retryReviewer = (id: string) => post<{ ok: boolean }>(`/api/consensus-review-jobs/${id}/retry`);
