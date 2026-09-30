import type { ReviewResult, ReviewIssue } from './review-result.js';
import { reviewIssueFingerprint, compareIssueSeverity } from './review-issue-identity.js';

export type ConsensusStrategy = 'majority' | 'unanimous' | 'weighted' | 'judge' | 'judge_on_disagreement';
export interface ConsensusVote {
  id: string; priority: number; created_at: string; weight: number;
  result: ReviewResult | null;
}
export interface ConsensusDecision extends ReviewResult {
  strategy: ConsensusStrategy; reviewer_count: number; successful_count: number; failed_count: number;
  approved_votes: number; needs_changes_votes: number; approved_weight: number; needs_changes_weight: number;
  needs_judge: boolean; failure_reason: string | null;
}

export function aggregateConsensus(input: {
  strategy: ConsensusStrategy; failure_policy: 'require_all' | 'quorum';
  min_successful_reviewers: number; reviewers: ConsensusVote[];
}): ConsensusDecision {
  const counted = [...input.reviewers].filter(v => v.result).sort((a, b) =>
    a.priority - b.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const approved = counted.filter(v => v.result!.verdict === 'approved');
  const changes = counted.filter(v => v.result!.verdict === 'needs_changes');
  const approvedWeight = approved.reduce((n, v) => n + v.weight, 0);
  const changesWeight = changes.reduce((n, v) => n + v.weight, 0);
  const failed = input.reviewers.length - counted.length;
  const failure = (input.failure_policy === 'require_all' && failed > 0) || counted.length < input.min_successful_reviewers;
  const needsJudge = !failure && (input.strategy === 'judge' || (input.strategy === 'judge_on_disagreement' && approved.length > 0 && changes.length > 0));
  const verdict = !failure && !needsJudge && (input.strategy === 'weighted' ? approvedWeight > changesWeight
    : input.strategy === 'unanimous' || input.strategy === 'judge_on_disagreement' ? changes.length === 0
    : approved.length > changes.length) ? 'approved' : 'needs_changes';
  const merged = new Map<string, { issue: ReviewIssue; order: number }>();
  let order = 0;
  if (verdict === 'needs_changes') for (const vote of changes) for (const issue of vote.result!.issues) {
    const key = reviewIssueFingerprint(issue);
    const existing = merged.get(key);
    if (!existing) merged.set(key, { issue: { ...issue, files: issue.files ? [...issue.files] : undefined }, order });
    else if (compareIssueSeverity(issue.severity, existing.issue.severity) < 0) existing.issue = { ...existing.issue, severity: issue.severity };
    order++;
  }
  return {
    verdict, summary: `Consensus ${input.strategy}: ${approved.length} approved, ${changes.length} needs_changes, ${failed} failed.`,
    issues: [...merged.values()].sort((a, b) => compareIssueSeverity(a.issue.severity, b.issue.severity) || a.order - b.order).map(v => v.issue),
    strategy: input.strategy, reviewer_count: input.reviewers.length, successful_count: counted.length, failed_count: failed,
    approved_votes: approved.length, needs_changes_votes: changes.length, approved_weight: approvedWeight, needs_changes_weight: changesWeight,
    needs_judge: needsJudge, failure_reason: failure ? 'reviewer_quorum_failed' : null,
  };
}
