import { Router } from 'express';
import { getConsensusAnalytics, parseEvaluationFilters, consensusCsv } from '../services/consensus-analytics.js';
import { putEvaluationFeedback, listEvaluationFeedback } from '../services/review-evaluation.js';
import { broadcaster } from '../websocket/broadcaster.js';

const router = Router();
router.get<{ projectId: string; section?: string }>(['/projects/:projectId/analytics/consensus','/projects/:projectId/analytics/consensus/:section'], (req,res) => {
  try {
    const filters=parseEvaluationFilters(req.query),section=req.params.section;
    if (section && !['reviewers','policies','issues','export.csv'].includes(section)) { res.status(404).json({ error: 'Analytics section not found' });return; }
    const data=getConsensusAnalytics(req.params.projectId,filters,undefined,section==='issues' ? filters.offset : 0);
    if (section==='export.csv') { res.setHeader('X-Total-Count',data.pagination.total);res.setHeader('X-Has-More',String(data.pagination.hasMore));res.type('text/csv').attachment('consensus-evaluation.csv').send(consensusCsv(data));return; }
    res.json(section ? { period: data.period,coverage: data.coverage,bounds: data.bounds,[section]: data[section as 'reviewers' | 'policies' | 'issues'],...(section==='reviewers' ? { executionIdentities: data.executionIdentities } : {}),...(section==='issues' ? { pagination: data.issuePagination } : {}) } : data);
  } catch { res.status(400).json({ error: 'Invalid consensus analytics request' }); }
});
router.get('/projects/:projectId/analytics/consensus/batches/:batchId', (req,res) => {
  try {
    const data=getConsensusAnalytics(req.params.projectId,parseEvaluationFilters(req.query),req.params.batchId);
    if (!data.batches.length) { res.status(404).json({ error: 'Batch not found in selected project or period' });return; }
    res.json({ period: data.period,coverage: data.coverage,batch: data.batches[0] });
  } catch { res.status(400).json({ error: 'Invalid consensus analytics request' }); }
});
router.get('/consensus-review-batches/:id/feedback', (req,res) => {
  try {
    if (typeof req.query.projectId!=='string') throw new Error('Project required');
    res.json(listEvaluationFeedback(req.params.id,req.query.projectId));
  } catch { res.status(404).json({ error: 'Feedback target not found' }); }
});
for (const [path,scope] of [['/consensus-review-batches/:id/feedback','batch'],['/consensus-review-jobs/:id/feedback','reviewer_job'],['/consensus-review-jobs/:id/issues/:fingerprint/feedback','issue']] as const) {
  router.put(path,(req,res) => {
    try {
      if (!req.body || req.body.scope && req.body.scope!==scope) throw new Error('Invalid scope');
      const feedback=putEvaluationFeedback({ projectId: req.body.projectId,scope,label: req.body.label,note: req.body.note,
        ...(scope==='batch' ? { batchId: req.params.id } : { jobId: req.params.id,batchId: req.body.batchId }),fingerprint: 'fingerprint' in req.params ? req.params.fingerprint : undefined }) as { batch_id: string };
      broadcaster.broadcast({ type: 'review-evaluation:feedback-updated',projectId: req.body.projectId,batchId: feedback.batch_id });
      res.json(feedback);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid feedback' }); }
  });
}
router.delete('/consensus-review-batches/:id/feedback/:feedbackId', (req,res) => {
  try {
    const projectId=req.query.projectId;
    if (typeof projectId!=='string') throw new Error('Project required');
    listEvaluationFeedback(req.params.id,projectId);
    const db=getDatabase();
    const result=db.prepare('DELETE FROM review_evaluation_feedback WHERE id=? AND batch_id=? AND project_id=?').run(req.params.feedbackId,req.params.id,projectId);
    if (result.changes) broadcaster.broadcast({ type: 'review-evaluation:feedback-updated',projectId,batchId: req.params.id });
    res.status(result.changes ? 204 : 404).end();
  } catch { res.status(404).json({ error: 'Feedback target not found' }); }
});
import { getDatabase } from '../db/connection.js';
export default router;
