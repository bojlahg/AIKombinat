export type ReviewVerdict = 'approved' | 'needs_changes';

export type ReviewIssueSeverity = 'blocking' | 'major' | 'minor';

export interface ReviewIssue {
  severity: ReviewIssueSeverity;
  description: string;
  files?: string[];
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  issues: ReviewIssue[];
}

export function isValidReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === 'approved' || value === 'needs_changes';
}

export function isValidIssueSeverity(value: unknown): value is ReviewIssueSeverity {
  return value === 'blocking' || value === 'major' || value === 'minor';
}
