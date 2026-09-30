import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import { reviewIssueFingerprint } from './review-issue-identity.js';
import { evaluationResult } from './review-evaluation-normalize.js';
import { redactString } from '../logging/redact.js';

export type HumanAction = 'manual_approve' | 'manual_rework' | 'retry_reviewer' | 'retry_judge' | 'retry_review_phase';
export function recordReviewHumanAction(todoId: string, roundId: string, action: HumanAction): void {
  const db = getDatabase();
  const round = db.prepare('SELECT result_payload FROM todo_execution_rounds WHERE id=? AND todo_id=?').get(roundId,todoId) as { result_payload: string | null } | undefined;
  if (!round) throw new Error('Review round not found');
  const batch = db.prepare('SELECT id FROM consensus_review_batches WHERE review_round_id=?').get(roundId) as { id: string } | undefined;
  db.prepare('INSERT INTO review_human_actions (id,todo_id,review_round_id,batch_id,action,previous_verdict,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(),todoId,roundId,batch?.id ?? null,action,evaluationResult(round.result_payload)?.verdict ?? null,new Date().toISOString());
}
export function listEvaluationFeedback(batchId: string, projectId: string) {
  const db = getDatabase();
  if (!db.prepare('SELECT b.id FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id WHERE b.id=? AND t.project_id=?').get(batchId,projectId)) throw new Error('Feedback target not found');
  return db.prepare('SELECT * FROM review_evaluation_feedback WHERE batch_id=? ORDER BY created_at,id').all(batchId);
}
export function putEvaluationFeedback(input: { projectId: string; batchId?: string; jobId?: string; fingerprint?: string; label: string; note?: string; scope: string }) {
  const db = getDatabase();
  const labels: Record<string,string[]> = { batch: ['correct','incorrect','mixed','unknown'],reviewer_job: ['useful','not_useful','mixed','unknown'],issue: ['confirmed','rejected','uncertain'] };
  if (!labels[input.scope]?.includes(input.label)) throw new Error('Invalid feedback scope or label');
  if (typeof input.projectId !== 'string' || typeof input.note !== 'undefined' && typeof input.note !== 'string') throw new Error('Invalid feedback input');
  const note = input.note ?? '';
  if (Buffer.byteLength(note,'utf8') > 4096 || /<[^>]*>/.test(note) || redactString(note) !== note) throw new Error('Feedback note must be plain text, at most 4 KiB, without credentials');
  return db.transaction(() => {
    const target = input.scope === 'batch'
      ? db.prepare('SELECT b.id batch_id,b.todo_id,t.project_id FROM consensus_review_batches b JOIN todos t ON t.id=b.todo_id WHERE b.id=? AND t.project_id=?').get(input.batchId,input.projectId)
      : db.prepare("SELECT b.id batch_id,b.todo_id,t.project_id,j.final_result_payload FROM consensus_review_jobs j JOIN consensus_review_batches b ON b.id=j.batch_id JOIN todos t ON t.id=b.todo_id WHERE j.id=? AND j.role='reviewer' AND t.project_id=?").get(input.jobId,input.projectId);
    if (!target) throw new Error('Feedback target not found');
    const row = target as { batch_id: string; todo_id: string; project_id: string; final_result_payload?: string };
    if (input.batchId && input.batchId !== row.batch_id) throw new Error('Feedback batch mismatch');
    const issue = input.scope === 'issue' ? evaluationResult(row.final_result_payload)?.issues.find(i => reviewIssueFingerprint(i) === input.fingerprint) : null;
    if (input.scope === 'issue' && !issue) throw new Error('Issue does not exist in reviewer result');
    const jobId = input.scope === 'batch' ? null : input.jobId ?? null;
    const fingerprint = input.scope === 'issue' ? input.fingerprint ?? null : null;
    const previous = db.prepare('SELECT id FROM review_evaluation_feedback WHERE batch_id=? AND scope=? AND review_job_id IS ? AND issue_fingerprint IS ?')
      .get(row.batch_id,input.scope,jobId,fingerprint) as { id: string } | undefined;
    const id = previous?.id ?? randomUUID(), now = new Date().toISOString();
    db.prepare(`INSERT INTO review_evaluation_feedback (id,project_id,todo_id,batch_id,review_job_id,scope,issue_fingerprint,issue_snapshot_json,label,note,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'human',?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,note=excluded.note,updated_at=excluded.updated_at`)
      .run(id,row.project_id,row.todo_id,row.batch_id,jobId,input.scope,fingerprint,issue ? JSON.stringify(issue) : null,input.label,note,now,now);
    return db.prepare('SELECT * FROM review_evaluation_feedback WHERE id=?').get(id);
  }).immediate();
}
