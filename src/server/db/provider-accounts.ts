import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export function migrateProviderAccounts(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS provider_accounts (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('claude','codex','antigravity')),
      slug TEXT NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      auth_strategy TEXT NOT NULL, auth_config_json TEXT NOT NULL DEFAULT '{}',
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN (0,1)),
      health_state TEXT NOT NULL DEFAULT 'unknown' CHECK(health_state IN ('unknown','available','auth_error','unavailable')),
      health_reason TEXT, last_health_at TEXT, max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(max_concurrency BETWEEN 1 AND 32),
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(provider, slug));
      CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_inherited ON provider_accounts(provider) WHERE auth_strategy='inherited';`);
    for (const table of ['todos', 'sessions', 'schedules', 'discussion_agents', 'execution_profile_executors']) {
      const columns = db.pragma(`table_info(${table})`) as { name: string }[];
      if (!columns.some(column => column.name === 'provider_account_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN provider_account_id TEXT REFERENCES provider_accounts(id)`);
      if (!columns.some(column => column.name === 'account_policy')) db.exec(`ALTER TABLE ${table} ADD COLUMN account_policy TEXT NOT NULL DEFAULT 'inherited_default' CHECK(account_policy IN ('inherited_default','fixed','automatic'))`);
    }
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='execution_profile_executors'").get() as { sql: string };
    if (/UNIQUE\s*\(profile_id, cli_model_id, effort_value\)/.test(row.sql)) {
      const sql = row.sql.replace('execution_profile_executors', 'execution_profile_executors_accounts')
        .replace(/,\s*UNIQUE\s*\(profile_id, cli_model_id, effort_value\)/, '');
      db.exec(sql);
      db.exec(`INSERT INTO execution_profile_executors_accounts SELECT * FROM execution_profile_executors;
        DROP TABLE execution_profile_executors; ALTER TABLE execution_profile_executors_accounts RENAME TO execution_profile_executors;
        CREATE INDEX idx_execution_profile_executors_profile ON execution_profile_executors(profile_id, priority);`);
    }
    db.exec(`DROP INDEX IF EXISTS idx_execution_profile_executor_unique;
      CREATE UNIQUE INDEX idx_execution_profile_executor_unique ON execution_profile_executors
      (profile_id, cli_model_id, COALESCE(effort_value,''), account_policy, COALESCE(provider_account_id,''));`);
    const insert = db.prepare(`INSERT OR IGNORE INTO provider_accounts(id, provider, slug, label, auth_strategy, max_concurrency, created_at, updated_at)
      VALUES (?, ?, 'existing-login', 'Existing CLI Login', 'inherited', 32, ?, ?)`);
    const now = new Date().toISOString();
    for (const provider of ['claude', 'codex', 'antigravity']) insert.run(randomUUID(), provider, now, now);
  })();
}
