import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/connection.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { normalizeResourceRequirements, type ResourceKey } from './resource-catalog.js';
import { canonicalJson, hasResourceRequirements, toFabricRequirements, type ResourceRequirements } from './resource-requirements.js';
import { getComputeNodes, getResourceInstances, resourceLeaseTotals } from './resource-fabric.js';
import { externallyBusy, matchResources } from './resource-matcher.js';
import type { FabricBinding } from './resource-fabric-types.js';
import { logger } from '../logging/logger.js';

export type ResourceOwnerType = 'todo' | 'session' | 'orchestrator' | 'reviewer';

export interface ResourceAcquireRequest {
  ownerType: ResourceOwnerType;
  ownerId: string;
  runToken: string;
  resources: ResourceRequirements;
  allowedTransports?: Array<'local' | 'ssh'>;
  workspacePath?: string;
  requestId?: string;
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

function allowedTransport(request: ResourceAcquireRequest, transport: 'local' | 'ssh'): boolean {
  return !request.allowedTransports || request.allowedTransports.includes(transport);
}

export class ResourceManager {
  private localRunTokens = new Set<string>();
  private recoveredRunTokens = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private availabilityCallback: (() => void) | null = null;

  constructor(
    private readonly isProcessAlive: (pid: number) => boolean = (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    },
  ) {}

  setAvailabilityCallback(callback: (() => void) | null): void {
    this.availabilityCallback = callback;
  }

  acquireAtomic(request: ResourceAcquireRequest):
    | { status: 'acquired'; runToken: string; resources: ResourceKey[]; binding?: FabricBinding }
    | { status: 'busy'; busy: BusyResource[] } {
    const normalized = normalizeResourceRequirements(request.resources);
    const resources = Array.isArray(normalized) ? normalized : [];
    if (!request.runToken) throw new Error('runToken is required');
    if (!request.ownerId) throw new Error('ownerId is required');
    if (!hasResourceRequirements(normalized)) {
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
      if (request.ownerType === 'todo') {
        const reserved = db.prepare(`SELECT r.id, r.run_token, b.binding_json FROM orchestrator_child_jobs j
          JOIN orchestrator_resource_requests o ON o.id = j.resource_request_id JOIN resource_requests r ON r.id = o.id
          JOIN resource_bindings b ON b.request_id = r.id WHERE j.todo_id = ? AND r.owner_type = 'orchestrator'
          AND r.status = 'bound' AND o.claim_expires_at > ? AND o.claimed_todo_id IS NULL`).get(request.ownerId, nowIso) as { id: string; run_token: string; binding_json: string } | undefined;
        if (reserved) {
          const binding = JSON.parse(reserved.binding_json) as FabricBinding;
          if (canonicalJson(toFabricRequirements(normalized)) !== (db.prepare('SELECT requirements_json FROM resource_requests WHERE id = ?').get(reserved.id) as { requirements_json: string }).requirements_json) throw new Error('resource_requirement_conflict');
          if (!db.prepare('SELECT id FROM resource_leases WHERE run_token = ?').get(reserved.run_token)) throw new Error('reservation_lease_missing');
          if (!allowedTransport(request, binding.transport)) throw new Error('reserved_transport_unsupported');
          db.prepare("UPDATE resource_requests SET owner_type = 'todo', owner_id = ?, run_token = ?, status = 'claimed' WHERE id = ?").run(request.ownerId, request.runToken, reserved.id);
          db.prepare("UPDATE resource_leases SET owner_type = 'todo', owner_id = ?, run_token = ?, heartbeat_at = ?, expires_at = ? WHERE run_token = ?").run(request.ownerId, request.runToken, nowIso, expiresIso, reserved.run_token);
          db.prepare('UPDATE orchestrator_resource_requests SET claimed_todo_id = ? WHERE id = ?').run(request.ownerId, reserved.id);
          this.forgetRun(reserved.run_token);
          logger.info('orchestrator.resource.claimed', { requestId: reserved.id, todoId: request.ownerId, bindingId: binding.id });
          const keys = db.prepare('SELECT resource_key FROM resource_binding_items WHERE binding_id = ? ORDER BY id').all(binding.id) as { resource_key: string }[];
          return { status: 'acquired' as const, runToken: request.runToken, resources: keys.map(item => item.resource_key), binding };
        }
      }
      const existing = db.prepare('SELECT b.binding_json FROM resource_bindings b JOIN resource_requests r ON r.id = b.request_id WHERE r.run_token = ?').get(request.runToken) as { binding_json: string } | undefined;
      if (existing) {
        if (!db.prepare('SELECT id FROM resource_leases WHERE run_token = ?').get(request.runToken)) throw new Error('Execution attempt already released; use a new run token');
        return { status: 'acquired' as const, runToken: request.runToken, resources, binding: JSON.parse(existing.binding_json) as FabricBinding };
      }
      const requirement = toFabricRequirements(normalized);
      const nodes = getComputeNodes();
      const allowed = request.allowedTransports ?? (request.ownerType === 'session' ? ['local'] : ['local', 'ssh']);
      const instances = getResourceInstances(), leased = resourceLeaseTotals();
      const decision = matchResources(requirement, nodes.filter(node => allowed.includes(node.transport)).map(node => ({ node, instances: instances.filter(instance => instance.node_id === node.id), leased, workspacePath: request.workspacePath })));
      const waiting = request.requestId ? { id: request.requestId } : db.prepare("SELECT id FROM resource_requests WHERE owner_type = ? AND owner_id = ? AND status IN ('pending', 'waiting') ORDER BY created_at, id LIMIT 1").get(request.ownerType, request.ownerId) as { id: string } | undefined;
      const requestId = waiting?.id ?? uuidv4();
      const owner = db.prepare(`SELECT ${request.ownerType === 'todo' ? 'priority' : '0 AS priority'} FROM ${request.ownerType === 'todo' ? 'todos' : request.ownerType === 'orchestrator' ? 'orchestrators' : request.ownerType === 'reviewer' ? 'consensus_review_attempts' : 'sessions'} WHERE id = ?`).get(request.ownerId) as { priority: number } | undefined;
      if (!owner) throw new Error('Resource owner does not exist');
      db.prepare(`INSERT INTO resource_requests (id, owner_type, owner_id, run_token, requirements_json, status, priority, reasons_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET run_token = excluded.run_token, requirements_json = excluded.requirements_json, status = excluded.status, priority = excluded.priority, reasons_json = excluded.reasons_json`).run(requestId, request.ownerType, request.ownerId, request.runToken, canonicalJson(requirement), decision.binding ? 'bound' : 'waiting', owner.priority, canonicalJson(decision.rejected), nowIso);
      if (!decision.binding) {
        const busy: BusyResource[] = [];
        for (const key of resources) {
          const instance = instances.find(instance => instance.legacy_key === key || instance.id === key)!;
          const rows = db.prepare('SELECT * FROM resource_leases WHERE resource_key IN (?, ?) ORDER BY acquired_at, id').all(key, instance.id) as LeaseRow[];
          if (rows.length) busy.push({ key, capacity: 1, used: rows.reduce((sum, row) => sum + row.amount, 0), holders: rows.map(row => ({ ownerType: row.owner_type, ownerId: row.owner_id, runToken: row.run_token, acquiredAt: row.acquired_at, expiresAt: row.expires_at })) });
        }
        if (!busy.length) busy.push({ key: decision.rejected.flatMap(rejected => rejected.reasons).join(', ') || 'no_eligible_compute_node', capacity: 0, used: 0, holders: [] });
        return { status: 'busy' as const, busy };
      }
      const binding: FabricBinding = { ...decision.binding, id: uuidv4(), request_id: requestId };
      if (binding.transport === 'ssh') binding.remote_workspace = `${nodes.find(node => node.id === binding.node_id)!.connection!.workspace_root.replace(/\/$/, '')}/jobs/${binding.id}/repo`;
      db.prepare('INSERT INTO resource_bindings VALUES (?, ?, ?, ?, ?)').run(binding.id, requestId, binding.node_id, canonicalJson(binding), nowIso);
      const items = binding.resource_instances.map(id => { const instance = instances.find(instance => instance.id === id)!; return { instance: id, key: resources.includes(instance.legacy_key ?? '') ? instance.legacy_key! : id, amount: 1 }; });
      if (binding.capacity.cpu_threads) items.push({ instance: '', key: `node/${binding.node_id}/cpu`, amount: binding.capacity.cpu_threads });
      if (binding.capacity.memory_bytes) items.push({ instance: '', key: `node/${binding.node_id}/memory`, amount: binding.capacity.memory_bytes });
      if (!items.length) items.push({ instance: '', key: `node/${binding.node_id}/execution`, amount: 1 });
      const insert = db.prepare(
        `INSERT INTO resource_leases
          (id, resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at, binding_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        db.prepare('INSERT INTO resource_binding_items VALUES (?, ?, ?, ?, ?)').run(uuidv4(), binding.id, item.instance || null, item.key, item.amount);
        insert.run(uuidv4(), item.key, item.amount, request.ownerType, request.ownerId, request.runToken, nowIso, nowIso, expiresIso, binding.id);
      }
      return { status: 'acquired' as const, runToken: request.runToken, resources: items.map(item => item.key), binding };
    }).immediate();

    for (const token of recoveredTokens) {
      if (!this.localRunTokens.has(token)) this.recoveredRunTokens.add(token);
    }
    if (removedKeys.size > 0) this.notifyCapacityChanged([...removedKeys], true);
    if (result.status === 'acquired') {
      if (request.ownerType !== 'orchestrator') this.localRunTokens.add(request.runToken);
      this.recoveredRunTokens.delete(request.runToken);
      this.notifyCapacityChanged(result.resources, false);
      broadcaster.broadcast({ type: 'resource-binding:updated', runToken: request.runToken });
      // Individual lease bookkeeping stays at DEBUG — one line per admission
      // check would swamp the log without telling the operator anything.
      logger.info('resource.lease.acquired', {
        msg: `acquired ${result.resources.join(', ')}`,
        resources: result.resources.join(','),
        ownerType: request.ownerType,
        ownerId: request.ownerId,
        runToken: request.runToken,
      });
    } else {
      broadcaster.broadcast({ type: 'resource-request:updated', runToken: request.runToken });
      logger.warn('resource.unavailable', {
        msg: `resource unavailable: ${result.busy.map(b => `${b.key} (${b.used}/${b.capacity})`).join(', ')}`,
        resources: result.busy.map(b => b.key).join(','),
        ownerType: request.ownerType,
        ownerId: request.ownerId,
      });
    }
    return result;
  }

  releaseRun(runToken: string): number {
    const db = getDatabase();
    const rows = db.prepare('SELECT DISTINCT resource_key FROM resource_leases WHERE run_token = ?').all(runToken) as Array<{ resource_key: ResourceKey }>;
    const result = db.transaction(() => {
      const removed = db.prepare('DELETE FROM resource_leases WHERE run_token = ?').run(runToken);
      db.prepare("UPDATE resource_requests SET status = 'cancelled' WHERE run_token = ? AND status IN ('pending', 'waiting')").run(runToken);
      this.applyDesiredPolicies();
      return removed;
    }).immediate();
    this.forgetRun(runToken);
    if (result.changes > 0) {
      this.notifyCapacityChanged(rows.map((row) => row.resource_key), true);
      logger.info('resource.lease.released', {
        msg: `released ${rows.map(r => r.resource_key).join(', ')}`,
        resources: rows.map(r => r.resource_key).join(','),
        runToken,
      });
    }
    return result.changes;
  }

  releaseOwner(ownerType: ResourceOwnerType, ownerId: string): number {
    const db = getDatabase();
    const rows = db.prepare(
      'SELECT DISTINCT resource_key, run_token FROM resource_leases WHERE owner_type = ? AND owner_id = ?'
    ).all(ownerType, ownerId) as Array<{ resource_key: ResourceKey; run_token: string }>;
    const result = db.transaction(() => {
      const removed = db.prepare('DELETE FROM resource_leases WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
      db.prepare("UPDATE resource_requests SET status = 'cancelled' WHERE owner_type = ? AND owner_id = ? AND status IN ('pending', 'waiting')").run(ownerType, ownerId);
      this.applyDesiredPolicies(); return removed;
    }).immediate();
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
    const nodes = getComputeNodes();
    const rows = getDatabase().prepare(
      `SELECT resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at
       FROM resource_leases ORDER BY acquired_at ASC, id ASC`
    ).all() as LeaseRow[];
    return getResourceInstances().map((instance) => {
      const node = nodes.find(node => node.id === instance.node_id)!;
      const definition = { key: instance.legacy_key ?? instance.id, label: instance.model, capacity: node.enabled && node.scheduler_state === 'online' && !node.identity_changed && instance.present && instance.policy === 'enabled' && !instance.desired_policy && !(instance.kind === 'gpu' && node.policy.avoid_external_gpu && externallyBusy(node, instance)) ? 1 : 0 };
      const leases = rows.filter((row) => row.resource_key === definition.key || row.resource_key === instance.id);
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
    const released = before.count - after.count;
    if (released > 0) {
      logger.warn('resource.stale-lease.recovered', {
        msg: `recovered ${released} stale resource lease(s)`,
        released,
        recoveredRuns: recoveredTokens.size,
        resources: [...removedKeys].join(','),
      });
    }
    return { released, recovered: recoveredTokens.size };
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
      if (row.owner_type === 'orchestrator') {
        const hold = db.prepare(`SELECT o.claim_expires_at, r.status FROM orchestrator_resource_requests o
          JOIN resource_requests r ON r.id = o.id JOIN orchestrators p ON p.id = o.orchestrator_id
          WHERE r.run_token = ? AND p.status NOT IN ('completed','failed','cancelled','paused','cancelling')`).get(runToken) as { claim_expires_at: string | null; status: string } | undefined;
        if (hold?.status === 'bound' && hold.claim_expires_at && hold.claim_expires_at > nowIso) {
          db.prepare('UPDATE resource_leases SET expires_at = ? WHERE run_token = ?').run(hold.claim_expires_at, runToken);
        } else {
          db.prepare('DELETE FROM resource_leases WHERE run_token = ?').run(runToken);
          for (const lease of leases) removedKeys.add(lease.resource_key);
        }
        continue;
      }
      const ownerTable = row.owner_type === 'todo' ? 'todos' : row.owner_type === 'reviewer' ? 'consensus_review_attempts' : 'sessions';
      const owner = db.prepare(`SELECT status, process_pid FROM ${ownerTable} WHERE id = ?`).get(row.owner_id) as
        | { status: string; process_pid: number | null }
        | undefined;
      // A persisted live PID remains owned even when startup recovery changed
      // its owner to failed because identity was mismatched/unverifiable.
      const live = this.ownerMayBeLive(runToken, owner);
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
        const ownerTable = row.owner_type === 'todo' ? 'todos' : row.owner_type === 'reviewer' ? 'consensus_review_attempts' : 'sessions';
        const owner = db.prepare(`SELECT status, process_pid FROM ${ownerTable} WHERE id = ?`).get(row.owner_id) as
          | { status: string; process_pid: number | null }
          | undefined;
        const live = this.ownerMayBeLive(runToken, owner);
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

  private ownerMayBeLive(runToken: string, owner: { process_pid: number | null } | undefined): boolean {
    const remote = getDatabase().prepare(`SELECT e.status FROM remote_executions e JOIN resource_bindings b ON b.id = e.binding_id JOIN resource_requests r ON r.id = b.request_id WHERE r.run_token = ?`).get(runToken) as { status: string } | undefined;
    if (remote) return remote.status !== 'exited';
    try { return !!owner?.process_pid && this.isProcessAlive(owner.process_pid); } catch { return !!owner?.process_pid; }
  }

  private applyDesiredPolicies(): void {
    getDatabase().prepare(`UPDATE resource_instances SET policy = desired_policy, desired_policy = NULL WHERE desired_policy IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM resource_leases WHERE resource_key = resource_instances.id OR resource_key = resource_instances.legacy_key)`).run();
  }

  private notifyCapacityChanged(resourceKeys: ResourceKey[], wakeWaiters: boolean): void {
    if (resourceKeys.length === 0) return;
    if (wakeWaiters) this.applyDesiredPolicies();
    broadcaster.broadcast({ type: 'resource:updated', resourceKeys: [...new Set(resourceKeys)] });
    broadcaster.broadcast({ type: 'resource-lease:updated' });
    if (wakeWaiters) this.availabilityCallback?.();
  }
}

export const resourceManager = new ResourceManager();
