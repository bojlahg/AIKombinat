import { getDatabase } from '../db/connection.js';

export const knownUsage = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export interface AttemptUsage {
  duration_ms?: number | null;
  attempt_wall_duration_ms?: number | null;
  provider_duration_ms?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cost_usd?: number | null;
}

export function persistExecutionRoundUsage(roundId: string, usage: AttemptUsage): void {
  if (usage.duration_ms !== undefined && usage.provider_duration_ms === undefined) usage = { ...usage, provider_duration_ms: usage.duration_ms };
  const fields = Object.entries(usage).filter(([key]) => usageFields.includes(key));
  if (!fields.length) return;
  getDatabase().prepare(`UPDATE todo_execution_rounds SET ${fields.map(([key]) => `${key} = COALESCE(?, ${key})`).join(', ')} WHERE id = ?`)
    .run(...fields.map(([, value]) => knownUsage(value)), roundId);
}

const usageFields = ['duration_ms', 'attempt_wall_duration_ms', 'provider_duration_ms', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cost_usd'];
const phases = ['implementation', 'singleReview', 'rework', 'consensusReviewer', 'judge'] as const;
type Phase = typeof phases[number];
export interface Measure { known: number | null; attemptsKnown: number; attemptsTotal: number; coverage: number | null; }
function measure(): Measure { return { known: null, attemptsKnown: 0, attemptsTotal: 0, coverage: null }; }
function empty() {
  return { processAttempts: { total: 0, ordinary: 0, consensusReviewer: 0, judge: 0 },
    cost: measure(), ioTokens: measure(), cacheReadTokens: measure(), cacheCreationTokens: measure(), attemptWallDuration: measure(), providerDuration: measure() };
}
export type UsageSummary = ReturnType<typeof empty>;
export type TreatmentUsage = UsageSummary & { phases: Record<Phase, UsageSummary> };
export function emptyTreatmentUsage(): TreatmentUsage {
  return { ...empty(), phases: Object.fromEntries(phases.map(phase => [phase, empty()])) as Record<Phase, UsageSummary> };
}

// Aggregate attempts in SQL so a campaign read is bounded by Todos and phases, not output or attempt count.
function readUsage(scope: 'todo' | 'campaign', id: string, page?: { limit: number; offset: number }): Map<string, TreatmentUsage> {
  const selected = scope === 'todo' ? 'SELECT id FROM todos WHERE id=?' : 'SELECT todo_id AS id FROM evaluation_campaign_assignments WHERE campaign_id=?'
    + (page ? ' ORDER BY assigned_at,id LIMIT ? OFFSET ?' : '');
  const rows = getDatabase().prepare(`WITH selected AS (${selected}), attempts AS (
    SELECT r.todo_id, CASE r.phase WHEN 'review' THEN 'singleReview' ELSE r.phase END phase,
      r.cost_usd,r.input_tokens,r.output_tokens,r.cache_read_input_tokens,r.cache_creation_input_tokens,r.provider_duration_ms,r.attempt_wall_duration_ms
    FROM todo_execution_rounds r JOIN selected s ON s.id=r.todo_id
    WHERE r.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM consensus_review_batches b WHERE b.review_round_id=r.id)
    UNION ALL
    SELECT b.todo_id,CASE j.role WHEN 'judge' THEN 'judge' ELSE 'consensusReviewer' END,
      a.cost_usd,a.input_tokens,a.output_tokens,a.cache_read_input_tokens,a.cache_creation_input_tokens,a.provider_duration_ms,a.attempt_wall_duration_ms
    FROM consensus_review_batches b JOIN selected s ON s.id=b.todo_id
    JOIN consensus_review_jobs j ON j.batch_id=b.id JOIN consensus_review_attempts a ON a.review_job_id=j.id
    WHERE a.started_at IS NOT NULL
  ) SELECT todo_id,phase,COUNT(*) total,
    SUM(cost_usd) cost,COUNT(cost_usd) cost_known,
    SUM(input_tokens+output_tokens) tokens,COUNT(input_tokens+output_tokens) tokens_known,
    SUM(cache_read_input_tokens) cache_read,COUNT(cache_read_input_tokens) cache_read_known,
    SUM(cache_creation_input_tokens) cache_creation,COUNT(cache_creation_input_tokens) cache_creation_known,
    SUM(provider_duration_ms) duration,COUNT(provider_duration_ms) duration_known,
    SUM(attempt_wall_duration_ms) wall_duration,COUNT(attempt_wall_duration_ms) wall_duration_known
    FROM attempts GROUP BY todo_id,phase`).all(...(page ? [id, page.limit, page.offset] : [id])) as Array<{
      todo_id: string; phase: Phase; total: number; cost: number | null; cost_known: number;
      tokens: number | null; tokens_known: number; cache_read: number | null; cache_read_known: number;
      cache_creation: number | null; cache_creation_known: number; duration: number | null; duration_known: number;
      wall_duration: number | null; wall_duration_known: number;
    }>;
  const result = new Map<string, TreatmentUsage>();
  for (const row of rows) {
    const usage = result.get(row.todo_id) ?? emptyTreatmentUsage();
    const phase = usage.phases[row.phase];
    for (const summary of [usage, phase]) {
      summary.processAttempts.total += row.total;
      summary.processAttempts[row.phase === 'judge' ? 'judge' : row.phase === 'consensusReviewer' ? 'consensusReviewer' : 'ordinary'] += row.total;
      for (const [key, value, count] of [
        ['cost', row.cost, row.cost_known], ['ioTokens', row.tokens, row.tokens_known],
        ['cacheReadTokens', row.cache_read, row.cache_read_known], ['cacheCreationTokens', row.cache_creation, row.cache_creation_known],
        ['providerDuration', row.duration, row.duration_known],
        ['attemptWallDuration', row.wall_duration, row.wall_duration_known],
      ] as const) {
        const metric = summary[key];
        if (value !== null) metric.known = (metric.known ?? 0) + value;
        metric.attemptsKnown += count; metric.attemptsTotal += row.total;
        metric.coverage = metric.attemptsKnown / metric.attemptsTotal;
      }
    }
    result.set(row.todo_id, usage);
  }
  return result;
}
export function getTodoTreatmentUsage(todoId: string): TreatmentUsage {
  return readUsage('todo', todoId).get(todoId) ?? emptyTreatmentUsage();
}
export function getCampaignTreatmentUsage(campaignId: string, page?: { limit: number; offset: number }): Map<string, TreatmentUsage> {
  return readUsage('campaign', campaignId, page);
}
