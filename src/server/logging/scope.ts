import { redactString } from './redact.js';

/**
 * Scope tags are assembled from user-controlled text — forum titles, todo
 * titles, discussion titles, AgentForum member names — so they are exactly as
 * untrusted as any other free-form string that reaches a sink.
 *
 * Two hazards, both closed here rather than at the call sites:
 *  - a credential pasted into a title would otherwise bypass redaction, which
 *    only ever ran over `msg`, `detail` and the metadata fields;
 *  - a CR/LF inside a title would let that title forge what looks like an
 *    additional log line ("Agent\nERROR [server] everything is fine").
 *
 * Applied on the logger boundary, so no caller can opt out and no future caller
 * can forget.
 */

/** Long enough for `[forum:<40 chars>][<member name>]`, short enough to stay readable. */
export const MAX_SCOPE_LENGTH = 120;

/**
 * C0 controls (CR, LF, TAB, NUL…), DEL, the C1 range, and the Unicode
 * line/paragraph separators — everything that could break a record into two.
 */
const CONTROL_AND_LINE_BREAKS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]',
  'g',
);

/**
 * Collapses a scope tag to a single sanitized line.
 *
 * `[forum:test][Claude]` passes through untouched — the normalization only bites
 * on whitespace runs, control characters and over-long labels.
 */
export function sanitizeLogScope(scope: string | null | undefined): string {
  if (!scope) return '';
  const collapsed = redactString(scope)
    .replace(CONTROL_AND_LINE_BREAKS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= MAX_SCOPE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_SCOPE_LENGTH)}...`;
}

/**
 * Neutralizes line breaks in a single-line field (the console/file `msg`).
 *
 * Deliberately narrower than `sanitizeLogScope`: messages are written by us and
 * may legitimately contain runs of spaces, so only the characters that could
 * fabricate a second record are replaced. `detail` is exempt — it is an
 * intentionally multi-line block, rendered indented under its own record.
 */
export function sanitizeLogLine(message: string): string {
  return message.replace(CONTROL_AND_LINE_BREAKS, ' ');
}
