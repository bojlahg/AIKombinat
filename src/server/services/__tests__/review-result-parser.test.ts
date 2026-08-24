import { describe, it, expect } from 'vitest';
import { parseReviewResult } from '../review-result-parser.js';

describe('review-result-parser', () => {
  it('parses clean approved JSON', () => {
    const json = JSON.stringify({
      verdict: 'approved',
      summary: 'Implementation satisfies the requested task.',
      issues: [],
    });
    const res = parseReviewResult(json);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.verdict).toBe('approved');
      expect(res.data.summary).toBe('Implementation satisfies the requested task.');
      expect(res.data.issues).toEqual([]);
    }
  });

  it('parses clean needs_changes JSON with issues', () => {
    const json = JSON.stringify({
      verdict: 'needs_changes',
      summary: 'Two blocking issues remain.',
      issues: [
        {
          severity: 'blocking',
          description: 'Stop path releases resource before process termination.',
          files: ['src/server/services/session-manager.ts'],
        },
        {
          severity: 'minor',
          description: 'Typo in comment.',
        },
      ],
    });
    const res = parseReviewResult(json);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.verdict).toBe('needs_changes');
      expect(res.data.summary).toBe('Two blocking issues remain.');
      expect(res.data.issues).toHaveLength(2);
      expect(res.data.issues[0].severity).toBe('blocking');
      expect(res.data.issues[0].files).toEqual(['src/server/services/session-manager.ts']);
      expect(res.data.issues[1].severity).toBe('minor');
    }
  });

  it('parses JSON inside markdown code fence', () => {
    const markdown = `
Here is my review:

\`\`\`json
{
  "verdict": "approved",
  "summary": "Looks great!",
  "issues": []
}
\`\`\`

End of review.
`;
    const res = parseReviewResult(markdown);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.verdict).toBe('approved');
      expect(res.data.summary).toBe('Looks great!');
    }
  });

  it('rejects invalid JSON and preserves raw output', () => {
    const raw = 'Sorry, I could not complete the review.';
    const res = parseReviewResult(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Failed to parse reviewer output as JSON');
      expect(res.rawText).toBe(raw);
    }
  });

  it('rejects invalid verdict values', () => {
    const json = JSON.stringify({
      verdict: 'pass',
      summary: 'Task passed.',
      issues: [],
    });
    const res = parseReviewResult(json);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Invalid review verdict');
    }
  });

  it('rejects invalid issue severities', () => {
    const json = JSON.stringify({
      verdict: 'needs_changes',
      summary: 'Issues found.',
      issues: [
        {
          severity: 'critical',
          description: 'Broken build.',
        },
      ],
    });
    const res = parseReviewResult(json);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('invalid severity');
    }
  });
});
