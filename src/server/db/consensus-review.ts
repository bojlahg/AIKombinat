import type Database from 'better-sqlite3';

export function migrateConsensusReview(db: Database.Database): void {
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_policies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          strategy TEXT NOT NULL CHECK(strategy IN ('majority','unanimous','weighted','judge','judge_on_disagreement')),
          failure_policy TEXT NOT NULL CHECK(failure_policy IN ('require_all','quorum')),
          min_successful_reviewers INTEGER NOT NULL CHECK(min_successful_reviewers BETWEEN 2 AND 7),
          judge_execution_profile_id TEXT REFERENCES execution_profiles(id),
          diversity_policy TEXT NOT NULL CHECK(diversity_policy IN ('none','prefer_provider','prefer_provider_and_account')),
          max_parallel_reviewers INTEGER NOT NULL CHECK(max_parallel_reviewers BETWEEN 1 AND 7),
          is_enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_policy_members (
          id TEXT PRIMARY KEY,
          review_policy_id TEXT NOT NULL REFERENCES review_policies(id),
          execution_profile_id TEXT NOT NULL REFERENCES execution_profiles(id),
          label TEXT NOT NULL CHECK(length(label) <= 128),
          weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 10),
          priority INTEGER NOT NULL DEFAULT 0,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          retired INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consensus_review_batches (
          id TEXT PRIMARY KEY,
          todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
          review_round_id TEXT NOT NULL UNIQUE REFERENCES todo_execution_rounds(id) ON DELETE CASCADE,
          review_policy_id TEXT NOT NULL REFERENCES review_policies(id),
          strategy TEXT NOT NULL,
          failure_policy TEXT NOT NULL,
          min_successful_reviewers INTEGER NOT NULL,
          diversity_policy TEXT NOT NULL,
          max_parallel_reviewers INTEGER NOT NULL,
          judge_execution_profile_id TEXT REFERENCES execution_profiles(id),
          status TEXT NOT NULL,
          stop_requested INTEGER NOT NULL DEFAULT 0,
          artifact_identity_json TEXT NOT NULL,
          evidence_hash TEXT NOT NULL,
          aggregate_result_json TEXT,
          failure_reason TEXT,
          judge_job_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consensus_review_jobs (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL REFERENCES consensus_review_batches(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('reviewer','judge')),
          policy_member_id TEXT REFERENCES review_policy_members(id),
          execution_profile_id TEXT NOT NULL REFERENCES execution_profiles(id),
          label TEXT NOT NULL,
          weight INTEGER NOT NULL,
          priority INTEGER NOT NULL,
          status TEXT NOT NULL,
          final_result_payload TEXT,
          final_error_message TEXT,
          quota_chain_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_consensus_judge ON consensus_review_jobs(batch_id) WHERE role = 'judge';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_consensus_member ON consensus_review_jobs(batch_id,policy_member_id) WHERE role = 'reviewer';
        CREATE TABLE IF NOT EXISTS consensus_review_attempts (
          id TEXT PRIMARY KEY,
          review_job_id TEXT NOT NULL REFERENCES consensus_review_jobs(id) ON DELETE CASCADE,
          attempt_index INTEGER NOT NULL,
          status TEXT NOT NULL,
          run_token TEXT NOT NULL UNIQUE,
          execution_snapshot TEXT,
          input_payload TEXT,
          result_payload TEXT,
          error_message TEXT,
          process_pid INTEGER NOT NULL DEFAULT 0,
          process_identity TEXT,
          quota_chain_id TEXT,
          retry_of_attempt_id TEXT REFERENCES consensus_review_attempts(id),
          diversity_diagnostics_json TEXT,
          duration_ms INTEGER,
          attempt_wall_duration_ms INTEGER,
          provider_duration_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL,
          cache_read_input_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          started_at TEXT,
          finished_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(review_job_id,attempt_index)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_consensus_active_attempt ON consensus_review_attempts(review_job_id)
          WHERE process_pid > 0 OR status IN ('pending','waiting_executor','waiting_quota','waiting_resource','starting','running','recovery_required');
        CREATE INDEX IF NOT EXISTS idx_consensus_todo ON consensus_review_batches(todo_id);
      `);
      const attemptColumns = db.prepare('PRAGMA table_info(consensus_review_attempts)').all() as { name: string }[];
      for (const column of ['cache_read_input_tokens', 'cache_creation_input_tokens', 'attempt_wall_duration_ms', 'provider_duration_ms']) {
        if (!attemptColumns.some(c => c.name === column)) db.exec(`ALTER TABLE consensus_review_attempts ADD COLUMN ${column} INTEGER`);
      }
      if (!attemptColumns.some(c => c.name === 'attempt_wall_duration_ms')) {
        db.exec(`UPDATE consensus_review_attempts SET attempt_wall_duration_ms = duration_ms
          WHERE attempt_wall_duration_ms IS NULL AND typeof(duration_ms) IN ('integer','real') AND duration_ms >= 0 AND duration_ms < 1e999`);
      }
      for (const name of ['resource_requests', 'resource_leases']) {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string };
        if (row.sql.includes("'reviewer'")) continue;
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name) as { sql: string }[];
        db.exec(row.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?\w+["`]?/i, `CREATE TABLE ${name}_consensus_migration`)
          .replace("'todo', 'session', 'orchestrator'", "'todo', 'session', 'orchestrator', 'reviewer'"));
        db.exec(`INSERT INTO ${name}_consensus_migration SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_consensus_migration RENAME TO ${name}`);
        for (const index of indexes) db.exec(index.sql);
      }
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Consensus migration foreign key integrity failure');
    }).immediate();
  } finally { db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`); }
}
