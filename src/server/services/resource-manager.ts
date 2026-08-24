import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/connection.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { RESOURCE_CATALOG, normalizeResourceKeys, type ResourceKey } from './resource-catalog.js';

export type ResourceOwnerType = 'todo' | 'session';

export interface ResourceAcquireRequest {
  ownerType: ResourceOwnerType;
  ownerId: string;
  runToken: string;
  resources: ResourceKey[];
}

export interface ResourceLease {
  resourceKey: ResourceKey;
  ownerType: ResourceOwnerType;
  ownerId: string;
  runToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface BusyResource {
  key: ResourceKey;
  capacity: number;
  used: number;
  holders: Array<Pick<ResourceLease, 'ownerType' | 'ownerId' | 'runToken' | 'acquiredAt' | 'expiresAt'>>;
}

export interface ResourceStatus {
  key: ResourceKey;
  label: string;
  capacity: number;
  used: number;
  available: number;
  leases: ResourceLease[];
}

interface LeaseRow {
  resource_key: ResourceKey;
  amount: number;
  owner_type: ResourceOwnerType;
  owner_id: string;
  run_token: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export const RESOURCE_HEARTBEAT_INTERVAL_MS = 15_000;
export const RESOURCE_LEASE_TTL_MS = 60_000;

export class ResourceManager {
  private localRunTokens = new Set<string>();
  private recoveredRunTokens = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private availabilityCallback: (() => void) | null = null;

  constructor(
    private readonly isProcessAlive: (pid: number) => boolean = (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
  ) {}

  setAvailabilityCallback(callback: (() => void) | null): void {
    this.availabilityCallback = callback;
  }

  acquireAtomic(request: ResourceAcquireRequest):
    | { status: 'acquired'; runToken: string; resources: ResourceKey[] }
    | { status: 'busy'; busy: BusyResource[] } {
    const resources = normalizeResourceKeys(request.resources);
    if (!request.runToken) throw new Error('runToken is required');
    if (!request.ownerId) throw new Error('ownerId is required');
    if (resources.length === 0) {
      return { status: 'acquired', runToken: request.runToken, resources };
    }

    const db = getDatabase();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
    const removedKeys = new Set<ResourceKey>();
    const recoveredTokens = new Set<string>();

    const result = db.transaction(() => {
      this.reconcileExpiredInTransaction(nowIso, expiresIso, removedKeys, recoveredTokens);
      const busy: BusyResource[] = [];
      for (const key of resources) {
        const definition = RESOURCE_CATALOG.find((resource) => resource.key === key)!;
        const rows = db.prepare(
          `SELECT resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at
           FROM resource_leases WHERE resource_key = ? AND expires_at > ? ORDER BY acquired_at ASC, id ASC`
        ).all(key, nowIso) as LeaseRow[];
        const used = rows.reduce((sum, row) => sum + row.amount, 0);
        if (used + 1 > definition.capacity) {
          busy.push({
            key,
            capacity: definition.capacity,
            used,
            holders: rows.map((row) => ({
              ownerType: row.owner_type,
              ownerId: row.owner_id,
              runToken: row.run_token,
              acquiredAt: row.acquired_at,
              expiresAt: row.expires_at,
            })),
          });
        }
      }
      if (busy.length > 0) return { status: 'busy' as const, busy };

      const insert = db.prepare(
        `INSERT INTO resource_leases
          (id, resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
      );
      for (const key of resources) {
        insert.run(uuidv4(), key, request.ownerType, request.ownerId, request.runToken, nowIso, nowIso, expiresIso);
      }
      return { status: 'acquired' as const, runToken: request.runToken, resources };
    })();

    for (const token of recoveredTokens) {
      if (!this.localRunTokens.has(token)) this.recoveredRunTokens.add(token);
    }
    if (removedKeys.size > 0) this.notifyCapacityChanged([...removedKeys], true);
    if (result.status === 'acquired') {
      this.localRunTokens.add(request.runToken);
      this.recoveredRunTokens.delete(request.runToken);
      this.notifyCapacityChanged(resources, false);
    }
    return result;
  }

  releaseRun(runToken: string): number {
    const db = getDatabase();
    const rows = db.prepare('SELECT DISTINCT resource_key FROM resource_leases WHERE run_token = ?').all(runToken) as Array<{ resource_key: ResourceKey }>;
    const result = db.prepare('DELETE FROM resource_leases WHERE run_token = ?').run(runToken);
    this.forgetRun(runToken);
    if (result.changes > 0) this.notifyCapacityChanged(rows.map((row) => row.resource_key), true);
    return result.changes;
  }

  releaseOwner(ownerType: ResourceOwnerType, ownerId: string): number {
    const db = getDatabase();
    const rows = db.prepare(
      'SELECT DISTINCT resource_key, run_token FROM resource_leases WHERE owner_type = ? AND owner_id = ?'
    ).all(ownerType, ownerId) as Array<{ resource_key: ResourceKey; run_token: string }>;
    const result = db.prepare('DELETE FROM resource_leases WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
    for (const row of rows) this.forgetRun(row.run_token);
    if (result.changes > 0) this.notifyCapacityChanged([...new Set(rows.map((row) => row.resource_key))], true);
    return result.changes;
  }

  heartbeatRun(runToken: string): void {
    const now = new Date();
    getDatabase().prepare(
      'UPDATE resource_leases SET heartbeat_at = ?, expires_at = ? WHERE run_token = ?'
    ).run(now.toISOString(), new Date(now.getTime() + RESOURCE_LEASE_TTL_MS).toISOString(), runToken);
  }

  getStatus(): ResourceStatus[] {
    const nowIso = new Date().toISOString();
    const rows = getDatabase().prepare(
      `SELECT resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at
       FROM resource_leases WHERE expires_at > ? ORDER BY acquired_at ASC, id ASC`
    ).all(nowIso) as LeaseRow[];
    return RESOURCE_CATALOG.map((definition) => {
      const leases = rows.filter((row) => row.resource_key === definition.key);
      const used = leases.reduce((sum, row) => sum + row.amount, 0);
      return {
        ...definition,
        used,
        available: Math.max(0, definition.capacity - used),
        leases: leases.map((row) => ({
          resourceKey: row.resource_key,
          ownerType: row.owner_type,
          ownerId: row.owner_id,
          runToken: row.run_token,
          acquiredAt: row.acquired_at,
          heartbeatAt: row.heartbeat_at,
          expiresAt: row.expires_at,
        })),
      };
    });
  }

  recoverStaleLeases(includeAll = false): { released: number; recovered: number } {
    const db = getDatabase();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
    const removedKeys = new Set<ResourceKey>();
    const recoveredTokens = new Set<string>();
    const before = db.prepare('SELECT COUNT(*) AS count FROM resource_leases').get() as { count: number };
    db.transaction(() => this.reconcileExpiredInTransaction(nowIso, expiresIso, removedKeys, recoveredTokens, includeAll))();
    for (const token of recoveredTokens) {
      if (!this.localRunTokens.has(token)) this.recoveredRunTokens.add(token);
    }
    const after = db.prepare('SELECT COUNT(*) AS count FROM resource_leases').get() as { count: number };
    if (removedKeys.size > 0) this.notifyCapacityChanged([...removedKeys], true);
    return { released: before.count - after.count, recovered: recoveredTokens.size };
  }

  initialize(): void {
    this.recoverStaleLeases(true);
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        for (const token of [...this.localRunTokens]) this.heartbeatRun(token);
        this.heartbeatRecoveredRuns();
      }, RESOURCE_HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref?.();
    }
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.recoverStaleLeases(), RESOURCE_HEARTBEAT_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  shutdown(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.heartbeatTimer = null;
    this.sweepTimer = null;
    this.localRunTokens.clear();
    this.recoveredRunTokens.clear();
  }

  resetForTesting(): void {
    this.shutdown();
    getDatabase().prepare('DELETE FROM resource_leases').run();
    this.availabilityCallback = null;
  }

  private reconcileExpiredInTransaction(
    nowIso: string,
    expiresIso: string,
    removedKeys: Set<ResourceKey>,
    recoveredTokens: Set<string>,
    includeAll = false,
  ): void {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at
       FROM resource_leases ${includeAll ? '' : 'WHERE expires_at <= ?'} ORDER BY run_token`
    ).all(...(includeAll ? [] : [nowIso])) as LeaseRow[];
    const byRun = new Map<string, LeaseRow[]>();
    for (const row of rows) {
      const group = byRun.get(row.run_token) ?? [];
      group.push(row);
      byRun.set(row.run_token, group);
    }
    for (const [runToken, leases] of byRun) {
      if (this.localRunTokens.has(runToken)) continue;
      const row = leases[0];
      const ownerTable = row.owner_type === 'todo' ? 'todos' : 'sessions';
      const owner = db.prepare(`SELECT status, process_pid FROM ${ownerTable} WHERE id = ?`).get(row.owner_id) as
        | { status: string; process_pid: number | null }
        | undefined;
      const live = !!owner && owner.status === 'running' && !!owner.process_pid && this.isProcessAlive(owner.process_pid);
      if (live) {
        db.prepare('UPDATE resource_leases SET heartbeat_at = ?, expires_at = ? WHERE run_token = ?')
          .run(nowIso, expiresIso, runToken);
        recoveredTokens.add(runToken);
      } else {
        db.prepare('DELETE FROM resource_leases WHERE run_token = ?').run(runToken);
        for (const lease of leases) removedKeys.add(lease.resource_key);
        this.forgetRun(runToken);
      }
    }
  }

  private heartbeatRecoveredRuns(): void {
    if (this.recoveredRunTokens.size === 0) return;
    const db = getDatabase();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
    const removedKeys = new Set<ResourceKey>();

    db.transaction(() => {
      for (const runToken of [...this.recoveredRunTokens]) {
        const leases = db.prepare(
          `SELECT resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at
           FROM resource_leases WHERE run_token = ? ORDER BY id ASC`
        ).all(runToken) as LeaseRow[];
        if (leases.length === 0) {
          this.forgetRun(runToken);
          continue;
        }
        const row = leases[0];
        const ownerTable = row.owner_type === 'todo' ? 'todos' : 'sessions';
        const owner = db.prepare(`SELECT status, process_pid FROM ${ownerTable} WHERE id = ?`).get(row.owner_id) as
          | { status: string; process_pid: number | null }
          | undefined;
        const live = !!owner && owner.status === 'running' && !!owner.process_pid && this.isProcessAlive(owner.process_pid);
        if (live) {
          db.prepare('UPDATE resource_leases SET heartbeat_at = ?, expires_at = ? WHERE run_token = ?')
            .run(nowIso, expiresIso, runToken);
        } else {
          db.prepare('DELETE FROM resource_leases WHERE run_token = ?').run(runToken);
          for (const lease of leases) removedKeys.add(lease.resource_key);
          this.forgetRun(runToken);
        }
      }
    })();

    if (removedKeys.size > 0) this.notifyCapacityChanged([...removedKeys], true);
  }

  private forgetRun(runToken: string): void {
    this.localRunTokens.delete(runToken);
    this.recoveredRunTokens.delete(runToken);
  }

  private notifyCapacityChanged(resourceKeys: ResourceKey[], wakeWaiters: boolean): void {
    if (resourceKeys.length === 0) return;
    broadcaster.broadcast({ type: 'resource:updated', resourceKeys: [...new Set(resourceKeys)] });
    if (wakeWaiters) this.availabilityCallback?.();
  }
}

export const resourceManager = new ResourceManager();
