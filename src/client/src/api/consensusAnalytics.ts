import { get, put } from './client';

export interface EvaluationMetrics {
  sampleCount: number; totalBatches: number; completedBatches: number; failedBatches: number; approvedBatches: number; needsChangesBatches: number;
  agreementRate: number | null; disagreementRate: number | null; reworkRate: number | null; judgeInvocationRate: number | null;
  knownCostUsd: number; knownTokens: number; costCoverage: number | null; tokenCoverage: number | null; avgBatchDurationMs: number | null;
  feedbackBatchesLabeled: number; feedbackBatchesTotal: number; feedbackIssuesLabeled: number; feedbackIssuesTotal: number;
}
export interface EvaluationReviewer {
  policyMemberId?: string; label?: string; grouping?: string; identity?: Record<string,string | null>;
  jobs: number; approvalVotes: number; needsChangesVotes: number; finalAlignmentRate: number | null; uniqueIssueCount: number;
  confirmedFindingCount: number; rejectedFindingCount: number; knownCostUsd: number; avgDurationMs: number | null; sampleCount: number;
  telemetryCoverage: { cost: number | null; tokens: number | null; duration: number | null };
}
export interface EvaluationFeedback { id: string; scope: string; review_job_id: string | null; issue_fingerprint: string | null; label: string; note: string }
export interface EvaluationIssue { fingerprint: string; description: string; files?: string[]; severity: string; reviewerCount?: number; batchCount?: number; uniqueCount?: number; sharedCount?: number; confirmed?: number; rejected?: number }
export interface EvaluationJob {
  id: string; label: string; identity: Record<string,string | null>; verdict: string | null; uniqueIssueCount: number; decisiveVote: boolean | null;
  judgeTriggerContribution: boolean; issues: EvaluationIssue[]; feedback: EvaluationFeedback[];
}
export interface EvaluationBatch {
  id: string; todoId: string; strategy: string; status: string; finalVerdict: string | null; agreement: boolean | null;
  reviewerCount: number; successfulReviewers: number; failedReviewers: number; uniqueIssueCount: number; batchDurationMs: number | null;
  diversity: { distinctProviders: number; distinctAccounts: number; distinctModels: number };
  telemetry: { knownCostUsd: number; knownTokens: number; costCoverage: number | null; tokenCoverage: number | null };
  jobs: EvaluationJob[]; feedback: EvaluationFeedback[];
  judge: { overrodeMajority: boolean | null };humanActions: { id: string; action: string; created_at: string }[];
}
export interface ConsensusAnalyticsData {
  period: { periodStart: string | null; periodEnd: string; timezone: string };
  summary: EvaluationMetrics; strategies: (EvaluationMetrics & { strategy: string })[]; policies: (EvaluationMetrics & { policyId: string; policyVariantId: string })[];
  reviewers: EvaluationReviewer[]; executionIdentities: EvaluationReviewer[]; issues: EvaluationIssue[];
  daily: { date: string; batches: number; agreement: number; disagreement: number }[];
  diversity: (EvaluationMetrics & { cohort: string })[];
  judge: { judgeInvocations: number; judgeCompleted: number; judgeFailed: number; judgeOverrodeMajority: number; knownJudgeCostUsd: number; avgJudgeDurationMs: number | null; judgeCostCoverage: number | null };
  humanFeedback: { batchFeedbackCoverage: number | null; reviewerFeedbackCoverage: number | null; issueFeedbackCoverage: number | null; confirmedIssueCount: number; rejectedIssueCount: number };
  singleBaseline: { singleReviewRounds: number; singleNeedsChanges: number; singleReworkRate: number | null; knownCostUsd: number; knownTokens: number; avgDurationMs: number | null; costCoverage: number | null; tokenCoverage: number | null };
  batches: EvaluationBatch[];pagination: { offset: number; limit: number; total: number; hasMore: boolean };bounds: { groupRowsOmitted: boolean; issueRowsOmitted: boolean; dailyRowsOmitted: boolean };
}
export function getConsensusAnalytics(projectId: string,period: string,offset=0,filters: Record<string,string> = {}): Promise<ConsensusAnalyticsData> {
  const query=new URLSearchParams({ period,offset: String(offset),...Object.fromEntries(Object.entries(filters).filter(([,v])=>v)) });
  return get(`/api/projects/${encodeURIComponent(projectId)}/analytics/consensus?${query}`);
}
export function saveEvaluationFeedback(projectId: string,batchId: string,scope: string,label: string,note: string,jobId?: string,fingerprint?: string) {
  const path=scope==='batch' ? `consensus-review-batches/${encodeURIComponent(batchId)}` : `consensus-review-jobs/${encodeURIComponent(jobId!)}`;
  return put(`/api/${path}${scope==='issue' ? `/issues/${encodeURIComponent(fingerprint!)}` : ''}/feedback`,{ projectId,batchId,label,note });
}
