import { Router } from 'express';
import { getDatabase } from '../db/connection.js';
import * as store from '../orchestration/store.js';
import { orchestratorAgent } from '../orchestration/service.js';
import { resourceSnapshot, releaseResource } from '../orchestration/resources.js';

const router = Router();
router.get('/projects/:projectId/orchestrators', (req, res) => res.json(store.listOrchestrations(req.params.projectId)));
router.post('/projects/:projectId/orchestrators', (req, res) => {
  try { res.status(201).json(store.createOrchestration(req.params.projectId, req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'invalid_orchestrator' }); }
});
router.use('/orchestrators/:id', (req, res, next) => {
  try { store.getOrchestration(req.params.id); next(); }
  catch { res.status(404).json({ error: 'orchestrator_not_found' }); }
});
router.get('/orchestrators/:id', (req, res) => res.json(store.getOrchestration(req.params.id)));
router.patch('/orchestrators/:id', (req, res) => {
  try {
    const parent = store.getOrchestration(req.params.id);
    if (!['pending','paused','failed'].includes(parent.status)) throw new Error('pause_before_editing');
    const updates = store.patchSchema.parse(req.body);
    if (updates.primary_execution_profile_id) store.validateProfile(updates.primary_execution_profile_id, true);
    store.updateOrchestration(parent.id, updates); store.publish('status-changed', parent.id);
    res.json(store.getOrchestration(parent.id));
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'invalid_update' }); }
});
for (const action of ['start','pause','resume','cancel'] as const) {
  router.post(`/orchestrators/:id/${action}`, async (req, res) => {
    try { await orchestratorAgent[action](req.params.id); res.json(store.getOrchestration(req.params.id)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'control_failed' }); }
  });
}
router.get('/orchestrators/:id/messages', (req, res) => res.json(getDatabase().prepare('SELECT * FROM orchestrator_messages WHERE orchestrator_id = ? ORDER BY created_at, rowid').all(req.params.id)));
router.post('/orchestrators/:id/messages', (req, res) => {
  try { const messageId = store.addMessage(req.params.id, req.body.content); res.status(201).json({ id: messageId }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'invalid_message' }); }
});
router.get('/orchestrators/:id/children', (req, res) => res.json(store.children(req.params.id).map(child => store.childStatus(req.params.id, child.id))));
router.get('/orchestrators/:id/resources', (req, res) => res.json(store.holds(req.params.id).map(resourceSnapshot)));
router.post('/orchestrators/:id/resources/:requestId/release', (req, res) => {
  try { releaseResource(req.params.id, req.params.requestId); orchestratorAgent.wake(); res.json({ status: 'released' }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'release_failed' }); }
});
router.get('/orchestrators/:id/events', (req, res) => res.json(store.events(req.params.id)));
router.get('/orchestrators/:id/turns', (req, res) => res.json(store.turns(req.params.id)));
export default router;
