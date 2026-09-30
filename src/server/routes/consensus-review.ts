import { Router } from 'express';
import { listReviewPolicies, getReviewPolicy, saveReviewPolicy, disableReviewPolicy } from '../services/review-policy.js';
import { consensusHistory, getConsensusBatch, consensusJobs, consensusAttempts, consensusReview } from '../services/consensus-review.js';
import { getTodoById } from '../db/queries.js';

const router = Router();
router.get('/review-policies', (_req,res) => res.json(listReviewPolicies()));
router.get('/review-policies/:id', (req,res) => {
  const policy = getReviewPolicy(req.params.id);
  if (!policy) { res.status(404).json({ error: 'Policy not found' }); return; }
  res.json(policy);
});
router.post('/review-policies', (req,res) => {
  try { res.status(201).json(saveReviewPolicy(req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid policy' }); }
});
router.patch('/review-policies/:id', (req,res) => {
  if (!getReviewPolicy(req.params.id)) { res.status(404).json({ error: 'Policy not found' }); return; }
  try { res.json(saveReviewPolicy(req.body,req.params.id)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid policy' }); }
});
router.delete('/review-policies/:id', (req,res) => {
  try { disableReviewPolicy(req.params.id); res.status(204).end(); }
  catch { res.status(404).json({ error: 'Policy not found' }); }
});
router.get('/todos/:todoId/consensus-reviews', (req,res) => {
  if (!getTodoById(req.params.todoId)) { res.status(404).json({ error: 'Todo not found' }); return; }
  res.json(consensusHistory(req.params.todoId));
});
router.get('/consensus-review-batches/:id', (req,res) => {
  const batch = getConsensusBatch(req.params.id);
  if (!batch) { res.status(404).json({ error: 'Batch not found' }); return; }
  res.json({ ...batch,jobs: consensusJobs(batch.id).map(job => ({ ...job,attempts: consensusAttempts(job.id) })) });
});
router.post('/consensus-review-jobs/:id/retry', async (req,res) => {
  try { await consensusReview.retry(req.params.id); res.json({ ok: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Review retry failed' }); }
});
export default router;
