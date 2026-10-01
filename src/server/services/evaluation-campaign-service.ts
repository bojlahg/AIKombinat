import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDatabase } from '../db/connection.js';
import { createTodo, getTodoById, getProjectById, getExecutionProfileById, updateTodo, type Todo } from '../db/queries.js';
import { getReviewPolicy } from './review-policy.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { logger } from '../logging/logger.js';
import { redactString } from '../logging/redact.js';
import { todoLifecycle } from '../utils/todo-lifecycle.js';
import { canonicalArmDefinition, canonicalCampaignDefinition, chooseEvaluationArm, definitionHash, hashReviewExperimentConfig, todoReviewConfig, type EvaluationCampaign, type EvaluationArm } from './evaluation-campaign-definition.js';

export class EvaluationCampaignError extends Error {
  constructor(message: string, public status=400) { super(message); }
}
export interface EvaluationAssignment {
  id: string; campaign_id: string; arm_id: string; todo_id: string;
  assignment_source: 'manual_todo'; assignment_algorithm: 'sha256_weighted_v1'; assignment_hash: string; assignment_bucket: number;
  campaign_definition_hash: string; arm_definition_hash: string; arm_snapshot_json: string; assigned_review_config_hash: string;
  integrity_state: 'clean' | 'contaminated' | 'excluded'; integrity_reason: string | null;
  assigned_at: string; first_execution_at: string | null; review_started_at: string | null; finished_at: string | null;
}
const bit=z.number().int().min(0).max(1);
const armInput=z.object({
  id: z.string().optional(), name: z.string().trim().min(1).max(128), description: z.string().max(4096).default(''),
  is_control: bit.default(0), weight: z.number().int().min(1).max(1000), sort_order: z.number().int().default(0), is_enabled: bit.default(1),
  review_mode: z.enum(['single','consensus']), review_profile_id: z.string().nullable().default(null), review_policy_id: z.string().nullable().default(null),
  rework_profile_id: z.string().nullable().default(null), max_review_rounds: z.number().int().min(1).max(10).nullable().default(null),
}).strict();
const campaignInput=z.object({
  name: z.string().trim().min(1).max(128), description: z.string().max(4096).default(''), auto_enroll: bit.default(0),
  max_assignments: z.number().int().min(2).max(100000).nullable().default(null), arms: z.array(armInput).min(2).max(12),
}).strict();
const timestamp=()=>new Date().toISOString();
type CampaignEvent = 'created' | 'updated' | 'status' | 'assignment' | 'assignment-updated' | 'feedback-updated';
function publish(type: CampaignEvent, campaign: Pick<EvaluationCampaign,'id' | 'project_id' | 'status'>, todoId?: string) {
  broadcaster.broadcast({ type: `evaluation-campaign:${type}`, campaignId: campaign.id, projectId: campaign.project_id, status: campaign.status, todoId });
}
function log(action: string, campaignId: string, todoId?: string) { logger.info(`evaluation-campaign.${action}`,{ campaignId,todoId }); }
export function getEvaluationCampaign(id: string, projectId?: string): EvaluationCampaign {
  const db=getDatabase();
  const campaign=db.prepare('SELECT * FROM evaluation_campaigns WHERE id=?').get(id) as EvaluationCampaign | undefined;
  if (!campaign || projectId!==undefined && campaign.project_id!==projectId || !getProjectById(campaign.project_id)) throw new EvaluationCampaignError('Campaign not found in project',404);
  campaign.arms=db.prepare('SELECT * FROM evaluation_campaign_arms WHERE campaign_id=? ORDER BY sort_order,id').all(id) as EvaluationArm[];
  return campaign;
}
export function listEvaluationCampaigns(projectId: string, includeArchived=false) {
  if (!getProjectById(projectId)) throw new EvaluationCampaignError('Project not found',404);
  const rows=getDatabase().prepare(`SELECT c.id, COUNT(a.id) assigned, SUM(a.integrity_state='clean') clean
    FROM evaluation_campaigns c LEFT JOIN evaluation_campaign_assignments a ON a.campaign_id=c.id
    WHERE c.project_id=? ${includeArchived?'':"AND c.status!='archived'"} GROUP BY c.id ORDER BY c.created_at DESC,c.id`).all(projectId) as { id: string; assigned: number; clean: number | null }[];
  return rows.map(row=>({ ...getEvaluationCampaign(row.id,projectId), assigned: row.assigned, cleanPercentage: row.assigned ? (row.clean ?? 0)/row.assigned : null }));
}
function validateArms(arms: z.infer<typeof armInput>[]) {
  const enabled=arms.filter(a=>a.is_enabled);
  if (enabled.length<2 || enabled.length>6) throw new EvaluationCampaignError('Campaign requires 2–6 enabled arms');
  if (enabled.filter(a=>a.is_control).length!==1 || arms.filter(a=>a.is_control).length!==1) throw new EvaluationCampaignError('Campaign requires exactly one enabled control');
  for (const arm of arms) {
    if (arm.review_mode==='single' ? !arm.review_profile_id || arm.review_policy_id!==null : !arm.review_policy_id || arm.review_profile_id!==null) throw new EvaluationCampaignError('Arm review configuration mismatch');
    for (const id of [arm.review_profile_id,arm.rework_profile_id]) if (id && !getExecutionProfileById(id)?.is_enabled) throw new EvaluationCampaignError('Unknown or disabled execution profile');
    if (arm.review_policy_id) {
      const policy=getReviewPolicy(arm.review_policy_id);
      if (!policy?.is_enabled || policy.members.filter(m=>m.is_enabled).length<2) throw new EvaluationCampaignError('Unknown or disabled review policy');
      for (const id of [...policy.members.filter(m=>m.is_enabled).map(m=>m.execution_profile_id),...(policy.strategy.startsWith('judge') ? [policy.judge_execution_profile_id] : [])]) {
        if (!id || !getExecutionProfileById(id)?.is_enabled) throw new EvaluationCampaignError('Policy profile unavailable');
      }
    }
  }
}
export function saveEvaluationCampaign(projectId: string, input: unknown, id?: string): EvaluationCampaign {
  if (!getProjectById(projectId)) throw new EvaluationCampaignError('Project not found',404);
  const existing=id ? getEvaluationCampaign(id,projectId) : null;
  const patch=z.record(z.string(),z.unknown()).parse(input);
  if (existing?.started_at) {
    if (Object.keys(patch).some(k=>k!=='name' && k!=='description')) throw new EvaluationCampaignError('campaign_definition_locked',409);
    const data=z.object({ name: z.string().trim().min(1).max(128), description: z.string().max(4096) }).parse({ name: existing.name,description: existing.description,...patch });
    getDatabase().prepare('UPDATE evaluation_campaigns SET name=?,description=?,updated_at=? WHERE id=?').run(data.name,data.description,timestamp(),id);
  } else {
    const data=campaignInput.parse(existing ? { name: existing.name,description: existing.description,auto_enroll: existing.auto_enroll,max_assignments: existing.max_assignments,
      arms: existing.arms.map(canonicalArmDefinition),...patch } : patch);
    validateArms(data.arms);
    const ids=data.arms.flatMap(a=>a.id?[a.id]:[]);
    if (new Set(ids).size!==ids.length || ids.some(a=>!existing?.arms.some(old=>old.id===a))) throw new EvaluationCampaignError('Invalid arm identity');
    id ??= randomUUID();
    const campaignId=id,now=timestamp(),db=getDatabase();
    db.transaction(()=>{
      if (existing) db.prepare('UPDATE evaluation_campaigns SET name=?,description=?,auto_enroll=?,max_assignments=?,updated_at=? WHERE id=?').run(data.name,data.description,data.auto_enroll,data.max_assignments,now,campaignId);
      else db.prepare('INSERT INTO evaluation_campaigns (id,project_id,name,description,assignment_salt,auto_enroll,max_assignments,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(campaignId,projectId,data.name,data.description,randomBytes(32).toString('hex'),data.auto_enroll,data.max_assignments,now,now);
      db.prepare('DELETE FROM evaluation_campaign_arms WHERE campaign_id=?').run(campaignId);
      for (const arm of data.arms) db.prepare(`INSERT INTO evaluation_campaign_arms (id,campaign_id,name,description,is_control,weight,sort_order,is_enabled,review_mode,review_profile_id,review_policy_id,rework_profile_id,max_review_rounds,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(arm.id ?? randomUUID(),campaignId,arm.name,arm.description,arm.is_control,arm.weight,arm.sort_order,arm.is_enabled,arm.review_mode,arm.review_profile_id,arm.review_policy_id,arm.rework_profile_id,arm.max_review_rounds,now,now);
    }).immediate();
  }
  const result=getEvaluationCampaign(id!,projectId);
  log(existing?'updated':'created',result.id);publish(existing?'updated':'created',result);
  return result;
}
export function transitionEvaluationCampaign(id: string, projectId: string, action: 'start' | 'pause' | 'resume' | 'complete' | 'archive') {
  const db=getDatabase();
  const result=db.transaction(()=>{
    const campaign=getEvaluationCampaign(id,projectId);
    const allowed={ start: ['draft'],pause: ['running'],resume: ['paused'],complete: ['running','paused'],archive: ['completed'] };
    if (!allowed[action].includes(campaign.status)) throw new EvaluationCampaignError('Invalid campaign transition',409);
    if ((action==='start' || action==='resume') && campaign.auto_enroll && db.prepare("SELECT id FROM evaluation_campaigns WHERE project_id=? AND status='running' AND auto_enroll=1 AND id!=?").get(projectId,id)) throw new EvaluationCampaignError('Project already has a running auto-enroll campaign',409);
    const now=timestamp();
    if (action==='start') {
      validateArms(campaign.arms);
      for (const arm of campaign.arms) db.prepare('UPDATE evaluation_campaign_arms SET definition_hash=? WHERE id=?').run(definitionHash(canonicalArmDefinition(arm)),arm.id);
      db.prepare("UPDATE evaluation_campaigns SET status='running',campaign_definition_hash=?,started_at=?,updated_at=? WHERE id=?").run(definitionHash(canonicalCampaignDefinition(campaign)),now,now,id);
    } else {
      const status={ pause: 'paused',resume: 'running',complete: 'completed',archive: 'archived' }[action];
      db.prepare('UPDATE evaluation_campaigns SET status=?,paused_at=CASE WHEN ?=\'paused\' THEN ? ELSE paused_at END,completed_at=CASE WHEN ?=\'completed\' THEN ? ELSE completed_at END,updated_at=? WHERE id=?').run(status,status,now,status,now,now,id);
    }
    return getEvaluationCampaign(id,projectId);
  }).immediate();
  log({ start: 'started',pause: 'paused',resume: 'resumed',complete: 'completed',archive: 'archived' }[action],id);publish('status',result);
  return result;
}
export function deleteEvaluationCampaign(id: string, projectId: string) {
  const campaign=getEvaluationCampaign(id,projectId);
  if (campaign.status!=='draft' || campaign.started_at || getDatabase().prepare('SELECT id FROM evaluation_campaign_assignments WHERE campaign_id=? LIMIT 1').get(id)) throw new EvaluationCampaignError('Started campaign cannot be deleted; archive instead',409);
  getDatabase().prepare('DELETE FROM evaluation_campaigns WHERE id=?').run(id);publish('updated',campaign);
}
export function cloneEvaluationCampaign(id: string, projectId: string) {
  const original=getEvaluationCampaign(id,projectId);
  return saveEvaluationCampaign(projectId,{ name: `${original.name.slice(0,120)} (copy)`,description: original.description,auto_enroll: 0,max_assignments: original.max_assignments,
    arms: original.arms.map(a=>{ const { id: _id,...definition }=canonicalArmDefinition(a);return definition; }) });
}
export interface EvaluationEnrollment { evaluation_campaign_id?: string; evaluation_campaign_enroll?: boolean; evaluation_arm_id?: never; }
export function getEvaluationAssignment(todoId: string, projectId?: string): EvaluationAssignment | null {
  const todo=getTodoById(todoId);
  if (!todo || projectId!==undefined && todo.project_id!==projectId) throw new EvaluationCampaignError('Todo not found in project',404);
  return getDatabase().prepare('SELECT * FROM evaluation_campaign_assignments WHERE todo_id=?').get(todoId) as EvaluationAssignment ?? null;
}
function assignedCampaign(assignment: EvaluationAssignment) { return getEvaluationCampaign(assignment.campaign_id); }
export function evaluationAssignmentDetail(todoId: string, projectId: string) {
  const assignment=getEvaluationAssignment(todoId,projectId);
  if (!assignment) return null;
  const campaign=assignedCampaign(assignment),choice=chooseEvaluationArm(campaign,todoId);
  const feedback=getDatabase().prepare('SELECT * FROM evaluation_campaign_assignment_feedback WHERE assignment_id=?').get(assignment.id) ?? null;
  return { ...assignment, campaign_name: campaign.name, arm_snapshot: JSON.parse(assignment.arm_snapshot_json), feedback,
    explanation: { algorithm: assignment.assignment_algorithm,bucket: assignment.assignment_bucket,totalWeight: choice.totalWeight,rangeStart: choice.rangeStart,rangeEnd: choice.rangeEnd } };
}
export function createTodoWithEvaluationAssignment(args: Parameters<typeof createTodo>, updates: Parameters<typeof updateTodo>[1], enrollment: EvaluationEnrollment={}) {
  const parsed=z.object({ evaluation_campaign_id: z.string().min(1).optional(),evaluation_campaign_enroll: z.boolean().optional() }).strict().parse(enrollment);
  if (parsed.evaluation_campaign_id && parsed.evaluation_campaign_enroll!==true) throw new EvaluationCampaignError('Explicit enrollment required');
  let assigned: EvaluationAssignment | null=null;
  const todo=getDatabase().transaction(()=>{
    const db=getDatabase(),projectId=args[0];
    let campaign: EvaluationCampaign | null=null;
    if (parsed.evaluation_campaign_enroll!==false) {
      const auto=db.prepare("SELECT id FROM evaluation_campaigns WHERE project_id=? AND status='running' AND auto_enroll=1").get(projectId) as { id: string } | undefined;
      const campaignId=parsed.evaluation_campaign_id ?? auto?.id;
      if (campaignId) campaign=getEvaluationCampaign(campaignId,projectId);
      if (parsed.evaluation_campaign_enroll===true && !campaign) throw new EvaluationCampaignError('Running campaign required');
      if (campaign && campaign.status!=='running') throw new EvaluationCampaignError('Campaign is not running',409);
    }
    const created=createTodo(...args);
    updateTodo(created.id,updates);
    if (campaign) {
      if (created.schedule_id || created.delegated_from) throw new EvaluationCampaignError('Only manual Todos may enroll');
      const count=(db.prepare('SELECT COUNT(*) n FROM evaluation_campaign_assignments WHERE campaign_id=?').get(campaign.id) as { n: number }).n;
      if (campaign.max_assignments!==null && count>=campaign.max_assignments) throw new EvaluationCampaignError('Campaign assignment cap reached',409);
      if (definitionHash(canonicalCampaignDefinition(campaign))!==campaign.campaign_definition_hash) throw new EvaluationCampaignError('Campaign definition mismatch',409);
      const choice=chooseEvaluationArm(campaign,created.id),arm=choice.arm,now=timestamp();
      updateTodo(created.id,{ review_enabled: 1,review_mode: arm.review_mode,review_profile_id: arm.review_profile_id,review_policy_id: arm.review_policy_id,
        ...(arm.rework_profile_id!==null ? { rework_profile_id: arm.rework_profile_id } : {}),...(arm.max_review_rounds!==null ? { max_review_rounds: arm.max_review_rounds } : {}) });
      const final=getTodoById(created.id)!;
      const snapshot={ ...canonicalArmDefinition(arm),review_profile_name: arm.review_profile_id ? getExecutionProfileById(arm.review_profile_id)?.name : null,
        review_policy_name: arm.review_policy_id ? getReviewPolicy(arm.review_policy_id)?.name : null,
        rework_profile_name: final.rework_profile_id ? getExecutionProfileById(final.rework_profile_id)?.name : null,
        applied_review_config: todoReviewConfig(final) };
      db.prepare(`INSERT INTO evaluation_campaign_assignments (id,campaign_id,arm_id,todo_id,assignment_source,assignment_algorithm,assignment_hash,assignment_bucket,campaign_definition_hash,arm_definition_hash,arm_snapshot_json,assigned_review_config_hash,assigned_at)
        VALUES (?,?,?,?,'manual_todo',?,?,?,?,?,?,?,?)`).run(randomUUID(),campaign.id,arm.id,created.id,campaign.assignment_algorithm,choice.hash,choice.bucket,campaign.campaign_definition_hash,arm.definition_hash,JSON.stringify(snapshot),hashReviewExperimentConfig(final),now);
      assigned=getEvaluationAssignment(created.id);
      if (campaign.max_assignments!==null && count+1>=campaign.max_assignments) db.prepare("UPDATE evaluation_campaigns SET status='completed',completed_at=?,updated_at=? WHERE id=?").run(now,now,campaign.id);
    }
    return getTodoById(created.id)!;
  }).immediate();
  const assignment=assigned as EvaluationAssignment | null;
  if (assignment) { const campaign=assignedCampaign(assignment);log('assigned',campaign.id,todo.id);publish('assignment',campaign,todo.id);if (campaign.status==='completed') { log('completed',campaign.id);publish('status',campaign); } }
  return todo;
}
function contaminate(assignment: EvaluationAssignment, reason: string) {
  const result=getDatabase().prepare("UPDATE evaluation_campaign_assignments SET integrity_state='contaminated',integrity_reason=? WHERE id=? AND integrity_state='clean'").run(reason,assignment.id);
  if (result.changes) log('contaminated',assignment.campaign_id,assignment.todo_id);
}
export function updateTodoWithEvaluationGuard(todoId: string, updates: Parameters<typeof updateTodo>[1], override: unknown) {
  const result=getDatabase().transaction(()=>{
    const assignment=getEvaluationAssignment(todoId),todo=getTodoById(todoId)!;
    const changed=Object.keys(todoReviewConfig(todo)).some(k=>updates[k as keyof typeof updates]!==undefined && updates[k as keyof typeof updates]!==todo[k as keyof Todo]);
    if (assignment && assignment.integrity_state!=='excluded' && changed) {
      if (override!==true) throw new EvaluationCampaignError('experiment_assignment_locked',409);
      contaminate(assignment,'todo_review_configuration_overridden');
    }
    return updateTodo(todoId,updates);
  }).immediate();
  const assignment=getEvaluationAssignment(todoId);
  if (assignment) publish('assignment-updated',assignedCampaign(assignment),todoId);
  return result;
}
export function withdrawEvaluationAssignment(todoId: string, projectId: string) {
  getDatabase().transaction(()=>{
    const assignment=getEvaluationAssignment(todoId,projectId);
    if (!assignment) throw new EvaluationCampaignError('Assignment not found',404);
    if (assignment.first_execution_at || assignment.review_started_at || getTodoById(todoId)?.status==='running') throw new EvaluationCampaignError('Cannot withdraw after execution',409);
    if (assignment.integrity_state!=='clean') throw new EvaluationCampaignError('Assignment integrity is immutable',409);
    getDatabase().prepare("UPDATE evaluation_campaign_assignments SET integrity_state='excluded',integrity_reason='withdrawn_before_execution' WHERE id=?").run(assignment.id);
    log('withdrawn',assignment.campaign_id,todoId);
  }).immediate();
  const assignment=getEvaluationAssignment(todoId,projectId)!;publish('assignment-updated',assignedCampaign(assignment),todoId);
  return evaluationAssignmentDetail(todoId,projectId);
}
export function observeImplementationStart(todoId: string) {
  const assignment=getEvaluationAssignment(todoId);
  if (!assignment || assignment.integrity_state==='excluded') return;
  if (getDatabase().prepare('UPDATE evaluation_campaign_assignments SET first_execution_at=? WHERE id=? AND first_execution_at IS NULL').run(timestamp(),assignment.id).changes) publish('assignment-updated',assignedCampaign(assignment),todoId);
}
export function observeReviewStart(todoId: string) {
  const assignment=getEvaluationAssignment(todoId);
  if (!assignment || assignment.integrity_state==='excluded' || assignment.review_started_at) return;
  getDatabase().transaction(()=>{
    const campaign=assignedCampaign(assignment),arm=campaign.arms.find(a=>a.id===assignment.arm_id);
    if (!arm || definitionHash(canonicalCampaignDefinition(campaign))!==assignment.campaign_definition_hash || definitionHash(canonicalArmDefinition(arm))!==assignment.arm_definition_hash) contaminate(assignment,'campaign_definition_mismatch');
    else if (hashReviewExperimentConfig(getTodoById(todoId)!)!==assignment.assigned_review_config_hash) contaminate(assignment,'review_configuration_changed');
    getDatabase().prepare('UPDATE evaluation_campaign_assignments SET review_started_at=? WHERE id=? AND review_started_at IS NULL').run(timestamp(),assignment.id);
  })();
  publish('assignment-updated',assignedCampaign(assignment),todoId);
}
export function observeTerminalState(todoId: string, status: string, at=timestamp()) {
  if (!['completed','failed','stopped','merged'].includes(status)) return;
  const assignment=getDatabase().prepare('SELECT * FROM evaluation_campaign_assignments WHERE todo_id=?').get(todoId) as EvaluationAssignment | undefined;
  if (!assignment) return;
  getDatabase().prepare('UPDATE evaluation_campaign_assignments SET finished_at=? WHERE id=?').run(at,assignment.id);
  publish('assignment-updated',assignedCampaign(assignment),todoId);
}
todoLifecycle.on('transition',observeTerminalState);
export function putCampaignFeedback(todoId: string, projectId: string, input: unknown) {
  const data=z.object({ label: z.enum(['helpful','not_helpful','mixed','unknown']),note: z.string().default('') }).strict().parse(input);
  if (Buffer.byteLength(data.note,'utf8')>4096 || /<[^>]*>/.test(data.note)) throw new EvaluationCampaignError('Feedback note must be plain text, at most 4 KiB');
  const note=redactString(data.note);
  if (Buffer.byteLength(note,'utf8')>4096) throw new EvaluationCampaignError('Redacted note exceeds 4 KiB');
  const feedback=getDatabase().transaction(()=>{
    const assignment=getEvaluationAssignment(todoId,projectId);
    if (!assignment?.review_started_at) throw new EvaluationCampaignError('Feedback requires review start',409);
    const now=timestamp();
    getDatabase().prepare(`INSERT INTO evaluation_campaign_assignment_feedback (id,assignment_id,label,note,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(assignment_id) DO UPDATE SET label=excluded.label,note=excluded.note,updated_at=excluded.updated_at`).run(randomUUID(),assignment.id,data.label,note,now,now);
    return getDatabase().prepare('SELECT * FROM evaluation_campaign_assignment_feedback WHERE assignment_id=?').get(assignment.id);
  }).immediate();
  publish('feedback-updated',getEvaluationCampaign(getEvaluationAssignment(todoId)!.campaign_id,projectId),todoId);
  return feedback;
}
