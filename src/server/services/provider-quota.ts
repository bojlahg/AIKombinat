import type { QuotaProviderTool } from '../db/queries.js';
import { getDatabase } from '../db/connection.js';
import { accountCandidates, accountIneligibleReason, getProviderAccount, listProviderAccounts } from './provider-account-service.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { logger } from '../logging/logger.js';
import { redactString } from '../logging/redact.js';

export type QuotaState = 'available' | 'exhausted' | 'unknown';
export interface ProviderQuotaStateRecord {
  tool: QuotaProviderTool; state: QuotaState; source: string; observedAt: string;
  reason: string | null; resetAt: string | null;
}
export interface AccountQuotaStateRecord extends ProviderQuotaStateRecord { providerAccountId: string }
type Observation = { source?: string; reason?: string | null; resetAt?: string | null };
const TRACKED_TOOLS: QuotaProviderTool[] = ['claude', 'codex', 'antigravity'];

export class ProviderQuotaService {
  private cooldownMsOverride: number | null = null;
  private listeners = new Set<() => void>();
  private compatibilityListener: (() => void) | null = null;
  private resetTimer: NodeJS.Timeout | null = null;
  private wakeQueued = false;
  private stopped = false;

  getCooldownMs(): number {
    const value = Number(process.env.PROVIDER_QUOTA_COOLDOWN_MS ?? 300000);
    return this.cooldownMsOverride ?? (Number.isFinite(value) && value >= 0 ? value : 300000);
  }
  setCooldownMs(ms: number): void { this.cooldownMsOverride = Math.max(0, ms); }
  resetCooldownMs(): void { this.cooldownMsOverride = null; }
  setAvailabilityCallback(callback: (() => void) | null): void { this.compatibilityListener = callback; }
  onAvailability(callback: () => void): () => void {
    this.listeners.add(callback); return () => this.listeners.delete(callback);
  }
  private notifyAvailable(): void {
    if (this.wakeQueued || this.stopped) return;
    this.wakeQueued = true;
    queueMicrotask(() => {
      this.wakeQueued = false;
      if (this.stopped) return;
      for (const callback of new Set([...this.listeners, ...(this.compatibilityListener ? [this.compatibilityListener] : [])])) {
        try { callback(); } catch (error) { logger.error('provider-account.quota.wake-failed', { err: error }); }
      }
    });
  }
  initialize(): void {
    this.stopped = false;
    const rows = getDatabase().prepare("SELECT provider_account_id,observed_at FROM provider_account_quota_state WHERE state='exhausted' AND reset_at IS NULL").all() as { provider_account_id: string; observed_at: string }[];
    for (const row of rows) {
      const observed = Date.parse(row.observed_at);
      getDatabase().prepare('UPDATE provider_account_quota_state SET reset_at=? WHERE provider_account_id=?').run(new Date((Number.isFinite(observed) ? observed : Date.now()) + this.getCooldownMs()).toISOString(), row.provider_account_id);
    }
    this.expire(); this.armTimer();
  }
  shutdown(): void { this.stopped = true; if (this.resetTimer) clearTimeout(this.resetTimer); this.resetTimer = null; }
  resetForTesting(): void {
    this.shutdown(); this.listeners.clear(); this.compatibilityListener = null;
    this.cooldownMsOverride = null; this.wakeQueued = false; this.stopped = false;
  }
  private armTimer(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    if (this.stopped) return;
    const deadlines = getDatabase().prepare(`SELECT reset_at FROM provider_account_quota_state q
      JOIN provider_accounts a ON a.id=q.provider_account_id WHERE q.state='exhausted' AND a.is_enabled=1`).all() as { reset_at: string }[];
    const times = deadlines.map(row => Date.parse(row.reset_at)).filter(Number.isFinite);
    if (!times.length) return;
    this.resetTimer = setTimeout(() => { this.resetTimer = null; this.expire(); this.armTimer(); }, Math.max(1, Math.min(2147483647, Math.min(...times) - Date.now())));
    this.resetTimer.unref();
  }
  private expire(): void {
    const rows = getDatabase().prepare("SELECT provider_account_id FROM provider_account_quota_state WHERE state='exhausted' AND reset_at<=?").all(new Date().toISOString()) as { provider_account_id: string }[];
    for (const row of rows) this.write(row.provider_account_id, 'unknown', { source: 'cooldown_expired' }, false);
  }
  getAccountQuotaState(id: string): AccountQuotaStateRecord {
    const account = getProviderAccount(id);
    if (!account) throw new Error('Account not found');
    const now = new Date().toISOString();
    getDatabase().prepare(`INSERT OR IGNORE INTO provider_account_quota_state
      (provider_account_id,provider,source,observed_at,created_at,updated_at) VALUES (?,?,'default',?,?,?)`).run(id, account.provider, now, now, now);
    const row = getDatabase().prepare('SELECT * FROM provider_account_quota_state WHERE provider_account_id=?').get(id) as {
      state: QuotaState; source: string; observed_at: string; reason: string | null; reset_at: string | null;
    };
    if (row.state === 'exhausted' && row.reset_at && Date.parse(row.reset_at) <= Date.now()) return this.write(id, 'unknown', { source: 'cooldown_expired' });
    return { providerAccountId: id, tool: account.provider, state: row.state, source: row.source, observedAt: row.observed_at, reason: row.reason, resetAt: row.reset_at };
  }
  getProviderAggregate(tool: QuotaProviderTool): ProviderQuotaStateRecord {
    const states = listProviderAccounts().filter(account => account.provider === tool && !accountIneligibleReason(account)).map(account => this.getAccountQuotaState(account.id));
    const state = states.some(row => row.state === 'available') ? 'available' : !states.length || states.some(row => row.state === 'unknown') ? 'unknown' : 'exhausted';
    const deadlines = states.filter(row => row.resetAt).map(row => row.resetAt!).sort();
    return { tool, state, source: 'account_aggregate', observedAt: states.map(row => row.observedAt).sort().at(-1) ?? new Date().toISOString(),
      reason: state === 'exhausted' ? states.length === 1 ? states[0].reason : 'All runnable provider accounts are quota exhausted' : null, resetAt: state === 'exhausted' ? deadlines[0] ?? null : null };
  }
  getQuotaState(tool: QuotaProviderTool): ProviderQuotaStateRecord { return this.getProviderAggregate(tool); }
  getAllQuotaStates(): ProviderQuotaStateRecord[] { return TRACKED_TOOLS.map(tool => this.getQuotaState(tool)); }
  markAccountExhausted(id: string, options: Observation): AccountQuotaStateRecord { return this.write(id, 'exhausted', options); }
  markAccountAvailable(id: string, options: Observation = {}): AccountQuotaStateRecord { return this.write(id, 'available', { source: 'execution_success', ...options }); }
  markAccountUnknown(id: string, options: Observation = {}): AccountQuotaStateRecord { return this.write(id, 'unknown', { source: 'manual_reset', ...options }); }
  accountsChanged(tool: QuotaProviderTool): void {
    broadcaster.broadcast({ type: 'quota:updated', ...this.getProviderAggregate(tool) }); this.armTimer(); this.notifyAvailable();
  }
  private write(id: string, state: QuotaState, options: Observation, arm = true): AccountQuotaStateRecord {
    const account = getProviderAccount(id);
    if (!account) throw new Error('Account not found');
    const previous = getDatabase().prepare('SELECT state FROM provider_account_quota_state WHERE provider_account_id=?').get(id) as { state: QuotaState } | undefined;
    const aggregateBefore = this.getProviderAggregateWithoutExpiry(account.provider);
    const now = new Date().toISOString();
    const reset = options.resetAt ? Date.parse(options.resetAt) : NaN;
    const resetAt = state === 'exhausted' ? new Date(Number.isFinite(reset) && reset >= Date.now() - 300000 && reset <= Date.now() + 30 * 86400000 ? reset : Date.now() + this.getCooldownMs()).toISOString() : null;
    let safeReason = options.reason ?? '';
    for (const configured of listProviderAccounts()) {
      if (configured.auth_strategy !== 'environment_reference') continue;
      const variable = JSON.parse(configured.auth_config_json).variable;
      const secret = typeof variable === 'string' ? process.env[variable] : undefined;
      if (secret) safeReason = safeReason.split(secret).join('***redacted***');
    }
    const reason = safeReason ? Buffer.from(redactString(safeReason).replace(/[\x00-\x1f\x7f]+/g, ' ')).subarray(0, 1024).toString('utf8').replace(/\uFFFD$/u, '') : null;
    const source = options.source ?? 'runtime_rejection';
    getDatabase().prepare(`INSERT INTO provider_account_quota_state
      (provider_account_id,provider,state,source,reason,observed_at,reset_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_account_id) DO UPDATE SET
      state=excluded.state,source=excluded.source,reason=excluded.reason,observed_at=excluded.observed_at,reset_at=excluded.reset_at,updated_at=excluded.updated_at`).run(id, account.provider, state, source, reason, now, resetAt, now, now);
    const record: AccountQuotaStateRecord = { providerAccountId: id, tool: account.provider, state, source, reason, observedAt: now, resetAt };
    broadcaster.broadcast({ type: 'provider-account:quota', accountId: id, quota: record });
    const aggregate = this.getProviderAggregate(account.provider);
    broadcaster.broadcast({ type: 'quota:updated', ...aggregate });
    if (aggregate.state === 'exhausted' && aggregateBefore !== 'exhausted') logger.warn('provider.quota.exhausted', { scope: `[provider:${account.provider}]`, provider: account.provider, reason: aggregate.reason });
    logger.info(`provider-account.quota.${source === 'cooldown_expired' ? 'cooldown-expired' : state}`, { accountId: id, provider: account.provider, state, source, reason, resetAt });
    if (arm) this.armTimer();
    if (previous?.state === 'exhausted' && state !== 'exhausted') this.notifyAvailable();
    return record;
  }
  private getProviderAggregateWithoutExpiry(tool: QuotaProviderTool): QuotaState {
    const rows = getDatabase().prepare(`SELECT q.state FROM provider_accounts a LEFT JOIN provider_account_quota_state q ON a.id=q.provider_account_id
      WHERE a.provider=? AND a.is_enabled=1 AND a.health_state IN ('available','unknown')`).all(tool) as { state: QuotaState | null }[];
    return rows.some(row => row.state === 'available') ? 'available' : !rows.length || rows.some(row => !row.state || row.state === 'unknown') ? 'unknown' : 'exhausted';
  }
  private inherited(tool: QuotaProviderTool): string {
    const account = accountCandidates(tool, 'inherited_default')[0];
    if (!account) throw new Error('No inherited provider account');
    return account.id;
  }
  markExhausted(tool: QuotaProviderTool, options: Observation): ProviderQuotaStateRecord { this.markAccountExhausted(this.inherited(tool), options); return this.getQuotaState(tool); }
  markAvailable(tool: QuotaProviderTool, options: Observation = {}): ProviderQuotaStateRecord {
    const id = this.inherited(tool);
    if (this.getAccountQuotaState(id).state !== 'exhausted') this.markAccountAvailable(id, options);
    return this.getQuotaState(tool);
  }
  markUnknown(tool: QuotaProviderTool, options: Observation = {}): ProviderQuotaStateRecord { this.markAccountUnknown(this.inherited(tool), options); return this.getQuotaState(tool); }
}
export const providerQuotaService = new ProviderQuotaService();
