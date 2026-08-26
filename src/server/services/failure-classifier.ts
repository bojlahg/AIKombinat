import type { CliTool } from './cli-adapters.js';

export type ProviderFailureCategory = 'quota_exhausted' | 'rate_limited' | 'auth_error' | 'other';

export interface ProviderFailureClassification {
  category: ProviderFailureCategory;
  reason: string | null;
  resetAt?: string | null;
}

// ── Claude Recognizers ──
const CLAUDE_QUOTA_PATTERNS = [
  /exhausted your (?:capacity|quota)/i,
  /exceeded your (?:current )?quota/i,
  /usage limit reached/i,
  /reached your usage limit/i,
  /rate.?limit.*(?:exceeded|reached)/i,
  /rate_limit_error/i,
  /429\s*(?:Too Many Requests|Quota exceeded|Resource has been exhausted)/i,
  /hit your daily rate limit/i,
];

const CLAUDE_AUTH_PATTERNS = [
  /authentication failed/i,
  /invalid(?:_|\s+)api(?:_|\s+)key/i,
  /please (?:log in|login|authenticate)/i,
  /login required/i,
  /not logged in/i,
];

// ── Codex Recognizers ──
const CODEX_QUOTA_PATTERNS = [
  /quota exceeded/i,
  /exceeded your (?:current )?quota/i,
  /rate.?limit.*(?:reached|exceeded)/i,
  /RateLimitError/i,
  /rate_limit_exceeded/i,
  /insufficient_quota/i,
  /429\s*Too Many Requests/i,
  /exceeded your request\/token rate limit/i,
];

const CODEX_AUTH_PATTERNS = [
  /authentication failed/i,
  /invalid(?:_|\s+)api(?:_|\s+)key/i,
  /unauthorized/i,
  /please (?:log in|login|authenticate)/i,
  /login required/i,
];

// ── Antigravity Recognizers ──
const ANTIGRAVITY_QUOTA_PATTERNS = [
  /RESOURCE_EXHAUSTED/i,
  /Resource has been exhausted/i,
  /quota exceeded/i,
  /Quota exceeded for quota metric/i,
  /429\s*Quota exceeded/i,
  /rate.?limit.*(?:exceeded|reached)/i,
  /rate_limit_error/i,
];

const ANTIGRAVITY_AUTH_PATTERNS = [
  /UNAUTHENTICATED/i,
  /unauthenticated/i,
  /authentication failed/i,
  /please (?:log in|login|authenticate)/i,
  /login required/i,
];

function extractResetAt(output: string): string | null {
  if (!output) return null;

  // Check for JSON rate_limit_info resetsAt (epoch seconds or ms)
  const jsonMatch = output.match(/"resetsAt"\s*:\s*(\d+)/);
  if (jsonMatch) {
    const rawVal = parseInt(jsonMatch[1], 10);
    if (!isNaN(rawVal) && rawVal > 0) {
      const ms = rawVal > 1e11 ? rawVal : rawVal * 1000;
      try {
        return new Date(ms).toISOString();
      } catch { /* ignore */ }
    }
  }

  // Check for ISO timestamp after reset markers: "reset at 2026-08-24T12:00:00Z"
  const isoMatch = output.match(/resets?(?:\s+at|\s+time)?[:\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i);
  if (isoMatch) {
    try {
      const d = new Date(isoMatch[1]);
      if (!isNaN(d.getTime())) return d.toISOString();
    } catch { /* ignore */ }
  }

  return null;
}

function findMatchingReason(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }
  return null;
}

export function classifyProviderFailure(
  tool: CliTool,
  exitCode: number,
  output: string = '',
): ProviderFailureClassification {
  if (tool === 'raw-shell') {
    return { category: 'other', reason: null };
  }

  if (exitCode === 0) {
    return { category: 'other', reason: null };
  }

  const cleanOutput = output.trim();
  if (!cleanOutput) {
    return { category: 'other', reason: null };
  }

  if (tool === 'claude') {
    const quotaReason = findMatchingReason(CLAUDE_QUOTA_PATTERNS, cleanOutput);
    if (quotaReason) {
      const resetAt = extractResetAt(cleanOutput);
      const isRateLimit = /rate.?limit/i.test(quotaReason);
      return {
        category: isRateLimit ? 'rate_limited' : 'quota_exhausted',
        reason: quotaReason,
        resetAt,
      };
    }

    const authReason = findMatchingReason(CLAUDE_AUTH_PATTERNS, cleanOutput);
    if (authReason) {
      return {
        category: 'auth_error',
        reason: /not logged in/i.test(authReason)
          ? 'Claude CLI is not authenticated. Run `claude` interactively and use `/login`.'
          : authReason,
      };
    }
  }

  if (tool === 'codex') {
    const quotaReason = findMatchingReason(CODEX_QUOTA_PATTERNS, cleanOutput);
    if (quotaReason) {
      const resetAt = extractResetAt(cleanOutput);
      const isRateLimit = /rate.?limit/i.test(quotaReason);
      return {
        category: isRateLimit ? 'rate_limited' : 'quota_exhausted',
        reason: quotaReason,
        resetAt,
      };
    }

    const authReason = findMatchingReason(CODEX_AUTH_PATTERNS, cleanOutput);
    if (authReason) {
      return { category: 'auth_error', reason: authReason };
    }
  }

  if (tool === 'antigravity') {
    const quotaReason = findMatchingReason(ANTIGRAVITY_QUOTA_PATTERNS, cleanOutput);
    if (quotaReason) {
      const resetAt = extractResetAt(cleanOutput);
      const isRateLimit = /rate.?limit/i.test(quotaReason);
      return {
        category: isRateLimit ? 'rate_limited' : 'quota_exhausted',
        reason: quotaReason,
        resetAt,
      };
    }

    const authReason = findMatchingReason(ANTIGRAVITY_AUTH_PATTERNS, cleanOutput);
    if (authReason) {
      return { category: 'auth_error', reason: authReason };
    }
  }

  return { category: 'other', reason: null };
}
