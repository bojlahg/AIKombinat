import type { ReviewResult } from './review-result.js';
import { isValidReviewVerdict, isValidIssueSeverity } from './review-result.js';
import { redactString } from '../logging/redact.js';

export function evaluationResult(payload: string | null | undefined): ReviewResult | null {
  try {
    const value = JSON.parse(payload ?? 'null');
    if (!value || !isValidReviewVerdict(value.verdict) || !Array.isArray(value.issues)) return null;
    return { verdict: value.verdict,summary: '',issues: value.issues.filter((i: any) => i && isValidIssueSeverity(i.severity) && typeof i.description === 'string' && (i.files === undefined || Array.isArray(i.files) && i.files.every((f: unknown) => typeof f === 'string'))) };
  } catch { return null; }
}
export function normalizeExecutionIdentity(payload: string | null) {
  let value: Record<string,unknown> = {};
  try { const parsed = JSON.parse(payload ?? '{}'); if (parsed && typeof parsed === 'object') value = parsed; } catch { /* legacy */ }
  const str = (key: string) => typeof value[key] === 'string' ? redactString(value[key] as string).slice(0,1024) : null;
  return { provider: str('agent') ?? str('provider'),providerAccountId: str('providerAccountId'),providerAccountLabel: str('providerAccountLabel'),
    providerAccountStrategy: str('providerAccountStrategy'),accountPolicy: str('accountPolicy'),executorCandidateId: str('executorCandidateId'),
    executionProfileId: str('profileId') ?? str('executionProfileId'),profileName: str('profileName'),model: str('model'),effectiveModel: str('effectiveModel') ?? str('model'),effort: str('effort') };
}
export function normalizeConsensusFailure(reason: string | null, status?: string): string | null {
  if (status === 'stopped') return 'stop';
  if (status === 'recovery_required') return 'recovery';
  if (!reason) return status === 'failed' ? 'unknown' : null;
  if (/artifact_changed/.test(reason)) return 'artifact_changed';
  if (/judge/.test(reason)) return 'judge_failure';
  if (/quorum/.test(reason)) return 'quorum_failure';
  if (/reviewer/.test(reason)) return 'reviewer_failure';
  if (/stop|cancel/.test(reason)) return 'stop';
  if (/restart|recovery/.test(reason)) return 'recovery';
  if (/config|profile|policy/.test(reason)) return 'configuration';
  return 'unknown';
}
export function normalizeReviewerFailure(reason: string | null, status?: string): string | null {
  if (status === 'stopped') return 'stop';
  if (status === 'recovery_required') return 'recovery';
  if (!reason) return status === 'failed' ? 'unknown' : null;
  const text = reason.toLowerCase();
  for (const [category, pattern] of [['quota',/quota|rate.limit|429|failover_budget_exhausted/],['auth',/auth|credential|401|403/],['output_limit',/(?:output|result).*limit|output.*exceed/],['invalid_output',/invalid.*output|invalid.*result|parse|review_result|json|review result|missing required field/],['resource',/resource/],['stop',/stop|cancel/],['recovery',/restart|recovery/],['configuration',/config|profile|policy|eligible/],['process',/process|exit|spawn|enoent/]] as const) if (pattern.test(text)) return category;
  return 'unknown';
}
