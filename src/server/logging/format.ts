import type { LogRecord, LogLevel } from './types.js';

/**
 * Correlation IDs are always written to the file and kept off the console line,
 * which uses the short `[forum:test][Claude]` context instead. Both sinks see
 * the same record — only the rendering differs.
 */
const CONSOLE_HIDDEN_KEYS = new Set([
  'forumId',
  'todoId',
  'projectId',
  'sessionId',
  'discussionId',
  'turnId',
  'roundId',
  'memberId',
  'messageId',
  'scheduleId',
  'runToken',
  'accountProfileId',
]);

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `2026-08-26 01:20:12` — local time, what the operator reads in the terminal. */
export function formatConsoleTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `2026-08-26T01:30:04.215+05:00` — local time with an explicit offset. */
export function formatFileTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatPairs(fields: Record<string, unknown>, skip?: Set<string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (skip?.has(key)) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

/** Indents a detail block under the main line so it reads as one event. */
function indentDetail(detail: string, indent = '  '): string {
  return detail
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map(line => `${indent}${line}`)
    .join('\n');
}

export function renderConsoleLine(record: LogRecord): string {
  const scope = record.scope ? `${record.scope} ` : '';
  const pairs = formatPairs(record.fields, CONSOLE_HIDDEN_KEYS);
  let line = `${formatConsoleTimestamp(record.time)} ${LEVEL_LABEL[record.level]} ${scope}${record.msg}`;
  if (pairs) line += ` ${pairs}`;
  if (record.detail) line += `\n${indentDetail(record.detail)}`;
  return line;
}

export function renderFileLine(record: LogRecord): string {
  const pairs = formatPairs(record.fields);
  let line = `${formatFileTimestamp(record.time)} ${LEVEL_LABEL[record.level]} ${record.event}`;
  if (record.scope) line += ` scope=${formatValue(record.scope)}`;
  if (record.msg && record.msg !== record.event) line += ` msg=${formatValue(record.msg)}`;
  if (pairs) line += ` ${pairs}`;
  if (record.detail) line += `\n${indentDetail(record.detail, '    ')}`;
  return line;
}

export { CONSOLE_HIDDEN_KEYS };
