import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { getDatabase } from '../db/connection.js';
import { logger } from '../logging/logger.js';
import { redactString } from '../logging/redact.js';
import { createChildEnvironment } from '../utils/child-environment.js';
import { assertExternalAiCliAllowed } from '../utils/cli-guard.js';

export type AccountProvider = 'claude' | 'codex' | 'antigravity';
export type AccountPolicy = 'inherited_default' | 'fixed' | 'automatic';
export type AccountHealth = 'unknown' | 'available' | 'auth_error' | 'unavailable';
export interface ProviderAccount {
  id: string; provider: AccountProvider; slug: string; label: string; description: string;
  auth_strategy: 'inherited' | 'environment_reference'; auth_config_json: string;
  is_enabled: number; health_state: AccountHealth; health_reason: string | null; last_health_at: string | null;
  max_concurrency: number; sort_order: number; created_at: string; updated_at: string;
}
export interface ProviderAccountAdapter {
  strategies: readonly ProviderAccount['auth_strategy'][];
  validateConfig(strategy: ProviderAccount['auth_strategy'], config: Record<string, unknown>): void;
  buildRuntimeContext(account: ProviderAccount): { env: Record<string, string | undefined>; secrets: string[] };
  probe(account: ProviderAccount): Promise<{ state: AccountHealth; reason: string }>;
  isAuthenticationFailure(output: string): boolean;
}
const providers = new Set(['claude', 'codex', 'antigravity']);
export const isAccountProvider = (value: string): value is AccountProvider => providers.has(value);

function inheritedAdapter(): ProviderAccountAdapter {
  return {
    strategies: ['inherited'],
    validateConfig(strategy, config) {
      if (strategy !== 'inherited' || Object.keys(config).length) throw new Error('Unsupported account strategy or configuration');
    },
    buildRuntimeContext() { return { env: {}, secrets: [] }; },
    async probe() { return { state: 'unknown', reason: 'No verified non-mutating authentication probe' }; },
    isAuthenticationFailure() { return false; },
  };
}
const claudeAdapter: ProviderAccountAdapter = {
  ...inheritedAdapter(), strategies: ['inherited', 'environment_reference'],
  isAuthenticationFailure(output) { return /"type"\s*:\s*"authentication_error"|API Error:\s*401|invalid_api_key/i.test(output); },
  validateConfig(strategy, config) {
    if (strategy === 'inherited') return inheritedAdapter().validateConfig(strategy, config);
    if (strategy !== 'environment_reference' || Object.keys(config).some(key => key !== 'variable')
      || typeof config.variable !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(config.variable)
      || ['SESSION_SECRET', 'TUNNEL_TOKEN', 'AUTH_PASSWORD'].includes(config.variable)) throw new Error('Invalid credential environment reference');
  },
  buildRuntimeContext(account) {
    if (account.auth_strategy === 'inherited') return { env: {}, secrets: [] };
    const variable = JSON.parse(account.auth_config_json).variable as string;
    const value = process.env[variable];
    if (!value) throw new Error('Account credential reference is unavailable');
    return { env: { [variable]: undefined, ANTHROPIC_API_KEY: value, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }, secrets: [value] };
  },
};
export const providerAccountAdapters: Record<AccountProvider, ProviderAccountAdapter> = {
  claude: { ...claudeAdapter, probe: account => probeCliAccount(account, ['auth', 'status', '--json']) },
  codex: { ...inheritedAdapter(), probe: account => probeCliAccount(account, ['login', 'status']), isAuthenticationFailure: output => /401 Unauthorized|authentication token (?:expired|invalid)/i.test(output) },
  antigravity: inheritedAdapter(),
};

async function probeCliAccount(account: ProviderAccount, args: string[]): Promise<{ state: AccountHealth; reason: string }> {
  if (account.auth_strategy !== 'inherited') return { state: 'unknown', reason: 'Credential reference configured; authentication requires an execution' };
  assertExternalAiCliAllowed(account.provider);
  return new Promise(resolve => execFile(account.provider, args, { env: createChildEnvironment(), windowsHide: true, timeout: 10_000, maxBuffer: 16_384 }, (error, stdout, stderr) => {
    let state: AccountHealth = 'unknown';
    if (account.provider === 'claude') {
      try { const result = JSON.parse(stdout); if (typeof result.loggedIn === 'boolean') state = result.loggedIn ? 'available' : 'auth_error'; } catch { /* unsupported CLI contract */ }
    } else if (!error && /logged in/i.test(stdout + stderr)) state = 'available';
    else if (/not logged in/i.test(stdout + stderr)) state = 'auth_error';
    resolve({ state, reason: state === 'available' ? 'CLI authentication status confirmed' : state === 'auth_error' ? 'CLI login required' : 'CLI authentication status unavailable' });
  }));
}
export const getProviderAccount = (id: string) => getDatabase().prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id) as ProviderAccount | undefined;
export const listProviderAccounts = () => getDatabase().prepare(`SELECT * FROM provider_accounts
  ORDER BY CASE WHEN health_state = 'available' AND datetime(last_health_at) >= datetime('now', '-5 minutes') THEN 0 ELSE 1 END, sort_order, created_at, id`).all() as ProviderAccount[];

export function validateAccountPolicy(provider: string, policy: unknown, id: unknown): AccountPolicy {
  if (!['inherited_default', 'fixed', 'automatic'].includes(String(policy))) throw new Error('Invalid account policy');
  if (!isAccountProvider(provider)) {
    if (policy !== 'inherited_default' || id) throw new Error('Provider is accountless');
  } else if (policy === 'fixed') {
    const account = typeof id === 'string' ? getProviderAccount(id) : undefined;
    if (!account || account.provider !== provider) throw new Error('Account does not belong to the selected provider');
  } else if (id) throw new Error('Only fixed policy accepts an account ID');
  return policy as AccountPolicy;
}

export function accountCandidates(provider: string, policy: AccountPolicy = 'inherited_default', id?: string | null): ProviderAccount[] {
  if (!isAccountProvider(provider)) return [];
  validateAccountPolicy(provider, policy, id);
  return listProviderAccounts().filter(account => account.provider === provider && (policy === 'automatic'
    || (policy === 'fixed' ? account.id === id : account.auth_strategy === 'inherited')));
}
export function accountIneligibleReason(account: ProviderAccount): string | null {
  return !account.is_enabled ? 'disabled' : ['auth_error', 'unavailable'].includes(account.health_state) ? account.health_state : null;
}
export function accountIdentity(account?: ProviderAccount, policy: AccountPolicy = 'inherited_default') {
  return { providerAccountId: account?.id ?? null, providerAccountSlug: account?.slug ?? null,
    providerAccountLabel: account?.label ?? null, providerAccountStrategy: account?.auth_strategy ?? null,
    accountPolicy: account ? policy : null };
}

export function saveProviderAccount(input: Record<string, unknown>, id?: string): ProviderAccount {
  const previous = id ? getProviderAccount(id) : undefined;
  if (id && !previous) throw new Error('Account not found');
  if (previous && (input.provider !== undefined && input.provider !== previous.provider || input.slug !== undefined && input.slug !== previous.slug)) throw new Error('Provider and slug are immutable');
  const provider = previous?.provider ?? String(input.provider);
  if (!isAccountProvider(provider)) throw new Error('Invalid account provider');
  const slug = previous?.slug ?? String(input.slug ?? '');
  const label = String(input.label ?? previous?.label ?? '');
  const description = String(input.description ?? previous?.description ?? '');
  const strategy = String(input.auth_strategy ?? previous?.auth_strategy ?? 'inherited') as ProviderAccount['auth_strategy'];
  if (previous && previous.auth_strategy !== strategy) throw new Error('Account strategy is immutable');
  const config = input.auth_config ?? JSON.parse(previous?.auth_config_json ?? '{}');
  const concurrency = input.max_concurrency ?? previous?.max_concurrency ?? 2;
  const sortOrder = input.sort_order ?? previous?.sort_order ?? 0;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) || !label.trim() || label.length > 128 || Buffer.byteLength(description) > 2048
    || !Number.isInteger(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 32 || !Number.isInteger(sortOrder)
    || !config || typeof config !== 'object' || Array.isArray(config) || Buffer.byteLength(JSON.stringify(config)) > 8192) throw new Error('Invalid account fields');
  providerAccountAdapters[provider].validateConfig(strategy, config as Record<string, unknown>);
  if (input.is_enabled !== undefined && typeof input.is_enabled !== 'boolean') throw new Error('is_enabled must be boolean');
  const changed = previous && (previous.auth_strategy !== strategy || previous.auth_config_json !== JSON.stringify(config));
  const now = new Date().toISOString();
  const accountId = id ?? randomUUID();
  getDatabase().prepare(`INSERT INTO provider_accounts (id, provider, slug, label, description, auth_strategy, auth_config_json,
    is_enabled, health_state, health_reason, last_health_at, max_concurrency, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, description=excluded.description, auth_strategy=excluded.auth_strategy,
    auth_config_json=excluded.auth_config_json, is_enabled=excluded.is_enabled, health_state=excluded.health_state,
    health_reason=excluded.health_reason, last_health_at=excluded.last_health_at, max_concurrency=excluded.max_concurrency,
    sort_order=excluded.sort_order, updated_at=excluded.updated_at`).run(accountId, provider, slug, label.trim(), description, strategy,
      JSON.stringify(config), input.is_enabled === undefined ? previous?.is_enabled ?? 1 : input.is_enabled ? 1 : 0,
      changed ? 'unknown' : previous?.health_state ?? 'unknown', changed ? null : previous?.health_reason ?? null,
      changed ? null : previous?.last_health_at ?? null, concurrency, sortOrder, previous?.created_at ?? now, now);
  logger.info(id ? 'provider-account.updated' : 'provider-account.created', { accountId, provider });
  return getProviderAccount(accountId)!;
}
export function setAccountHealth(id: string, state: AccountHealth, reason = ''): void {
  const now = new Date().toISOString();
  getDatabase().prepare('UPDATE provider_accounts SET health_state=?, health_reason=?, last_health_at=?, updated_at=? WHERE id=?')
    .run(state, redactString(reason).slice(0, 1024), now, now, id);
  logger.info('provider-account.health', { accountId: id, state });
}
export async function probeProviderAccount(id: string): Promise<ProviderAccount> {
  const account = getProviderAccount(id);
  if (!account) throw new Error('Account not found');
  try {
    providerAccountAdapters[account.provider].validateConfig(account.auth_strategy, JSON.parse(account.auth_config_json));
    providerAccountAdapters[account.provider].buildRuntimeContext(account);
    const result = await providerAccountAdapters[account.provider].probe(account);
    setAccountHealth(id, result.state, result.reason);
  } catch { setAccountHealth(id, 'unavailable', 'Account runtime context unavailable'); }
  return getProviderAccount(id)!;
}
export function buildAccountRuntime(id?: string | null) {
  if (!id) return { env: {}, secrets: [] };
  const account = getProviderAccount(id);
  if (!account) throw new Error('Account no longer exists');
  try {
    const adapter = providerAccountAdapters[account.provider];
    adapter.validateConfig(account.auth_strategy, JSON.parse(account.auth_config_json));
    const runtime = adapter.buildRuntimeContext(account);
    const references: Record<string, undefined> = {};
    for (const other of listProviderAccounts()) {
      if (other.auth_strategy === 'environment_reference') {
        const variable = JSON.parse(other.auth_config_json).variable;
        if (typeof variable === 'string') references[variable] = undefined;
      }
    }
    return { ...runtime, env: { ...references, ...runtime.env } };
  }
  catch { setAccountHealth(id, 'unavailable', 'Account runtime context unavailable'); throw new Error('Account runtime context unavailable'); }
}

export function isAccountAuthenticationFailure(id: string, output: string): boolean {
  const account = getProviderAccount(id);
  return !!account && providerAccountAdapters[account.provider].isAuthenticationFailure(output);
}

export function accountUsage(id: string, activeOnly = false, excluded: string[] = []): number {
  let count = 0;
  for (const table of ['todos', 'sessions', 'discussions', 'todo_execution_rounds', 'orchestrator_turns', 'delegation_runs', 'agent_forum_turns']) {
    const columns = getDatabase().pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some(column => column.name === 'execution_snapshot')) continue;
    const hasPid = columns.some(column => column.name === 'process_pid');
    if (activeOnly && !hasPid) continue;
    const activeClause = table === 'agent_forum_turns' ? ' WHERE process_pid > 0' : " WHERE process_pid > 0 OR status IN ('running','starting')";
    const rows = getDatabase().prepare(`SELECT id, execution_snapshot FROM ${table}${activeOnly ? activeClause : ''}`)
      .all() as { id: string; execution_snapshot: string | null }[];
    for (const row of rows) {
      if (excluded.includes(row.id)) continue;
      try { if (JSON.parse(row.execution_snapshot ?? '{}').providerAccountId === id) count++; } catch { /* legacy snapshot */ }
    }
  }
  if (!activeOnly) {
    for (const table of ['todos', 'sessions', 'schedules', 'discussion_agents', 'execution_profile_executors']) {
      count += (getDatabase().prepare(`SELECT COUNT(*) count FROM ${table} WHERE provider_account_id=?`).get(id) as { count: number }).count;
    }
  }
  return count;
}
export function deleteProviderAccount(id: string, reserved = false): void {
  if (!getProviderAccount(id)) throw new Error('Account not found');
  if (reserved || accountUsage(id)) throw new Error('Account is in use');
  if (getProviderAccount(id)!.auth_strategy === 'inherited') throw new Error('Compatibility account cannot be deleted');
  getDatabase().prepare('DELETE FROM provider_accounts WHERE id=?').run(id);
}
