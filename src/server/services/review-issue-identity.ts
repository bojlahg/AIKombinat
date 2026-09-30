import { createHash } from 'node:crypto';
import type { ReviewIssue, ReviewIssueSeverity } from './review-result.js';

const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ').toLowerCase();
const severity = { blocking: 0, major: 1, minor: 2 };
export function normalizeReviewIssue(issue: ReviewIssue) {
  return [normalize(issue.description), (issue.files ?? []).map(normalize).sort()] as const;
}
export function reviewIssueFingerprint(issue: ReviewIssue): string {
  return createHash('sha256').update(JSON.stringify(normalizeReviewIssue(issue))).digest('hex');
}
export function compareIssueSeverity(a: ReviewIssueSeverity, b: ReviewIssueSeverity): number {
  return severity[a] - severity[b];
}
