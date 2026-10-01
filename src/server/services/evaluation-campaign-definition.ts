import { createHash } from 'node:crypto';
import { getExecutionProfileById, type Todo } from '../db/queries.js';
import { getReviewPolicy } from './review-policy.js';

export interface EvaluationArm {
  id: string; campaign_id: string; name: string; description: string;
  is_control: number; weight: number; sort_order: number; is_enabled: number;
  review_mode: 'single' | 'consensus'; review_profile_id: string | null; review_policy_id: string | null;
  rework_profile_id: string | null; max_review_rounds: number | null;
  definition_hash: string | null; created_at: string; updated_at: string;
}
export interface EvaluationCampaign {
  id: string; project_id: string; name: string; description: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'archived';
  assignment_algorithm: 'sha256_weighted_v1'; assignment_salt: string; campaign_definition_hash: string | null;
  auto_enroll: number; max_assignments: number | null;
  created_at: string; started_at: string | null; paused_at: string | null; completed_at: string | null; updated_at: string;
  arms: EvaluationArm[];
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const definitionHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function canonicalArmDefinition(arm: EvaluationArm) {
  return { id: arm.id, name: arm.name, description: arm.description, is_control: arm.is_control, weight: arm.weight,
    sort_order: arm.sort_order, is_enabled: arm.is_enabled, review_mode: arm.review_mode,
    review_profile_id: arm.review_profile_id, review_policy_id: arm.review_policy_id,
    rework_profile_id: arm.rework_profile_id, max_review_rounds: arm.max_review_rounds };
}
export function orderedArms(arms: EvaluationArm[]): EvaluationArm[] {
  return [...arms].sort((a,b)=>a.sort_order-b.sort_order || (a.id<b.id?-1:a.id>b.id?1:0));
}
export function canonicalCampaignDefinition(campaign: EvaluationCampaign) {
  return { id: campaign.id, project_id: campaign.project_id, assignment_algorithm: campaign.assignment_algorithm,
    assignment_salt: campaign.assignment_salt, auto_enroll: campaign.auto_enroll, max_assignments: campaign.max_assignments,
    arms: orderedArms(campaign.arms).map(canonicalArmDefinition) };
}
export function chooseEvaluationArm(campaign: Pick<EvaluationCampaign,'assignment_salt' | 'assignment_algorithm' | 'arms'>, todoId: string) {
  if (campaign.assignment_algorithm!=='sha256_weighted_v1') throw new Error('Unknown assignment algorithm');
  const arms=orderedArms(campaign.arms).filter(a=>a.is_enabled);
  const totalWeight=arms.reduce((sum,a)=>sum+a.weight,0);
  if (!totalWeight) throw new Error('No enabled arms');
  const hash=createHash('sha256').update(`${campaign.assignment_salt}:${todoId}`).digest('hex');
  const bucket=Number(BigInt(`0x${hash.slice(0,16)}`)%BigInt(totalWeight));
  let start=0;
  for (const arm of arms) {
    const end=start+arm.weight;
    if (bucket<end) return { arm,hash,bucket,totalWeight,rangeStart: start,rangeEnd: end };
    start=end;
  }
  throw new Error('Invalid assignment range');
}
function profileSnapshot(id: string | null) {
  if (!id) return null;
  const profile=getExecutionProfileById(id);
  if (!profile) return { id, missing: true };
  return { id: profile.id, is_enabled: profile.is_enabled, executors: [...profile.executors].sort((a,b)=>a.priority-b.priority || (a.id<b.id?-1:1)).map(e=>({
    id: e.id, cli_model_id: e.cli_model_id, cli_tool: e.cli_tool, model_value: e.model_value, effort_value: e.effort_value,
    account_policy: e.account_policy ?? 'inherited_default', provider_account_id: e.provider_account_id ?? null,
    priority: e.priority, is_enabled: e.is_enabled,
  })) };
}
export type ReviewExperimentConfig = Pick<Todo,'review_enabled' | 'review_mode' | 'review_profile_id' | 'review_policy_id' | 'rework_profile_id' | 'max_review_rounds'>;
export function snapshotReviewExperimentConfig(config: ReviewExperimentConfig) {
  const policy=config.review_mode==='consensus' ? getReviewPolicy(config.review_policy_id ?? '') : null;
  return { ...config, reviewProfile: config.review_mode==='single' ? profileSnapshot(config.review_profile_id) : null,
    reworkProfile: profileSnapshot(config.rework_profile_id),
    policy: config.review_mode!=='consensus' ? null : !policy ? { id: config.review_policy_id, missing: true } : {
      id: policy.id, is_enabled: policy.is_enabled, strategy: policy.strategy, failure_policy: policy.failure_policy,
      min_successful_reviewers: policy.min_successful_reviewers, diversity_policy: policy.diversity_policy,
      max_parallel_reviewers: policy.max_parallel_reviewers, judge: profileSnapshot(policy.judge_execution_profile_id),
      members: [...policy.members].sort((a,b)=>a.priority-b.priority || (a.id<b.id?-1:1)).map(m=>({
        id: m.id, weight: m.weight, priority: m.priority, is_enabled: m.is_enabled, profile: profileSnapshot(m.execution_profile_id),
      })),
    } };
}
export function todoReviewConfig(todo: ReviewExperimentConfig): ReviewExperimentConfig {
  return { review_enabled: todo.review_enabled, review_mode: todo.review_mode, review_profile_id: todo.review_profile_id,
    review_policy_id: todo.review_policy_id, rework_profile_id: todo.rework_profile_id, max_review_rounds: todo.max_review_rounds };
}
export const hashReviewExperimentConfig = (config: ReviewExperimentConfig): string => definitionHash(snapshotReviewExperimentConfig(todoReviewConfig(config)));
