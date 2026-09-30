import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDatabase } from '../db/connection.js';
import { getExecutionProfileById } from '../db/queries.js';
import type { ConsensusStrategy } from './consensus-result.js';

export interface ReviewPolicyMember {
  id: string; review_policy_id: string; execution_profile_id: string; label: string;
  weight: number; priority: number; is_enabled: number; created_at: string; updated_at: string;
}
export interface ReviewPolicy {
  id: string; name: string; description: string; strategy: ConsensusStrategy;
  failure_policy: 'require_all' | 'quorum'; min_successful_reviewers: number;
  judge_execution_profile_id: string | null; diversity_policy: 'none' | 'prefer_provider' | 'prefer_provider_and_account';
  max_parallel_reviewers: number; is_enabled: number; sort_order: number;
  created_at: string; updated_at: string; members: ReviewPolicyMember[];
}
const policyInput = z.object({
  name: z.string().trim().min(1).max(128), description: z.string().max(4096).default(''),
  strategy: z.enum(['majority','unanimous','weighted','judge','judge_on_disagreement']).default('majority'),
  failure_policy: z.enum(['require_all','quorum']).default('require_all'),
  min_successful_reviewers: z.number().int().min(2).max(7).default(2),
  judge_execution_profile_id: z.string().nullable().default(null),
  diversity_policy: z.enum(['none','prefer_provider','prefer_provider_and_account']).default('none'),
  max_parallel_reviewers: z.number().int().min(1).max(7).default(3),
  is_enabled: z.number().int().min(0).max(1).default(1), sort_order: z.number().int().default(0),
  members: z.array(z.object({
    id: z.string().optional(), execution_profile_id: z.string(), label: z.string().trim().max(128),
    weight: z.number().int().min(1).max(10).default(1), priority: z.number().int().default(0),
    is_enabled: z.number().int().min(0).max(1).default(1),
  })).min(2).max(7),
});

export function getReviewPolicy(id: string): ReviewPolicy | undefined {
  const db = getDatabase();
  const policy = db.prepare('SELECT * FROM review_policies WHERE id=?').get(id) as ReviewPolicy | undefined;
  if (policy) policy.members = db.prepare('SELECT * FROM review_policy_members WHERE review_policy_id=? AND retired=0 ORDER BY priority,created_at,id').all(id) as ReviewPolicyMember[];
  return policy;
}
export function listReviewPolicies(): ReviewPolicy[] {
  return (getDatabase().prepare('SELECT id FROM review_policies ORDER BY sort_order,created_at,id').all() as { id: string }[]).map(p => getReviewPolicy(p.id)!);
}
export function saveReviewPolicy(input: unknown, id: string = randomUUID()): ReviewPolicy {
  const existing = getReviewPolicy(id);
  const data = policyInput.parse(existing ? { ...existing, ...(input as object) } : input);
  const count = data.members.filter(m => m.is_enabled).length;
  if (count < 2) throw new Error('At least two enabled reviewers are required');
  if (data.failure_policy === 'require_all') data.min_successful_reviewers = count;
  if (data.min_successful_reviewers > count) throw new Error('Invalid reviewer quorum');
  if (data.strategy.startsWith('judge') && !data.judge_execution_profile_id) throw new Error('Judge profile is required');
  for (const profile of [...data.members.map(m => m.execution_profile_id), ...(data.judge_execution_profile_id ? [data.judge_execution_profile_id] : [])]) {
    if (!getExecutionProfileById(profile)) throw new Error('Unknown execution profile');
  }
  const ids = data.members.flatMap(m => m.id ? [m.id] : []);
  if (new Set(ids).size !== ids.length || ids.some(memberId => !existing?.members.some(m => m.id === memberId))) throw new Error('Invalid policy member identity');
  const db = getDatabase(), now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO review_policies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,strategy=excluded.strategy,
      failure_policy=excluded.failure_policy,min_successful_reviewers=excluded.min_successful_reviewers,
      judge_execution_profile_id=excluded.judge_execution_profile_id,diversity_policy=excluded.diversity_policy,
      max_parallel_reviewers=excluded.max_parallel_reviewers,is_enabled=excluded.is_enabled,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
      .run(id,data.name,data.description,data.strategy,data.failure_policy,data.min_successful_reviewers,data.judge_execution_profile_id,
        data.diversity_policy,data.max_parallel_reviewers,data.is_enabled,data.sort_order,existing?.created_at ?? now,now);
    for (const old of existing?.members ?? []) if (!ids.includes(old.id)) db.prepare('UPDATE review_policy_members SET is_enabled=0,retired=1,updated_at=? WHERE id=?').run(now,old.id);
    for (const member of data.members) db.prepare(`INSERT INTO review_policy_members (id,review_policy_id,execution_profile_id,label,weight,priority,is_enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET execution_profile_id=excluded.execution_profile_id,label=excluded.label,weight=excluded.weight,
      priority=excluded.priority,is_enabled=excluded.is_enabled,retired=0,updated_at=excluded.updated_at`)
      .run(member.id ?? randomUUID(),id,member.execution_profile_id,member.label,member.weight,member.priority,member.is_enabled,
        existing?.members.find(m => m.id === member.id)?.created_at ?? now,now);
  })();
  return getReviewPolicy(id)!;
}
export function disableReviewPolicy(id: string): void {
  if (!getReviewPolicy(id)) throw new Error('Policy not found');
  getDatabase().prepare('UPDATE review_policies SET is_enabled=0,updated_at=? WHERE id=?').run(new Date().toISOString(),id);
}

export function validateReviewConfig(mode: unknown, policyId: unknown): void {
  if (mode !== undefined && mode !== 'single' && mode !== 'consensus') throw new Error('Invalid review mode');
  if (policyId !== undefined && policyId !== null && (typeof policyId !== 'string' || !getReviewPolicy(policyId))) throw new Error('Unknown review policy');
}
