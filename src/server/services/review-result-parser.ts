import {
  type ReviewResult,
  type ReviewVerdict,
  type ReviewIssue,
  isValidReviewVerdict,
  isValidIssueSeverity,
} from './review-result.js';

export type ParseReviewResultOutput =
  | { ok: true; data: ReviewResult }
  | { ok: false; error: string; rawText: string };

/**
 * Extract and parse structured ReviewResult from reviewer agent output.
 * Handles clean JSON and JSON within markdown code fences.
 */
export function parseReviewResult(rawOutput: string): ParseReviewResultOutput {
  const trimmed = (rawOutput ?? '').trim();
  if (!trimmed) {
    return {
      ok: false,
      error: 'Reviewer returned empty output.',
      rawText: rawOutput,
    };
  }

  let jsonStr = trimmed;

  // Check for markdown code fence: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse reviewer output as JSON: ${err instanceof Error ? err.message : String(err)}`,
      rawText: rawOutput,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'Reviewer output must be a JSON object.',
      rawText: rawOutput,
    };
  }

  const record = parsed as Record<string, unknown>;

  if (!isValidReviewVerdict(record.verdict)) {
    return {
      ok: false,
      error: `Invalid review verdict: expected "approved" or "needs_changes", got ${JSON.stringify(record.verdict)}`,
      rawText: rawOutput,
    };
  }

  if (typeof record.summary !== 'string') {
    return {
      ok: false,
      error: 'Reviewer summary must be a string.',
      rawText: rawOutput,
    };
  }

  if (!Array.isArray(record.issues)) {
    return {
      ok: false,
      error: 'Reviewer issues must be an array.',
      rawText: rawOutput,
    };
  }

  const validatedIssues: ReviewIssue[] = [];
  for (let i = 0; i < record.issues.length; i++) {
    const issue = record.issues[i];
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
      return {
        ok: false,
        error: `Review issue at index ${i} is not a valid object.`,
        rawText: rawOutput,
      };
    }
    const issueRec = issue as Record<string, unknown>;
    if (!isValidIssueSeverity(issueRec.severity)) {
      return {
        ok: false,
        error: `Review issue at index ${i} has invalid severity: expected "blocking", "major", or "minor", got ${JSON.stringify(issueRec.severity)}`,
        rawText: rawOutput,
      };
    }
    if (typeof issueRec.description !== 'string' || !issueRec.description.trim()) {
      return {
        ok: false,
        error: `Review issue at index ${i} must have a non-empty description.`,
        rawText: rawOutput,
      };
    }

    let files: string[] | undefined = undefined;
    if (issueRec.files !== undefined && issueRec.files !== null) {
      if (!Array.isArray(issueRec.files) || !issueRec.files.every((f) => typeof f === 'string')) {
        return {
          ok: false,
          error: `Review issue at index ${i} has invalid "files" array: all entries must be strings.`,
          rawText: rawOutput,
        };
      }
      files = issueRec.files as string[];
    }

    validatedIssues.push({
      severity: issueRec.severity,
      description: issueRec.description.trim(),
      ...(files ? { files } : {}),
    });
  }

  return {
    ok: true,
    data: {
      verdict: record.verdict as ReviewVerdict,
      summary: record.summary.trim(),
      issues: validatedIssues,
    },
  };
}
