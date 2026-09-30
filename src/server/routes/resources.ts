import { Router } from 'express';
import { resourceManager } from '../services/resource-manager.js';
import { z } from 'zod';
import { getDatabase } from '../db/connection.js';
import { getComputeNode, getComputeNodes, getResourceInstances, resourceFabric, resourceLeaseTotals } from '../services/resource-fabric.js';
import { discoverSshHosts, boundedDiagnostic } from '../services/resource-probes.js';
import { externallyBusy, matchResources } from '../services/resource-matcher.js';
import { normalizeResourceRequirements } from '../services/resource-catalog.js';
import { toFabricRequirements } from '../services/resource-requirements.js';
import { claudeManager } from '../services/claude-manager.js';
import { parseProcessIdentity } from '../utils/process-tree.js';
import { orchestrator } from '../services/orchestrator.js';

const router = Router();

router.get('/resources', (_req, res) => {
  try {
    res.json({ resources: resourceManager.getStatus(), nodes: getComputeNodes().map(node => ({ id: node.id, name: node.name })) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

const action = (handler: (req: import('express').Request) => unknown | Promise<unknown>) => async (req: import('express').Request, res: import('express').Response) => {
  try { res.json(await handler(req)); } catch (error) { res.status(400).json({ error: boundedDiagnostic(error instanceof Error ? error.message : String(error)) }); }
};
const id = (req: import('express').Request) => z.string().uuid().parse(req.params.id);
router.get('/resources/ssh-hosts', action(async () => ({ hosts: await discoverSshHosts() })));
router.get('/resources/nodes', action(() => {
  const nodes = getComputeNodes(), totals = resourceLeaseTotals();
  const instances = getResourceInstances().map(instance => {
    const node = nodes.find(node => node.id === instance.node_id)!;
    const used = (totals[instance.id] ?? 0) + (instance.legacy_key ? totals[instance.legacy_key] ?? 0 : 0);
    const fresh = !!node.observation && Date.now() - Date.parse(node.observation.timestamp) <= 90_000;
    return { ...instance, used, externally_busy: !used && fresh && externallyBusy(node, instance), runtime_state: used ? 'leased' : !node.enabled || node.identity_changed || node.scheduler_state !== 'online' ? 'offline' : !instance.present ? 'missing' : instance.kind === 'gpu' && !fresh ? 'unknown' : externallyBusy(node, instance) ? 'externally_busy' : instance.policy };
  });
  const capacity = nodes.map(node => ({ node_id: node.id,
    cpu: { total: node.inventory?.cpu.logical_threads ?? 0, reserve: node.policy.cpu_reserve_threads, leased: totals[`node/${node.id}/cpu`] ?? 0, available: Math.max(0, (node.inventory?.cpu.logical_threads ?? 0) - node.policy.cpu_reserve_threads - (totals[`node/${node.id}/cpu`] ?? 0)) },
    memory: { total: node.inventory?.memory.total_bytes ?? 0, reserve: node.policy.memory_reserve_bytes, leased: totals[`node/${node.id}/memory`] ?? 0, available: Math.max(0, (node.inventory?.memory.total_bytes ?? 0) - node.policy.memory_reserve_bytes - (totals[`node/${node.id}/memory`] ?? 0)) },
  }));
  return { nodes, instances, capacity };
}));
router.get('/resources/nodes/:id', action(req => getComputeNode(id(req))));
router.post('/resources/nodes', action(req => { const input = z.object({ name: z.string(), connection: z.unknown(), enabled: z.boolean().optional() }).strict().parse(req.body); const node = resourceFabric.createSshNode(input.name, input.connection as Parameters<typeof resourceFabric.createSshNode>[1]); return input.enabled === false ? resourceFabric.updateNode(node.id, { enabled: false }) : node; }));
router.patch('/resources/nodes/:id', action(req => { const updates = z.object({ name: z.string().optional(), enabled: z.boolean().optional(), scheduler_state: z.enum(['online', 'draining', 'maintenance', 'offline', 'disabled']).optional(), connection: z.unknown().optional() }).strict().parse(req.body); return resourceFabric.updateNode(id(req), updates as Parameters<typeof resourceFabric.updateNode>[1]); }));
router.delete('/resources/nodes/:id', action(req => { resourceFabric.deleteNode(id(req)); return { deleted: true }; }));
router.post('/resources/nodes/:id/scan', action(req => resourceFabric.scan(id(req))));
router.post('/resources/nodes/:id/test', action(req => resourceFabric.testConnection(id(req))));
router.put('/resources/nodes/:id/policy', action(req => resourceFabric.updatePolicy(id(req), req.body)));
router.get('/resources/nodes/:id/history', action(req => ({ snapshots: getDatabase().prepare('SELECT id, diff_json, created_at FROM inventory_snapshots WHERE node_id = ? ORDER BY created_at DESC LIMIT 5').all(id(req)) })));
router.put('/resources/instances/:id/policy', action(req => { const input = z.object({ policy: z.enum(['enabled', 'reserved', 'disabled']), after_current: z.boolean().optional(), reason: z.string().optional() }).strict().parse(req.body); resourceFabric.setInstancePolicy(id(req), input.policy, input.after_current, input.reason); return { updated: true }; }));
router.get('/resources/requests', action(() => ({ requests: getDatabase().prepare(`SELECT r.*, EXISTS(SELECT 1 FROM resource_leases l WHERE l.run_token = r.run_token)
  OR EXISTS(SELECT 1 FROM remote_executions e JOIN resource_bindings b ON b.id = e.binding_id WHERE b.request_id = r.id AND e.status <> 'exited') AS active
  FROM resource_requests r ORDER BY priority DESC, created_at, id LIMIT 200`).all() })));
router.get('/resources/bindings', action(() => ({ bindings: getDatabase().prepare(`SELECT b.*, EXISTS(SELECT 1 FROM resource_leases l WHERE l.binding_id = b.id)
  OR EXISTS(SELECT 1 FROM remote_executions e WHERE e.binding_id = b.id AND e.status <> 'exited') AS active
  FROM resource_bindings b ORDER BY created_at DESC LIMIT 200`).all() })));
router.get('/resources/leases', action(() => ({ leases: getDatabase().prepare(`SELECT l.*, b.node_id, b.binding_json,
  CASE WHEN l.owner_type = 'todo' THEN t.title WHEN l.owner_type = 'reviewer' THEN j.label ELSE s.title END AS owner_title,
  CASE WHEN l.owner_type = 'todo' THEN t.project_id WHEN l.owner_type = 'reviewer' THEN ct.project_id ELSE s.project_id END AS project_id,
  CASE WHEN l.owner_type = 'todo' THEN t.process_pid WHEN l.owner_type = 'reviewer' THEN a.process_pid ELSE s.process_pid END AS process_pid,
  CASE WHEN l.owner_type = 'todo' THEN t.process_identity WHEN l.owner_type = 'reviewer' THEN a.process_identity ELSE s.process_identity END AS process_identity,
  CASE WHEN l.owner_type = 'todo' THEN t.execution_profile_id WHEN l.owner_type = 'reviewer' THEN j.execution_profile_id ELSE s.execution_profile_id END AS execution_profile_id,
  CASE WHEN l.owner_type = 'todo' THEN t.execution_snapshot WHEN l.owner_type = 'reviewer' THEN a.execution_snapshot ELSE s.execution_snapshot END AS execution_snapshot
  FROM resource_leases l LEFT JOIN resource_bindings b ON b.id = l.binding_id
  LEFT JOIN todos t ON l.owner_type = 'todo' AND t.id = l.owner_id
  LEFT JOIN sessions s ON l.owner_type = 'session' AND s.id = l.owner_id
  LEFT JOIN consensus_review_attempts a ON l.owner_type = 'reviewer' AND a.id = l.owner_id
  LEFT JOIN consensus_review_jobs j ON j.id = a.review_job_id
  LEFT JOIN consensus_review_batches cb ON cb.id = j.batch_id
  LEFT JOIN todos ct ON ct.id = cb.todo_id ORDER BY l.acquired_at LIMIT 500`).all() })));
router.post('/resources/match', action(req => {
  const requirements = toFabricRequirements(normalizeResourceRequirements(req.body));
  const nodes = getComputeNodes(), instances = getResourceInstances(), leased = resourceLeaseTotals();
  return matchResources(requirements, nodes.map(node => ({ node, instances: instances.filter(instance => instance.node_id === node.id), leased })));
}));
router.post('/resources/todos/:id/stop', action(async req => {
  const todoId = id(req), input = z.object({ force: z.boolean().default(false) }).strict().parse(req.body);
  const todo = getDatabase().prepare('SELECT process_pid, process_identity FROM todos WHERE id = ?').get(todoId) as { process_pid: number; process_identity: string | null } | undefined;
  if (!todo) throw new Error('Todo not found');
  const identity = parseProcessIdentity(todo.process_identity);
  if (input.force && todo.process_pid > 0) {
    const result = await claudeManager.stopClaude(todo.process_pid, identity, true);
    if (result.status === 'unresolved') return result;
  }
  await orchestrator.stopTodo(todoId); return { status: 'stop_requested' };
}));
export default router;
