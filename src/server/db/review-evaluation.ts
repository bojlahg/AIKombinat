import type Database from 'better-sqlite3';

export function migrateReviewEvaluation(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_evaluation_feedback (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES consensus_review_batches(id) ON DELETE CASCADE,
        review_job_id TEXT REFERENCES consensus_review_jobs(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK(scope IN ('batch','reviewer_job','issue')),
        issue_fingerprint TEXT,
        issue_snapshot_json TEXT,
        label TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '' CHECK(length(CAST(note AS BLOB)) <= 4096),
        source TEXT NOT NULL DEFAULT 'human' CHECK(source='human'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((scope='batch' AND review_job_id IS NULL AND issue_fingerprint IS NULL AND label IN ('correct','incorrect','mixed','unknown'))
          OR (scope='reviewer_job' AND review_job_id IS NOT NULL AND issue_fingerprint IS NULL AND label IN ('useful','not_useful','mixed','unknown'))
          OR (scope='issue' AND review_job_id IS NOT NULL AND issue_fingerprint IS NOT NULL AND label IN ('confirmed','rejected','uncertain')))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_batch ON review_evaluation_feedback(batch_id) WHERE scope='batch';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_job ON review_evaluation_feedback(review_job_id) WHERE scope='reviewer_job';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_issue ON review_evaluation_feedback(review_job_id,issue_fingerprint) WHERE scope='issue';
      CREATE INDEX IF NOT EXISTS idx_evaluation_feedback_batch ON review_evaluation_feedback(batch_id);
      CREATE TABLE IF NOT EXISTS review_human_actions (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        review_round_id TEXT NOT NULL REFERENCES todo_execution_rounds(id) ON DELETE CASCADE,
        batch_id TEXT REFERENCES consensus_review_batches(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('manual_approve','manual_rework','retry_reviewer','retry_judge','retry_review_phase')),
        previous_verdict TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_actions_todo ON review_human_actions(todo_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_consensus_jobs_role_status ON consensus_review_jobs(batch_id,role,status);
    `);
  })();
}
