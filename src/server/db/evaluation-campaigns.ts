import type Database from 'better-sqlite3';

export function migrateEvaluationCampaigns(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_campaigns (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','paused','completed','archived')),
        assignment_algorithm TEXT NOT NULL DEFAULT 'sha256_weighted_v1' CHECK(assignment_algorithm='sha256_weighted_v1'),
        assignment_salt TEXT NOT NULL,
        campaign_definition_hash TEXT,
        auto_enroll INTEGER NOT NULL DEFAULT 0 CHECK(auto_enroll IN (0,1)),
        max_assignments INTEGER CHECK(max_assignments BETWEEN 2 AND 100000),
        created_at TEXT NOT NULL, started_at TEXT, paused_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_project_status ON evaluation_campaigns(project_id,status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_running_auto ON evaluation_campaigns(project_id) WHERE status='running' AND auto_enroll=1;
      CREATE TABLE IF NOT EXISTS evaluation_campaign_arms (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES evaluation_campaigns(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        is_control INTEGER NOT NULL CHECK(is_control IN (0,1)),
        weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 1000),
        sort_order INTEGER NOT NULL, is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN (0,1)),
        review_mode TEXT NOT NULL CHECK(review_mode IN ('single','consensus')),
        review_profile_id TEXT REFERENCES execution_profiles(id),
        review_policy_id TEXT REFERENCES review_policies(id),
        rework_profile_id TEXT REFERENCES execution_profiles(id),
        max_review_rounds INTEGER CHECK(max_review_rounds BETWEEN 1 AND 10),
        definition_hash TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((review_mode='single' AND review_profile_id IS NOT NULL AND review_policy_id IS NULL)
          OR (review_mode='consensus' AND review_policy_id IS NOT NULL AND review_profile_id IS NULL)),
        UNIQUE(campaign_id,id)
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_arm_order ON evaluation_campaign_arms(campaign_id,sort_order);
      CREATE TABLE IF NOT EXISTS evaluation_campaign_assignments (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES evaluation_campaigns(id) ON DELETE CASCADE,
        arm_id TEXT NOT NULL REFERENCES evaluation_campaign_arms(id) ON DELETE CASCADE,
        todo_id TEXT NOT NULL UNIQUE REFERENCES todos(id) ON DELETE CASCADE,
        assignment_source TEXT NOT NULL CHECK(assignment_source='manual_todo'),
        assignment_algorithm TEXT NOT NULL CHECK(assignment_algorithm='sha256_weighted_v1'),
        assignment_hash TEXT NOT NULL, assignment_bucket INTEGER NOT NULL,
        campaign_definition_hash TEXT NOT NULL, arm_definition_hash TEXT NOT NULL,
        arm_snapshot_json TEXT NOT NULL, assigned_review_config_hash TEXT NOT NULL,
        integrity_state TEXT NOT NULL DEFAULT 'clean' CHECK(integrity_state IN ('clean','contaminated','excluded')),
        integrity_reason TEXT,
        assigned_at TEXT NOT NULL, first_execution_at TEXT, review_started_at TEXT, finished_at TEXT,
        FOREIGN KEY(campaign_id,arm_id) REFERENCES evaluation_campaign_arms(campaign_id,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_assignment_arm ON evaluation_campaign_assignments(campaign_id,arm_id);
      CREATE TABLE IF NOT EXISTS evaluation_campaign_assignment_feedback (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL UNIQUE REFERENCES evaluation_campaign_assignments(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK(label IN ('helpful','not_helpful','mixed','unknown')),
        note TEXT NOT NULL DEFAULT '' CHECK(length(CAST(note AS BLOB))<=4096),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS campaign_definition_locked BEFORE UPDATE ON evaluation_campaigns
      WHEN OLD.started_at IS NOT NULL AND (NEW.assignment_salt IS NOT OLD.assignment_salt OR NEW.assignment_algorithm IS NOT OLD.assignment_algorithm
        OR NEW.auto_enroll IS NOT OLD.auto_enroll OR NEW.max_assignments IS NOT OLD.max_assignments OR NEW.campaign_definition_hash IS NOT OLD.campaign_definition_hash)
      BEGIN SELECT RAISE(ABORT,'campaign_definition_locked'); END;
      CREATE TRIGGER IF NOT EXISTS campaign_arm_update_locked BEFORE UPDATE ON evaluation_campaign_arms
      WHEN (SELECT started_at FROM evaluation_campaigns WHERE id=OLD.campaign_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'campaign_definition_locked'); END;
      CREATE TRIGGER IF NOT EXISTS campaign_arm_insert_locked BEFORE INSERT ON evaluation_campaign_arms
      WHEN (SELECT started_at FROM evaluation_campaigns WHERE id=NEW.campaign_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'campaign_definition_locked'); END;
      CREATE TRIGGER IF NOT EXISTS campaign_arm_delete_locked BEFORE DELETE ON evaluation_campaign_arms
      WHEN (SELECT started_at FROM evaluation_campaigns WHERE id=OLD.campaign_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'campaign_definition_locked'); END;
      CREATE TRIGGER IF NOT EXISTS campaign_assignment_monotonic BEFORE UPDATE ON evaluation_campaign_assignments
      WHEN NEW.arm_id IS NOT OLD.arm_id OR NEW.campaign_id IS NOT OLD.campaign_id OR NEW.todo_id IS NOT OLD.todo_id
        OR NEW.assignment_hash IS NOT OLD.assignment_hash OR NEW.assignment_bucket IS NOT OLD.assignment_bucket
        OR NEW.arm_snapshot_json IS NOT OLD.arm_snapshot_json OR NEW.assigned_review_config_hash IS NOT OLD.assigned_review_config_hash
        OR NEW.campaign_definition_hash IS NOT OLD.campaign_definition_hash OR NEW.arm_definition_hash IS NOT OLD.arm_definition_hash
        OR (OLD.integrity_state!='clean' AND NEW.integrity_state!=OLD.integrity_state)
        OR (NEW.integrity_state='excluded' AND NEW.first_execution_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'experiment_assignment_immutable'); END;
    `);
  })();
}
