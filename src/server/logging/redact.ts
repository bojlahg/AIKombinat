/**
 * Redaction layer.
 *
 * The rule from the spec is explicit: never rely on callers "just not passing a
 * secret". Every string that reaches a sink runs through here, so a credential
 * that leaked into an error message or a command line is scrubbed even when the
 * caller had no idea it was there.
 */

export const REDACTED = '***redacted***';

/**
 * Metadata keys whose value is always dropped. Substring match on a normalized
 * key, so `Authorization`, `x-api-key` and `refreshToken` all hit.
 */
// `session[-_]?id` is deliberately absent: a session id is a correlation id, not
// a credential, and blind-replacing its value mangles unrelated paths and logs.
const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|token|password|passwd|pwd|secret|cookie|credential|private[-_]?key)/;

/** Keys that merely *look* secret but are ordinary diagnostics. */
const SECRET_KEY_ALLOWLIST = new Set([
  'tokencount',
  'tokensused',
  'maxtokens',
  'inputtokens',
  'outputtokens',
  'totaltokens',
  'tokenlimit',
  'hastoken',
  'tokenpresent',
]);

/**
 * Env vars whose *value* is scrubbed out of every logged string, not just out
 * of a matching metadata key.
 */
const SECRET_ENV_KEYS = [
  'SESSION_SECRET',
  'AUTH_PASSWORD',
  'TUNNEL_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'JIRA_API_TOKEN',
  'MCP_TOKEN',
];

/** Values shorter than this are too generic to blind-replace across strings. */
const MIN_ENV_VALUE_LENGTH = 8;

const ENV_CACHE_TTL_MS = 2_000;
let envSecretCache: string[] = [];
let envSecretCacheAt = 0;

/** Test hook — forces the next redaction to re-scan `process.env`. */
export function resetRedactionCache(): void {
  envSecretCache = [];
  envSecretCacheAt = 0;
}

function collectEnvSecrets(): string[] {
  const now = Date.now();
  if (envSecretCacheAt !== 0 && now - envSecretCacheAt < ENV_CACHE_TTL_MS) {
    return envSecretCache;
  }
  const values = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
    const normalized = key.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const explicit = SECRET_ENV_KEYS.includes(key.toUpperCase());
    if (explicit || (SECRET_KEY_PATTERN.test(normalized) && !SECRET_KEY_ALLOWLIST.has(normalized.replace(/[_-]/g, '')))) {
      values.add(value);
    }
  }
  // Longest first so a value that contains another is replaced whole.
  envSecretCache = Array.from(values).sort((a, b) => b.length - a.length);
  envSecretCacheAt = now;
  return envSecretCache;
}

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_KEY_ALLOWLIST.has(normalized)) return false;
  return SECRET_KEY_PATTERN.test(key.toLowerCase());
}

/**
 * `--api-key sk-xyz`, `token=abc`, `"password": "hunter2"`, `Bearer xyz`, …
 *
 * Square brackets terminate a matched value: they delimit scope tags
 * (`[forum:x][Claude]`), so letting them into the match would swallow the
 * surrounding structure along with the secret.
 */
const INLINE_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [
    /(--?(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret|auth)(?:[=\s]+))(?:"[^"]*"|'[^']*'|\S+)/gi,
    `$1${REDACTED}`,
  ],
  [
    /((?:"|')?\b(?:authorization|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|cookie)\b(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]\[]+)/gi,
    `$1${REDACTED}`,
  ],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
];

export function redactString(value: string): string {
  if (!value) return value;
  let out = value;
  for (const secret of collectEnvSecrets()) {
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  for (const [pattern, replacement] of INLINE_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const MAX_DEPTH = 6;

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactValue(inner, depth + 1);
    }
    return out;
  }
  return redactString(String(value));
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = isSecretKey(key) ? REDACTED : redactValue(value, 1);
  }
  return out;
}

/**
 * Redacts an argv array. Handles both `--api-key=v` and the `--api-key v`
 * two-token form, which the string patterns alone cannot see once split.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
      continue;
    }
    const flagMatch = /^--?([A-Za-z0-9][A-Za-z0-9_-]*)(=)?/.exec(arg);
    if (flagMatch && isSecretKey(flagMatch[1])) {
      if (flagMatch[2]) {
        out.push(`${arg.slice(0, flagMatch[0].length)}${REDACTED}`);
      } else {
        out.push(arg);
        redactNext = true;
      }
      continue;
    }
    out.push(redactString(arg));
  }
  return out;
}
