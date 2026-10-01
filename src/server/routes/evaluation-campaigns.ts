import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { EvaluationCampaignError, listEvaluationCampaigns, getEvaluationCampaign, saveEvaluationCampaign, transitionEvaluationCampaign, deleteEvaluationCampaign, cloneEvaluationCampaign, evaluationAssignmentDetail, withdrawEvaluationAssignment, putCampaignFeedback } from '../services/evaluation-campaign-service.js';
import { getEvaluationCampaignAnalytics, listCampaignAssignments, campaignCsv } from '../services/evaluation-campaign-analytics.js';

const router=Router();
function projectId(req: Request): string {
  const value=req.params.projectId ?? req.query.projectId ?? req.body?.projectId;
  if (typeof value!=='string' || !value) throw new EvaluationCampaignError('Project required');
  return value;
}
function handle(fn: (req: Request,res: Response)=>void) {
  return (req: Request,res: Response)=>{
    try { fn(req,res); }
    catch (error) { res.status(error instanceof EvaluationCampaignError ? error.status : error instanceof ZodError ? 400 : 500).json({ error: error instanceof EvaluationCampaignError ? error.message : error instanceof ZodError ? 'Invalid campaign input' : 'Campaign request failed' }); }
  };
}
function pageNumber(input: unknown,defaultValue: number,max: number) {
  if (input===undefined) return defaultValue;
  if (typeof input!=='string' || !/^\d+$/.test(input)) throw new EvaluationCampaignError('Invalid pagination');
  const value=Number(input);
  if (!Number.isSafeInteger(value) || value>max) throw new EvaluationCampaignError('Invalid pagination');
  return value;
}
router.get('/projects/:projectId/evaluation-campaigns',handle((req,res)=>res.json(listEvaluationCampaigns(projectId(req),req.query.includeArchived==='true'))));
router.post('/projects/:projectId/evaluation-campaigns',handle((req,res)=>res.status(201).json(saveEvaluationCampaign(projectId(req),req.body))));
router.get('/evaluation-campaigns/:id',handle((req,res)=>res.json(getEvaluationCampaign(String(req.params.id),projectId(req)))));
router.patch('/evaluation-campaigns/:id',handle((req,res)=>{
  const { projectId: _projectId,...input }=req.body;res.json(saveEvaluationCampaign(projectId(req),input,String(req.params.id)));
}));
router.delete('/evaluation-campaigns/:id',handle((req,res)=>{ deleteEvaluationCampaign(String(req.params.id),projectId(req));res.status(204).end(); }));
for (const action of ['start','pause','resume','complete','archive'] as const) router.post(`/evaluation-campaigns/:id/${action}`,handle((req,res)=>res.json(transitionEvaluationCampaign(String(req.params.id),projectId(req),action))));
router.post('/evaluation-campaigns/:id/clone',handle((req,res)=>res.status(201).json(cloneEvaluationCampaign(String(req.params.id),projectId(req)))));
router.get('/todos/:id/evaluation-assignment',handle((req,res)=>res.json(evaluationAssignmentDetail(String(req.params.id),projectId(req)))));
router.post('/todos/:id/evaluation-assignment/withdraw',handle((req,res)=>res.json(withdrawEvaluationAssignment(String(req.params.id),projectId(req)))));
router.put('/todos/:id/evaluation-assignment/feedback',handle((req,res)=>{
  const { projectId: _projectId,...input }=req.body;res.json(putCampaignFeedback(String(req.params.id),projectId(req),input));
}));
router.get('/evaluation-campaigns/:id/analytics',handle((req,res)=>res.json(getEvaluationCampaignAnalytics(String(req.params.id),projectId(req)))));
for (const section of ['assignments','export.csv']) router.get(`/evaluation-campaigns/:id/${section}`,handle((req,res)=>{
  const limit=pageNumber(req.query.limit,100,200),offset=pageNumber(req.query.offset,0,1000000);
  if (limit<1) throw new EvaluationCampaignError('Invalid pagination');
  const page=listCampaignAssignments(String(req.params.id),projectId(req),limit,offset);
  if (section==='export.csv') {
    res.setHeader('X-Total-Count',page.total);res.setHeader('X-Has-More',String(page.hasMore));res.setHeader('X-Next-Offset',offset+page.assignments.length);
    res.type('text/csv').attachment('evaluation-campaign.csv').send(campaignCsv(page));
  } else res.json(page);
}));
export default router;
