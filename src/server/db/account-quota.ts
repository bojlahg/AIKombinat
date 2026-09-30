import type Database from 'better-sqlite3';

export function migrateAccountQuota(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS provider_account_quota_state (
      provider_account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('claude','codex','antigravity')),
      state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('available','exhausted','unknown')),
      source TEXT NOT NULL DEFAULT 'migration', reason TEXT, observed_at TEXT NOT NULL, reset_at TEXT,
      window_type TEXT, used_value REAL, remaining_value REAL, unit TEXT, confidence TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_failover_events (
        id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
        chain_id TEXT NOT NULL, round_id TEXT, from_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
        to_account_id TEXT REFERENCES provider_accounts(id), provider TEXT NOT NULL,
        reason TEXT NOT NULL, classification TEXT NOT NULL, reset_at TEXT,
        attempt_index_from INTEGER NOT NULL, attempt_index_to INTEGER, created_at TEXT NOT NULL,
        UNIQUE(owner_type, owner_id, chain_id, attempt_index_from));
      CREATE INDEX IF NOT EXISTS idx_account_failover_owner ON account_failover_events(owner_type, owner_id, chain_id);
      CREATE INDEX IF NOT EXISTS idx_account_failover_round ON account_failover_events(round_id);`);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO provider_account_quota_state
      (provider_account_id, provider, observed_at, created_at, updated_at)
      SELECT id, provider, ?, ?, ? FROM provider_accounts`).run(now, now, now);
    for (const table of ['todos', 'orchestrator_turns']) {
      const columns = db.pragma(`table_info(${table})`) as { name: string }[];
      if (!columns.some(column => column.name === 'quota_chain_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN quota_chain_id TEXT`);
    }
  })();
}
