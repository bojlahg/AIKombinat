import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { getDatabase } from '../db/connection.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { logger } from '../logging/logger.js';
import { scanNode, runProbe, sshArgs, connectionSchema, boundedDiagnostic, type CommandRunner } from './resource-probes.js';
import type { ComputeNode, NodeConnection, NodePolicy, ResourceInstance, SchedulerState } from './resource-fabric-types.js';
import { externallyBusy } from './resource-matcher.js';
import { canonicalJson } from './resource-requirements.js';

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const policySchema = z.object({ cpu_reserve_threads: bytes.max(65536), memory_reserve_bytes: bytes, storage_reserve_bytes: bytes, memory_safety_bytes: bytes, avoid_external_gpu: z.boolean(), capability_overrides: z.record(z.string().max(64).regex(/^[\w.-]+$/), z.union([z.boolean(), z.string().max(128).regex(/^[\w .+-]+$/)])).refine(value => Object.keys(value).length <= 32) }).strict();
export const DEFAULT_NODE_POLICY: NodePolicy = { cpu_reserve_threads: 0, memory_reserve_bytes: 0, storage_reserve_bytes: 0, memory_safety_bytes: 1024 ** 3, avoid_external_gpu: true, capability_overrides: {} };

export function getComputeNodes(): ComputeNode[] {
  const db = getDatabase();
  const rows = db.prepare(`SELECT n.*, c.connection_json, p.policy_json, o.observation_json,
    (SELECT inventory_json FROM inventory_snapshots WHERE node_id = n.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS inventory_json
    FROM compute_nodes n LEFT JOIN compute_node_connections c ON c.node_id = n.id
    LEFT JOIN resource_policies p ON p.node_id = n.id LEFT JOIN resource_observations o ON o.node_id = n.id ORDER BY n.transport, n.name, n.id`).all() as Array<ComputeNode & { connection_json: string | null; inventory_json: string | null; policy_json: string | null; observation_json: string | null }>;
  return rows.map(({ connection_json, inventory_json, policy_json, observation_json, ...node }) => ({ ...node, enabled: !!node.enabled, identity_changed: !!node.identity_changed, connection: connection_json ? JSON.parse(connection_json) : null, inventory: inventory_json ? JSON.parse(inventory_json) : null, policy: policy_json ? JSON.parse(policy_json) : { ...DEFAULT_NODE_POLICY }, observation: observation_json ? JSON.parse(observation_json) : null }));
}
export function getComputeNode(id: string): ComputeNode { const node = getComputeNodes().find(node => node.id === id); if (!node) throw new Error('Compute node not found'); return node; }
export function getResourceInstances(nodeId?: string): ResourceInstance[] { return getDatabase().prepare(`SELECT * FROM resource_instances ${nodeId ? 'WHERE node_id = ?' : ''} ORDER BY node_id, local_index, id`).all(...(nodeId ? [nodeId] : [])) as ResourceInstance[]; }
export function resourceLeaseTotals(): Record<string, number> {
  return Object.fromEntries((getDatabase().prepare('SELECT resource_key, SUM(amount) amount FROM resource_leases GROUP BY resource_key').all() as Array<{ resource_key: string; amount: number }>).map(row => [row.resource_key, row.amount]));
}

export class ResourceFabric {
  private flights = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private generation = 0;
  private polling = false;
  private wake: (() => void) | null = null;
  constructor(private runner: CommandRunner = runProbe) {}
  setAvailabilityCallback(callback: (() => void) | null) { this.wake = callback; }
  changed(type: 'resource-node:updated' | 'resource-inventory:updated' | 'resource-observation:updated', nodeId: string, wake = true) {
    broadcaster.broadcast({ type, nodeId }); if (wake) this.wake?.();
  }
  createSshNode(name: string, connection: NodeConnection): ComputeNode {
    const id = uuid(); connectionSchema.parse(connection); z.string().trim().min(1).max(128).parse(name);
    const db = getDatabase();
    db.transaction(() => { db.prepare("INSERT INTO compute_nodes (id, name, transport, scheduler_state) VALUES (?, ?, 'ssh', 'offline')").run(id, name); db.prepare('INSERT INTO compute_node_connections VALUES (?, ?)').run(id, canonicalJson(connection)); })();
    this.changed('resource-node:updated', id); return getComputeNode(id);
  }
  updateNode(id: string, updates: { name?: string; enabled?: boolean; scheduler_state?: SchedulerState; connection?: NodeConnection }) {
    const node = getComputeNode(id), db = getDatabase();
    if (updates.connection && node.transport !== 'ssh') throw new Error('Local node has no SSH connection');
    if (updates.connection && db.prepare('SELECT id FROM resource_bindings WHERE node_id = ? AND id IN (SELECT binding_id FROM resource_leases)').get(id)) throw new Error('Drain node and resolve active leases before changing connection');
    if (updates.name !== undefined) z.string().trim().min(1).max(128).parse(updates.name);
    if (updates.enabled !== undefined) z.boolean().parse(updates.enabled);
    if (updates.scheduler_state) z.enum(['online', 'draining', 'maintenance', 'offline', 'disabled']).parse(updates.scheduler_state);
    db.transaction(() => {
      if (updates.connection) { connectionSchema.parse(updates.connection); db.prepare('UPDATE compute_node_connections SET connection_json = ? WHERE node_id = ?').run(canonicalJson(updates.connection), id); db.prepare("UPDATE compute_nodes SET scheduler_state = 'offline', identity_changed = 0 WHERE id = ?").run(id); }
      db.prepare('UPDATE compute_nodes SET name = ?, enabled = ?, scheduler_state = ? WHERE id = ?').run(updates.name ?? node.name, updates.enabled === undefined ? Number(node.enabled) : Number(updates.enabled), updates.enabled === false ? 'disabled' : updates.scheduler_state ?? (updates.enabled === true ? 'offline' : node.scheduler_state), id);
    })();
    logger.info(updates.scheduler_state === 'draining' ? 'node.draining' : updates.scheduler_state === 'maintenance' ? 'node.maintenance' : 'node.policy.updated', { msg: 'Node scheduling policy updated', nodeId: id });
    this.changed('resource-node:updated', id); return getComputeNode(id);
  }
  deleteNode(id: string) {
    if (getComputeNode(id).transport === 'local') throw new Error('Local node cannot be deleted');
    if (getDatabase().prepare('SELECT id FROM resource_bindings WHERE node_id = ?').get(id)) throw new Error('Node has execution history; disable it instead');
    getDatabase().prepare('DELETE FROM compute_nodes WHERE id = ?').run(id); this.changed('resource-node:updated', id);
  }
  updatePolicy(id: string, value: NodePolicy) { getComputeNode(id); const policy = policySchema.parse(value); getDatabase().prepare('INSERT INTO resource_policies VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET policy_json = excluded.policy_json').run(id, canonicalJson(policy)); this.changed('resource-node:updated', id); return policy; }
  setInstancePolicy(id: string, policy: ResourceInstance['policy'], afterCurrent = false, reason?: string) {
    z.enum(['enabled', 'reserved', 'disabled']).parse(policy);
    const instance = getResourceInstances().find(instance => instance.id === id); if (!instance) throw new Error('Resource instance not found');
    if (reason !== undefined) z.string().max(128).regex(/^[\p{L}\p{N} .,()-]*$/u).parse(reason);
    const totals = resourceLeaseTotals(); const busy = (totals[id] ?? 0) + (instance.legacy_key ? totals[instance.legacy_key] ?? 0 : 0) > 0;
    const pending = afterCurrent && busy && policy === 'reserved';
    getDatabase().prepare('UPDATE resource_instances SET policy = ?, desired_policy = ?, reserve_reason = ? WHERE id = ?').run(pending ? instance.policy : policy, pending ? 'reserved' : null, reason ?? null, id);
    this.changed('resource-node:updated', instance.node_id);
  }
  async testConnection(id: string) {
    const node = getComputeNode(id); if (node.transport !== 'ssh') return { status: 'connected' };
    const result = await this.runner('ssh', sshArgs(node.connection!, 'uname -s'), 8000);
    return { status: result.code === 0 ? 'connected' : /host key verification|authenticity|REMOTE HOST IDENTIFICATION/i.test(result.stderr) ? 'manual_action_required' : 'failed', error: result.code === 0 ? undefined : boundedDiagnostic(result.stderr || 'SSH probe timed out') };
  }
  scan(id: string): Promise<unknown> {
    const existing = this.flights.get(id); if (existing) return existing;
    const generation = this.generation;
    const flight = this.performScan(id, generation).finally(() => this.flights.delete(id)); this.flights.set(id, flight); return flight;
  }
  private async performScan(id: string, generation: number) {
    const node = getComputeNode(id);
    try {
      const result = await scanNode(node, this.runner);
      if (generation !== this.generation) return { discarded: true };
      const fresh = getComputeNode(id), db = getDatabase();
      if (canonicalJson(node.connection) !== canonicalJson(fresh.connection)) return { discarded: true };
      if (fresh.identity && fresh.identity !== result.identity) {
        db.prepare("UPDATE compute_nodes SET identity_changed = 1, scheduler_state = 'offline', last_error = 'identity_changed' WHERE id = ?").run(id);
        this.changed('resource-node:updated', id); throw new Error('identity_changed');
      }
      const structural = (inventory: ComputeNode['inventory']) => inventory ? { platform: inventory.platform, cpu: inventory.cpu, memory_total: inventory.memory.total_bytes, storage: inventory.storage.map(({ mount, total_bytes, filesystem }) => ({ mount, total_bytes, filesystem })), gpus: inventory.gpus, capabilities: inventory.capabilities } : null;
      const old = structural(fresh.inventory), next = structural(result.inventory);
      const diff = old === null ? ['initial_inventory'] : Object.keys(next!).filter(key => canonicalJson((old as unknown as Record<string, unknown>)[key]) !== canonicalJson((next as unknown as Record<string, unknown>)[key])).map(key => `changed:${key}`);
      const oldExternal = getResourceInstances(id).filter(instance => instance.kind === 'gpu' && externallyBusy(fresh, instance)).map(instance => instance.id).sort().join(',');
      db.transaction(() => {
        db.prepare('INSERT INTO inventory_snapshots VALUES (?, ?, ?, ?, ?)').run(uuid(), id, canonicalJson(result.inventory), canonicalJson(diff), result.observation.timestamp);
        db.prepare('DELETE FROM inventory_snapshots WHERE node_id = ? AND id NOT IN (SELECT id FROM inventory_snapshots WHERE node_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5)').run(id, id);
        db.prepare('UPDATE resource_instances SET present = 0 WHERE node_id = ? AND origin = ?').run(id, 'detected');
        for (const gpu of result.inventory.gpus) {
          let instance = db.prepare('SELECT * FROM resource_instances WHERE node_id = ? AND hardware_uuid = ?').get(id, gpu.hardware_uuid) as ResourceInstance | undefined;
          if (!instance && node.transport === 'local' && gpu.local_index === 0) {
            const legacy = getResourceInstances(id).find(instance => instance.legacy_key === 'gpu.0' && instance.kind === 'custom');
            if (legacy) { db.prepare("UPDATE resource_instances SET hardware_uuid = ?, kind = 'gpu', origin = 'detected' WHERE id = ?").run(gpu.hardware_uuid, legacy.id); instance = { ...legacy, hardware_uuid: gpu.hardware_uuid }; }
          }
          if (instance) db.prepare('UPDATE resource_instances SET local_index = ?, model = ?, vram_bytes = ?, present = 1 WHERE id = ?').run(gpu.local_index, gpu.model, gpu.vram_bytes, instance.id);
          else db.prepare("INSERT INTO resource_instances (id, node_id, kind, hardware_uuid, local_index, model, vram_bytes, origin) VALUES (?, ?, 'gpu', ?, ?, ?, ?, 'detected')").run(uuid(), id, gpu.hardware_uuid, gpu.local_index, gpu.model, gpu.vram_bytes);
        }
        db.prepare('INSERT INTO resource_observations VALUES (?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET observation_json = excluded.observation_json, observed_at = excluded.observed_at').run(id, canonicalJson(result.observation), result.observation.timestamp);
        const state = !fresh.enabled ? 'disabled' : ['draining', 'maintenance'].includes(fresh.scheduler_state) ? fresh.scheduler_state : 'online';
        db.prepare('UPDATE compute_nodes SET identity = ?, last_scan_at = ?, last_health_at = ?, last_error = NULL, scheduler_state = ? WHERE id = ?').run(result.identity, result.observation.timestamp, result.observation.timestamp, state, id);
      })();
      const newExternal = getResourceInstances(id).filter(instance => instance.kind === 'gpu' && externallyBusy(getComputeNode(id), instance)).map(instance => instance.id).sort().join(',');
      if (oldExternal !== newExternal && newExternal) logger.info('resource.external-usage.detected', { msg: 'External GPU workload observed', nodeId: id });
      if (diff.length) { logger.info('node.scan.completed', { msg: 'Node inventory scanned', nodeId: id, changes: diff.length }); this.changed('resource-inventory:updated', id); }
      if (node.scheduler_state !== getComputeNode(id).scheduler_state) logger.info('node.health.changed', { msg: 'Node health changed', nodeId: id, state: getComputeNode(id).scheduler_state });
      const headroomImproved = result.observation.memory_available_bytes > (fresh.observation?.memory_available_bytes ?? 0) || result.observation.storage.some(volume => volume.free_bytes > (fresh.observation?.storage.find(previous => previous.mount === volume.mount)?.free_bytes ?? 0));
      this.changed('resource-observation:updated', id, diff.length > 0 || headroomImproved || oldExternal !== newExternal || fresh.scheduler_state !== getComputeNode(id).scheduler_state); return { node: getComputeNode(id), diff };
    } catch (error) {
      if (generation !== this.generation) throw error;
      const fresh = getComputeNode(id);
      const state = !fresh.enabled ? 'disabled' : ['draining', 'maintenance'].includes(fresh.scheduler_state) ? fresh.scheduler_state : 'offline';
      getDatabase().prepare('UPDATE compute_nodes SET scheduler_state = ?, last_error = ? WHERE id = ?').run(state, boundedDiagnostic(error instanceof Error ? error.message : String(error)), id);
      if (fresh.scheduler_state !== state) { logger.warn('node.health.changed', { msg: 'Node probe failed; leases retained', nodeId: id, state }); this.changed('resource-node:updated', id); }
      throw error;
    }
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try { for (const node of getComputeNodes().filter(node => node.enabled)) { if (this.stopped) break; try { await this.scan(node.id); } catch { /* bounded node error already recorded */ } } } finally { this.polling = false; }
    };
    void tick(); this.timer = setInterval(() => { void tick(); }, 30_000); this.timer.unref();
  }
  shutdown() { this.stopped = true; this.generation++; if (this.timer) clearInterval(this.timer); this.timer = null; }
}
export const resourceFabric = new ResourceFabric();
