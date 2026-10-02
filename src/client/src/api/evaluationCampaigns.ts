import { get, post, put, patch, del } from './client';

export interface EvaluationTodoOptions { evaluation_campaign_id?: string; evaluation_campaign_enroll?: boolean; evaluation_override?: boolean; }
export interface CampaignArm {
  id?: string; name: string; description: string; is_control: number; weight: number; sort_order: number; is_enabled: number;
  review_mode: 'single' | 'consensus'; review_profile_id: string | null; review_policy_id: string | null;
  rework_profile_id: string | null; max_review_rounds: number | null;
}
export interface Campaign {
  id: string; project_id: string; name: string; description: string; status: 'draft' | 'running' | 'paused' | 'completed' | 'archived';
  auto_enroll: number; max_assignments: number | null; arms: CampaignArm[]; assigned: number; cleanPercentage: number | null;
  started_at: string | null; assignment_algorithm: string; campaign_definition_hash: string | null;
}
export interface CampaignAssignment {
  id: string; campaign_id: string; campaign_name: string; arm_id: string; todo_id: string;
  integrity_state: 'clean' | 'contaminated' | 'excluded'; integrity_reason: string | null; first_execution_at: string | null; review_started_at: string | null;
  campaign_definition_hash: string; arm_definition_hash: string; assigned_review_config_hash: string;
  arm_snapshot: CampaignArm; explanation: { algorithm: string; bucket: number; totalWeight: number; rangeStart: number; rangeEnd: number };
  feedback: { label: string; note: string } | null;
}
export interface CampaignMetrics {
  assignments: number; started: number; reachedReview: number; terminal: number; completed: number; failed: number; stopped: number;
  completionRate: number | null; failureRate: number | null; approvedFinalReview: number; needsChangesFinalReview: number; finalReviewSamples: number; needsChangesRate: number | null;
  todosWithRework: number; reworkDenominator: number; reworkRate: number | null; manualApprove: number; manualRework: number;
  avgTodoDurationMs: number | null; p50TodoDurationMs: number | null; p95TodoDurationMs: number | null; durationSamples: number;
  knownTodoCostUsd: number | null; todoCostKnown: number; todoCostTotal: number; todoCostCoverage: number | null;
  knownTodoTokens: number | null; todoTokensKnown: number; todoTokensTotal: number; todoTokenCoverage: number | null;
  knownTreatmentCostUsd: number | null; treatmentCostAttemptsKnown: number; treatmentCostAttemptsTotal: number; treatmentCostCoverage: number | null;
  knownTreatmentIoTokens: number | null; treatmentTokenAttemptsKnown: number; treatmentTokenAttemptsTotal: number; treatmentTokenCoverage: number | null;
  treatmentCostTodosFullyCovered: number; treatmentCostTodosStarted: number; treatmentCostTodoCoverage: number | null;
  avgTreatmentCostUsd: number | null; p50TreatmentCostUsd: number | null;
  knownCacheReadTokens: number | null; cacheReadCoverage: number | null; knownCacheCreationTokens: number | null; cacheCreationCoverage: number | null;
  knownProviderDurationMs: number | null; providerDurationCoverage: number | null; treatmentProcessAttempts: number;
  lowSample: boolean;
  feedback: { responses: number; evaluative: number; denominator: number; helpful: number; notHelpful: number; mixed: number; unknown: number; helpfulRate: number | null; responseCoverage: number | null; evaluativeCoverage: number | null };
}
export interface CampaignAnalytics {
  campaignId: string; totalAssigned: number;
  arms: { id: string; name: string; isControl: boolean; weight: number; expectedPercentage: number | null; observedCount: number; observedPercentage: number | null; clean: number; contaminated: number; excluded: number;
    attrition: CampaignMetrics; itt: CampaignMetrics; pp: CampaignMetrics;
    actualIdentities: Record<'itt' | 'pp',Record<string,{ totalIdentities: number; omittedIdentities: number; items: { value: string; todos: number }[] }>> }[];
  comparisons: { armId: string; controlArmId: string; itt: Record<string,Comparison>; pp: Record<string,Comparison> }[];
}
export interface Comparison { controlValue: number | null; armValue: number | null; absoluteDifference: number | null; relativeRatio: number | null; }
export interface AssignmentPage {
  total: number; limit: number; offset: number; hasMore: boolean;
  assignments: { assignment_id: string; todo_id: string; arm_name: string; integrity_state: string; todo_status: string; campaign_feedback: string | null;
    known_treatment_cost_usd: number | null; treatment_cost_attempts_known: number; treatment_cost_attempts_total: number; treatment_cost_coverage: number | null;
    known_treatment_io_tokens: number | null; treatment_token_attempts_known: number; treatment_token_attempts_total: number; treatment_token_coverage: number | null;
    known_cache_read_tokens: number | null; known_cache_creation_tokens: number | null; treatment_process_attempts: number;
    known_provider_duration_ms: number | null;
  }[];
}
const scoped=(projectId: string)=>`projectId=${encodeURIComponent(projectId)}`;
export const listCampaigns=(projectId: string,includeArchived=false)=>get<Campaign[]>(`/api/projects/${projectId}/evaluation-campaigns?includeArchived=${includeArchived}`);
export const saveCampaign=(projectId: string,input: { name: string; description: string; auto_enroll?: number; max_assignments?: number | null; arms?: CampaignArm[] },id?: string)=>id
  ? patch<Campaign>(`/api/evaluation-campaigns/${id}?${scoped(projectId)}`,input) : post<Campaign>(`/api/projects/${projectId}/evaluation-campaigns`,input);
export const campaignAction=(id: string,projectId: string,action: string)=>post<Campaign>(`/api/evaluation-campaigns/${id}/${action}`,{ projectId });
export const deleteCampaign=(id: string,projectId: string)=>del<void>(`/api/evaluation-campaigns/${id}?${scoped(projectId)}`);
export const getCampaignAnalytics=(id: string,projectId: string)=>get<CampaignAnalytics>(`/api/evaluation-campaigns/${id}/analytics?${scoped(projectId)}`);
export const getCampaignAssignments=(id: string,projectId: string,offset=0)=>get<AssignmentPage>(`/api/evaluation-campaigns/${id}/assignments?${scoped(projectId)}&limit=100&offset=${offset}`);
export const getCampaignAssignment=(todoId: string,projectId: string)=>get<CampaignAssignment | null>(`/api/todos/${todoId}/evaluation-assignment?${scoped(projectId)}`);
export const withdrawCampaignAssignment=(todoId: string,projectId: string)=>post<CampaignAssignment>(`/api/todos/${todoId}/evaluation-assignment/withdraw`,{ projectId });
export const saveCampaignFeedback=(todoId: string,projectId: string,label: string,note: string)=>put(`/api/todos/${todoId}/evaluation-assignment/feedback`,{ projectId,label,note });
export async function downloadCampaignCsv(id: string,projectId: string) {
  const chunks: string[]=[];
  for (let offset=0; ; offset+=200) {
    const response=await fetch(`/api/evaluation-campaigns/${id}/export.csv?${scoped(projectId)}&limit=200&offset=${offset}`,{ credentials: 'include' });
    if (!response.ok) throw new Error('CSV request failed');
    const csv=await response.text();chunks.push(offset ? csv.slice(csv.indexOf('\r\n')+2) : csv);
    if (response.headers.get('X-Has-More')!=='true') break;
  }
  const url=URL.createObjectURL(new Blob([chunks.join('\r\n')],{ type: 'text/csv;charset=utf-8' }));
  const a=document.createElement('a');a.href=url;a.download='evaluation-campaign.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
