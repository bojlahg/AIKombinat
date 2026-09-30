import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import * as queries from '../db/queries.js';
import { resourceManager } from '../services/resource-manager.js';
import type { FabricRequirements } from '../services/resource-requirements.js';
import { canonicalJson } from '../services/resource-requirements.js';
import { addEvent, getHold, getOrchestration, holds, listOrchestrations, now, publish, type Hold } from './store.js';
import { logger } from '../logging/logger.js';

export const CLAIM_WINDOW_MS = 300_000;
export function reserve(hold: Hold): void {
  if (hold.status !== 'waiting') return;
  const parent = getOrchestration(hold.orchestrator_id);
  if (['paused', 'cancelling', 'cancelled', 'completed', 'failed'].includes(parent.status)) return;
  getDatabase().transaction(() => {
    const result = resourceManager.acquireAtomic({ ownerType: 'orchestrator', ownerId: parent.id, requestId: hold.id, runToken: hold.run_token,
      resources: JSON.parse(hold.requirements_json), workspacePath: queries.getProjectById(parent.project_id)!.path });
    if (result.status !== 'acquired' || !result.binding) return;
    const expiry = new Date(Date.now() + CLAIM_WINDOW_MS).toISOString();
    getDatabase().prepare('UPDATE orchestrator_resource_requests SET claim_expires_at = ? WHERE id = ?').run(expiry, hold.id);
    getDatabase().prepare('UPDATE resource_leases SET expires_at = ? WHERE run_token = ?').run(expiry, hold.run_token);
    addEvent(parent.id, 'resource.fulfilled', 'resource', hold.id, `resource:${hold.id}:fulfilled`, {
      request_id: hold.id, binding_id: result.binding.id, capacity: result.binding.capacity, platform: result.binding.platform, claim_expires_at: expiry,
    });
    logger.info('orchestrator.resource.fulfilled', { orchestratorId: parent.id, requestId: hold.id, bindingId: result.binding.id });
  }).immediate();
  publish('resource-updated', parent.id);
}
export function requestResource(id: string, turnId: string, purpose: string, requirements: FabricRequirements): Hold {
  const parent = getOrchestration(id);
  if (holds(id).filter(row => ['waiting', 'bound'].includes(row.status)).length >= parent.max_active_resource_requests) throw new Error('resource_request_budget_exhausted');
  const requestId = randomUUID(), token = randomUUID();
  getDatabase().prepare(`INSERT INTO resource_requests (id, owner_type, owner_id, run_token, requirements_json, status, created_at) VALUES (?,'orchestrator',?,?,?,'waiting',?)`).run(requestId, id, token, canonicalJson(requirements), now());
  getDatabase().prepare('INSERT INTO orchestrator_resource_requests (id, orchestrator_id, created_by_turn_id, purpose, created_at) VALUES (?,?,?,?,?)').run(requestId, id, turnId, purpose, now());
  logger.info('orchestrator.resource.requested', { orchestratorId: id, requestId });
  reserve(getHold(id, requestId));
  return getHold(id, requestId);
}
export function releaseResource(id: string, requestId: string, expired = false): void {
  const hold = getHold(id, requestId);
  if (hold.claimed_todo_id || hold.status === 'claimed') throw new Error('resource_owned_by_child');
  if (!['waiting', 'bound'].includes(hold.status)) return;
  getDatabase().transaction(() => {
    resourceManager.releaseRun(hold.run_token);
    const status = expired ? 'expired' : hold.status === 'waiting' ? 'cancelled' : 'released';
    getDatabase().prepare('UPDATE resource_requests SET status = ? WHERE id = ?').run(status, requestId);
    addEvent(id, expired ? 'resource.expired' : 'resource.released', 'resource', requestId, `resource:${requestId}:${status}`, { request_id: requestId, status });
    logger.info(`orchestrator.resource.${expired ? 'expired' : 'released'}`, { orchestratorId: id, requestId });
  }).immediate();
  publish('resource-updated', id);
}
export function resourceSnapshot(hold: Hold) {
  const binding = hold.binding_json ? JSON.parse(hold.binding_json) : null;
  return { request_id: hold.id, purpose: hold.purpose, status: hold.status, requirements: JSON.parse(hold.requirements_json),
    reasons: JSON.parse(hold.reasons_json), claim_expires_at: hold.claim_expires_at, claimed_todo_id: hold.claimed_todo_id,
    binding: binding ? { id: binding.id, platform: binding.platform, capacity: binding.capacity, transport: binding.transport } : null };
}
export function reconcileResources(): void {
  const pending: Hold[] = [];
  for (const parent of listOrchestrations()) {
    for (const hold of holds(parent.id)) {
      if (hold.status === 'bound' && (!hold.claim_expires_at || hold.claim_expires_at <= now() || ['paused','cancelling','cancelled','completed','failed'].includes(parent.status) || !getDatabase().prepare('SELECT id FROM resource_leases WHERE run_token = ?').get(hold.run_token))) releaseResource(parent.id, hold.id, true);
      if (hold.status === 'waiting') pending.push(hold);
      if (hold.status === 'claimed' && !getDatabase().prepare('SELECT id FROM resource_leases WHERE run_token = ?').get(hold.run_token)) {
        getDatabase().prepare("UPDATE resource_requests SET status = 'released' WHERE id = ?").run(hold.id);
        addEvent(parent.id, 'resource.released', 'resource', hold.id, `resource:${hold.id}:released`, { request_id: hold.id });
      }
    }
  }
  for (const hold of pending.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    try { reserve(hold); } catch (error) {
      getDatabase().prepare("UPDATE resource_requests SET status = 'failed' WHERE id = ?").run(hold.id);
      addEvent(hold.orchestrator_id, 'resource.failed', 'resource', hold.id, `resource:${hold.id}:failed`, { request_id: hold.id, error: error instanceof Error ? error.message.slice(0, 512) : 'resource_error' });
    }
  }
}
