import * as queries from '../db/queries.js';
import type { AgentCliTool } from '../db/queries.js';
import { broadcaster } from '../websocket/broadcaster.js';

export type QuotaState = 'available' | 'exhausted' | 'unknown';

export interface ProviderQuotaStateRecord {
  tool: AgentCliTool;
  state: QuotaState;
  source: string;
  observedAt: string;
  reason: string | null;
  resetAt: string | null;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes default cooldown
const TRACKED_TOOLS: AgentCliTool[] = ['claude', 'codex', 'antigravity'];

export class ProviderQuotaService {
  private cache: Map<AgentCliTool, ProviderQuotaStateRecord> = new Map();
  private cooldownMsOverride: number | null = null;

  getCooldownMs(): number {
    if (this.cooldownMsOverride !== null) return this.cooldownMsOverride;
    const envVal = process.env.PROVIDER_QUOTA_COOLDOWN_MS;
    if (envVal !== undefined && envVal.trim() !== '') {
      const parsed = parseInt(envVal.trim(), 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    return DEFAULT_COOLDOWN_MS;
  }

  setCooldownMs(ms: number): void {
    this.cooldownMsOverride = Math.max(0, ms);
  }

  resetCooldownMs(): void {
    this.cooldownMsOverride = null;
  }

  resetForTesting(): void {
    this.cache.clear();
    this.cooldownMsOverride = null;
  }

  private isExhaustionExpired(record: ProviderQuotaStateRecord): boolean {
    if (record.state !== 'exhausted') return false;
    const now = Date.now();

    if (record.resetAt) {
      const resetTime = new Date(record.resetAt).getTime();
      if (!isNaN(resetTime)) {
        return now >= resetTime;
      }
    }

    const observedTime = new Date(record.observedAt).getTime();
    if (!isNaN(observedTime)) {
      return now - observedTime >= this.getCooldownMs();
    }

    return false;
  }

  getQuotaState(tool: AgentCliTool): ProviderQuotaStateRecord {
    let record = this.cache.get(tool);

    if (!record) {
      try {
        const row = queries.getProviderQuotaState(tool);
        if (row) {
          record = {
            tool: row.tool,
            state: row.state,
            source: row.source,
            observedAt: row.observed_at,
            reason: row.reason,
            resetAt: row.reset_at,
          };
          this.cache.set(tool, record);
        }
      } catch {
        // Table may not be initialized in some mock environments
      }
    }

    if (!record) {
      record = {
        tool,
        state: 'unknown',
        source: 'default',
        observedAt: new Date().toISOString(),
        reason: null,
        resetAt: null,
      };
      this.cache.set(tool, record);
      return record;
    }

    // Check if exhausted state has expired
    if (this.isExhaustionExpired(record)) {
      const expiredRecord: ProviderQuotaStateRecord = {
        tool,
        state: 'unknown',
        source: 'cooldown_expired',
        observedAt: new Date().toISOString(),
        reason: null,
        resetAt: null,
      };
      this.cache.set(tool, expiredRecord);
      try {
        queries.upsertProviderQuotaState({
          tool,
          state: 'unknown',
          source: 'cooldown_expired',
          observed_at: expiredRecord.observedAt,
          reason: null,
          reset_at: null,
        });
      } catch { /* ignore */ }
      return expiredRecord;
    }

    return record;
  }

  getAllQuotaStates(): ProviderQuotaStateRecord[] {
    return TRACKED_TOOLS.map((tool) => this.getQuotaState(tool));
  }

  markExhausted(
    tool: AgentCliTool,
    options: { source: string; reason?: string | null; resetAt?: string | null },
  ): ProviderQuotaStateRecord {
    const observedAt = new Date().toISOString();
    const record: ProviderQuotaStateRecord = {
      tool,
      state: 'exhausted',
      source: options.source,
      observedAt,
      reason: options.reason ?? null,
      resetAt: options.resetAt ?? null,
    };
    this.cache.set(tool, record);

    try {
      queries.upsertProviderQuotaState({
        tool,
        state: 'exhausted',
        source: options.source,
        reason: record.reason,
        observed_at: observedAt,
        reset_at: record.resetAt,
      });
    } catch { /* ignore */ }

    try {
      broadcaster.broadcast({
        type: 'quota:updated',
        tool,
        state: 'exhausted',
        reason: record.reason,
        resetAt: record.resetAt,
      });
    } catch { /* ignore */ }

    return record;
  }

  markAvailable(
    tool: AgentCliTool,
    options: { source?: string } = {},
  ): ProviderQuotaStateRecord {
    const current = this.getQuotaState(tool);
    if (current.state === 'exhausted') {
      return current;
    }

    const observedAt = new Date().toISOString();
    const record: ProviderQuotaStateRecord = {
      tool,
      state: 'available',
      source: options.source ?? 'execution_success',
      observedAt,
      reason: null,
      resetAt: null,
    };
    this.cache.set(tool, record);

    try {
      queries.upsertProviderQuotaState({
        tool,
        state: 'available',
        source: record.source,
        reason: null,
        observed_at: observedAt,
        reset_at: null,
      });
    } catch { /* ignore */ }

    try {
      broadcaster.broadcast({
        type: 'quota:updated',
        tool,
        state: 'available',
      });
    } catch { /* ignore */ }

    return record;
  }

  markUnknown(
    tool: AgentCliTool,
    options: { source?: string; reason?: string | null } = {},
  ): ProviderQuotaStateRecord {
    const observedAt = new Date().toISOString();
    const record: ProviderQuotaStateRecord = {
      tool,
      state: 'unknown',
      source: options.source ?? 'manual',
      observedAt,
      reason: options.reason ?? null,
      resetAt: null,
    };
    this.cache.set(tool, record);

    try {
      queries.upsertProviderQuotaState({
        tool,
        state: 'unknown',
        source: record.source,
        reason: record.reason,
        observed_at: observedAt,
        reset_at: null,
      });
    } catch { /* ignore */ }

    try {
      broadcaster.broadcast({
        type: 'quota:updated',
        tool,
        state: 'unknown',
        reason: record.reason,
      });
    } catch { /* ignore */ }

    return record;
  }
}

export const providerQuotaService = new ProviderQuotaService();
