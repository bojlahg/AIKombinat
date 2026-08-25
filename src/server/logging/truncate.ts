/**
 * Caps for provider output. Raw stdout/stderr is never logged in full — a
 * failed run gets a bounded tail and nothing more.
 */
export const DEFAULT_OUTPUT_TAIL_BYTES = 4 * 1024;
export const DEBUG_OUTPUT_TAIL_BYTES = 16 * 1024;
/** Hard ceiling for any single rendered field, whatever the caller asks for. */
export const ABSOLUTE_TAIL_BYTES = 64 * 1024;

/**
 * Returns the last `maxBytes` of `text`, prefixed with a marker when anything
 * was dropped. Byte-oriented (UTF-8) so a cap means what it says on disk.
 */
export function tailOf(text: string | null | undefined, maxBytes = DEFAULT_OUTPUT_TAIL_BYTES): string {
  if (!text) return '';
  const cap = Math.max(0, Math.min(maxBytes, ABSOLUTE_TAIL_BYTES));
  if (cap === 0) return '';
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= cap) return text;
  const omitted = buf.length - cap;
  // Slice on a byte boundary, then drop a leading replacement char produced by
  // cutting a multi-byte sequence in half.
  const sliced = buf.subarray(buf.length - cap).toString('utf-8').replace(/^�+/, '');
  return `...[truncated, ${omitted} byte(s) omitted]\n${sliced}`;
}

/** Single-line clamp for short metadata values (reasons, messages). */
export function clampLine(text: string | null | undefined, maxChars = 500): string {
  if (!text) return '';
  const oneLine = text.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars)}...`;
}
