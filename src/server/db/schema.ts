import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export function initDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      default_branch TEXT DEFAULT 'main',
      is_git_repo INTEGER DEFAULT 1,
      max_concurrent INTEGER DEFAULT 3,
      claude_model TEXT,
      claude_options TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      branch_name TEXT,
      worktree_path TEXT,
      process_pid INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      log_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      cron_expression TEXT NOT NULL,
      cli_tool TEXT,
      cli_model TEXT,
      cli_model_id TEXT,
      cli_effort TEXT,
      execution_profile_id TEXT,
      max_turns INTEGER,
      use_worktree INTEGER,
      memory_inject_mode TEXT DEFAULT 'none',
      memory_node_ids TEXT,
      memory_raw_file_paths TEXT,
      is_active INTEGER DEFAULT 1,
      skip_if_running INTEGER DEFAULT 1,
      last_run_at DATETIME,
      next_run_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'triggered',
      skipped_reason TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS cli_models (
      id TEXT PRIMARY KEY,
      cli_tool TEXT NOT NULL CHECK (cli_tool IN ('claude', 'codex', 'antigravity')),
      model_value TEXT NOT NULL,
      model_label TEXT NOT NULL,
      supported_efforts TEXT,
      provider_variants TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'missing')),
      source TEXT NOT NULL DEFAULT 'cli' CHECK (source IN ('cli', 'manual')),
      superseded_by_model_id TEXT REFERENCES cli_models(id),
      last_seen_at DATETIME,
      last_checked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cli_tool, model_value)
    );

    CREATE TABLE IF NOT EXISTS execution_profiles (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS execution_profile_executors (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES execution_profiles(id) ON DELETE CASCADE,
      cli_model_id TEXT NOT NULL REFERENCES cli_models(id),
      effort_value TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(profile_id, cli_model_id, effort_value)
    );

    CREATE TABLE IF NOT EXISTS cli_versions (
      cli_tool TEXT PRIMARY KEY,
      last_version TEXT,
      last_synced_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS plugin_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      config_value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, plugin_id, config_key)
    );

    CREATE TABLE IF NOT EXISTS discussion_agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      cli_tool TEXT,
      cli_model TEXT,
      avatar_color TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS discussions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      current_round INTEGER DEFAULT 0,
      max_rounds INTEGER DEFAULT 3,
      current_agent_id TEXT,
      branch_name TEXT,
      worktree_path TEXT,
      process_pid INTEGER,
      agent_ids TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS discussion_messages (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      turn_order INTEGER NOT NULL,
      role TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'pending',
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS discussion_logs (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      message_id TEXT,
      log_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      cli_tool TEXT,
      cli_model TEXT,
      process_pid INTEGER,
      branch_name TEXT,
      worktree_path TEXT,
      base_commit TEXT,
      token_usage TEXT,
      total_cost_usd REAL,
      total_tokens INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS session_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      log_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS session_raw_chunks (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, seq)
    );
    -- idx_session_raw_chunks_session was redundant (prefix of the PK) and
    -- doubled index-write cost on the PTY streaming insert path.
    DROP INDEX IF EXISTS idx_session_raw_chunks_session;

    CREATE TABLE IF NOT EXISTS resource_leases (
      id TEXT PRIMARY KEY,
      resource_key TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 1,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('todo', 'session')),
      owner_id TEXT NOT NULL,
      run_token TEXT NOT NULL,
      acquired_at DATETIME NOT NULL,
      heartbeat_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_resource_leases_resource ON resource_leases(resource_key, expires_at);
    CREATE INDEX IF NOT EXISTS idx_resource_leases_run ON resource_leases(run_token);
    CREATE INDEX IF NOT EXISTS idx_resource_leases_owner ON resource_leases(owner_type, owner_id);

    CREATE TABLE IF NOT EXISTS planner_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      due_date TEXT,
      end_date TEXT,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      converted_type TEXT,
      converted_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS planner_tags (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'default',
      UNIQUE(project_id, name)
    );

    -- Free-form Notion-style pages (BlockNote document JSON in content).
    -- Separate from planner_items; flat list per project (no nesting).
    CREATE TABLE IF NOT EXISTS planner_pages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Global (project-agnostic) personal organizer items. Pure notes/agenda
    -- with no CLI execution. start_at NULL = undated backlog memo. Memos span a
    -- date range [start_at, end_at] (day granularity, no time). due_at/all_day
    -- are legacy columns kept only for migration.
    CREATE TABLE IF NOT EXISTS personal_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      due_at TEXT,
      start_at TEXT,
      end_at TEXT,
      all_day INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Global key/value app settings (e.g. the agenda's personal Jira connection).
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      tags TEXT,
      position_x REAL,
      position_y REAL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      to_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'related',
      label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_node_id, to_node_id, relation_type)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_nodes_project ON memory_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_project ON memory_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_node_id);

    CREATE TABLE IF NOT EXISTS memory_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      source_type TEXT,
      source_id TEXT,
      source_title TEXT,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memory_logs_project ON memory_logs(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('executable','command','url')),
      target TEXT NOT NULL,
      args TEXT,
      cwd TEXT,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS session_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS session_aliases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      command_template TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS provider_quota_state (
      tool TEXT PRIMARY KEY CHECK (tool IN ('claude', 'codex', 'antigravity')),
      state TEXT NOT NULL CHECK (state IN ('available', 'exhausted', 'unknown')),
      source TEXT NOT NULL,
      reason TEXT,
      observed_at DATETIME NOT NULL,
      reset_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS todo_execution_rounds (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      round_index INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('implementation', 'review', 'rework')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'waiting_executor', 'waiting_quota', 'waiting_resource', 'running', 'completed', 'failed', 'stopped')),
      run_token TEXT NOT NULL,
      execution_snapshot TEXT,
      input_payload TEXT,
      result_payload TEXT,
      error_message TEXT,
      retry_of_round_id TEXT,
      attempt_index INTEGER NOT NULL DEFAULT 1,
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_todo_execution_rounds_todo ON todo_execution_rounds(todo_id, round_index);
    CREATE INDEX IF NOT EXISTS idx_todo_execution_rounds_run_token ON todo_execution_rounds(run_token);

    CREATE TABLE IF NOT EXISTS agent_forums (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      rules TEXT NOT NULL,
      max_reply_length INTEGER NOT NULL DEFAULT 1024,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
      current_cycle INTEGER NOT NULL DEFAULT 0,
      current_member_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_forum_members (
      id TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL REFERENCES agent_forums(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      cli_tool TEXT,
      cli_model TEXT,
      cli_model_id TEXT REFERENCES cli_models(id),
      execution_profile_id TEXT REFERENCES execution_profiles(id),
      cli_effort TEXT,
      avatar_color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_forum_messages (
      id TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL REFERENCES agent_forums(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
      author_id TEXT,
      author_name TEXT NOT NULL,
      author_role TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      parent_message_id TEXT REFERENCES agent_forum_messages(id) ON DELETE SET NULL,
      turn_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_forum_turns (
      id TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL REFERENCES agent_forums(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES agent_forum_members(id) ON DELETE RESTRICT,
      cycle_number INTEGER NOT NULL,
      turn_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'passed', 'skipped', 'stopped')),
      execution_snapshot TEXT,
      process_pid INTEGER,
      process_identity TEXT,
      raw_output TEXT,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_agent_forums_project ON agent_forums(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_forum_members_forum ON agent_forum_members(forum_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_agent_forum_messages_forum ON agent_forum_messages(forum_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_forum_messages_parent ON agent_forum_messages(parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_agent_forum_turns_forum ON agent_forum_turns(forum_id, cycle_number);
  `);

  // Backwards-compatible migration: add new columns to existing DBs
  const migrations = [
    { table: 'projects', column: 'max_concurrent', definition: 'INTEGER DEFAULT 3' },
    { table: 'projects', column: 'claude_model', definition: 'TEXT' },
    { table: 'projects', column: 'claude_options', definition: 'TEXT' },
    { table: 'projects', column: 'is_git_repo', definition: 'INTEGER DEFAULT 1' },
    { table: 'projects', column: 'cli_tool', definition: "TEXT DEFAULT 'claude'" },
    { table: 'projects', column: 'default_max_turns', definition: 'INTEGER' },
    { table: 'todos', column: 'cli_tool', definition: 'TEXT' },
    { table: 'todos', column: 'cli_model', definition: 'TEXT' },
    { table: 'todos', column: 'cli_model_id', definition: 'TEXT REFERENCES cli_models(id)' },
    { table: 'todos', column: 'execution_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'todos', column: 'execution_snapshot', definition: 'TEXT' },
    { table: 'todos', column: 'cli_effort', definition: 'TEXT' },
    { table: 'todos', column: 'schedule_id', definition: 'TEXT' },
    { table: 'todos', column: 'images', definition: 'TEXT' },
    { table: 'todos', column: 'depends_on', definition: 'TEXT' },
    { table: 'todos', column: 'max_turns', definition: 'INTEGER' },
    { table: 'todos', column: 'token_usage', definition: 'TEXT' },
    { table: 'todos', column: 'position_x', definition: 'REAL' },
    { table: 'todos', column: 'position_y', definition: 'REAL' },
    { table: 'todos', column: 'merged_from_branch', definition: 'TEXT' },
    { table: 'projects', column: 'cli_fallback_chain', definition: 'TEXT' },
    { table: 'todos', column: 'context_switch_count', definition: 'INTEGER DEFAULT 0' },
    { table: 'schedules', column: 'schedule_type', definition: "TEXT DEFAULT 'recurring'" },
    { table: 'schedules', column: 'run_at', definition: 'DATETIME' },
    { table: 'schedules', column: 'cli_model_id', definition: 'TEXT REFERENCES cli_models(id)' },
    { table: 'schedules', column: 'execution_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'schedules', column: 'cli_effort', definition: 'TEXT' },
    { table: 'schedules', column: 'max_turns', definition: 'INTEGER' },
    { table: 'schedules', column: 'use_worktree', definition: 'INTEGER' },
    { table: 'schedules', column: 'memory_inject_mode', definition: "TEXT DEFAULT 'none'" },
    { table: 'schedules', column: 'memory_node_ids', definition: 'TEXT' },
    { table: 'schedules', column: 'memory_raw_file_paths', definition: 'TEXT' },
    { table: 'projects', column: 'sandbox_mode', definition: "TEXT DEFAULT 'strict'" },
    { table: 'projects', column: 'debug_logging', definition: 'INTEGER DEFAULT 0' },
    { table: 'discussions', column: 'auto_implement', definition: 'INTEGER DEFAULT 0' },
    { table: 'discussions', column: 'implement_agent_id', definition: 'TEXT' },
    // null = inherit project.use_worktree; 0 = run in project root; 1 = isolated worktree
    { table: 'discussions', column: 'use_worktree', definition: 'INTEGER' },
    { table: 'projects', column: 'use_worktree', definition: 'INTEGER DEFAULT 1' },
    { table: 'todos', column: 'execution_mode', definition: 'TEXT' },
    { table: 'projects', column: 'show_token_usage', definition: 'INTEGER DEFAULT 0' },
    { table: 'todos', column: 'round_count', definition: 'INTEGER DEFAULT 1' },
    { table: 'task_logs', column: 'round_number', definition: 'INTEGER DEFAULT 1' },
    { table: 'todos', column: 'total_cost_usd', definition: 'REAL' },
    { table: 'todos', column: 'total_tokens', definition: 'INTEGER' },
    { table: 'todos', column: 'use_worktree', definition: 'INTEGER' },
    { table: 'sessions', column: 'use_worktree', definition: 'INTEGER DEFAULT 0' },
    // HEAD commit captured when the session first started — Diff view compares
    // the working tree against this to show everything the session changed.
    { table: 'sessions', column: 'base_commit', definition: 'TEXT' },
    { table: 'planner_items', column: 'images', definition: 'TEXT' },
    { table: 'planner_items', column: 'page_id', definition: 'TEXT' },
    { table: 'discussion_agents', column: 'can_implement', definition: 'INTEGER DEFAULT 0' },
    { table: 'discussion_agents', column: 'cli_model_id', definition: 'TEXT REFERENCES cli_models(id)' },
    { table: 'discussion_agents', column: 'execution_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'discussion_agents', column: 'cli_effort', definition: 'TEXT' },
    { table: 'projects', column: 'npm_auto_install', definition: 'INTEGER DEFAULT 0' },
    { table: 'todos', column: 'summary', definition: 'TEXT' },
    { table: 'todos', column: 'diff_lines', definition: 'INTEGER' },
    { table: 'todos', column: 'diff_files', definition: 'INTEGER' },
    { table: 'planner_items', column: 'source_discussion_id', definition: 'TEXT' },
    { table: 'todos', column: 'memory_inject_mode', definition: "TEXT DEFAULT 'none'" },
    { table: 'todos', column: 'memory_node_ids', definition: 'TEXT' },
    { table: 'discussions', column: 'memory_inject_mode', definition: "TEXT DEFAULT 'none'" },
    { table: 'discussions', column: 'memory_node_ids', definition: 'TEXT' },
    { table: 'sessions', column: 'memory_inject_mode', definition: "TEXT DEFAULT 'none'" },
    { table: 'sessions', column: 'memory_node_ids', definition: 'TEXT' },
    { table: 'projects', column: 'memory_default_mode', definition: "TEXT DEFAULT 'none'" },
    { table: 'projects', column: 'memory_auto_ingest', definition: 'INTEGER DEFAULT 0' },
    { table: 'memory_nodes', column: 'source_type', definition: 'TEXT' },
    { table: 'memory_nodes', column: 'source_id', definition: 'TEXT' },
    { table: 'memory_nodes', column: 'source_path', definition: 'TEXT' },
    { table: 'todos', column: 'memory_raw_file_paths', definition: 'TEXT' },
    { table: 'discussions', column: 'memory_raw_file_paths', definition: 'TEXT' },
    { table: 'discussions', column: 'execution_snapshot', definition: 'TEXT' },
    { table: 'sessions', column: 'memory_raw_file_paths', definition: 'TEXT' },
    { table: 'sessions', column: 'tag_id', definition: 'TEXT' },
    { table: 'sessions', column: 'session_alias_id', definition: 'TEXT' },
    { table: 'projects', column: 'vcs_type', definition: 'TEXT' },
    { table: 'projects', column: 'svn_enabled', definition: 'INTEGER DEFAULT 0' },
    { table: 'projects', column: 'is_svn_wc', definition: 'INTEGER DEFAULT 0' },
    { table: 'projects', column: 'color', definition: 'TEXT' },
    { table: 'projects', column: 'sort_order', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'personal_items', column: 'images', definition: 'TEXT' },
    { table: 'personal_items', column: 'start_at', definition: 'TEXT' },
    { table: 'personal_items', column: 'end_at', definition: 'TEXT' },
    // Planner items gained an optional end date so month-view bars can span a
    // range (NULL = single-day, = due_date). See due_date above.
    { table: 'planner_items', column: 'end_date', definition: 'TEXT' },
    // On-demand Diff capture points: JSON array of { seq, sha, at } working-tree
    // snapshots the user took mid-session, each usable as a Diff page's base.
    { table: 'sessions', column: 'snapshots', definition: 'TEXT' },
    { table: 'sessions', column: 'cli_model_id', definition: 'TEXT REFERENCES cli_models(id)' },
    { table: 'sessions', column: 'execution_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'sessions', column: 'execution_snapshot', definition: 'TEXT' },
    { table: 'sessions', column: 'cli_effort', definition: 'TEXT' },
    { table: 'cli_models', column: 'supported_efforts', definition: 'TEXT' },
    { table: 'cli_models', column: 'provider_variants', definition: 'TEXT' },
    { table: 'cli_models', column: 'sort_order', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'cli_models', column: 'status', definition: "TEXT NOT NULL DEFAULT 'available'" },
    { table: 'cli_models', column: 'source', definition: "TEXT NOT NULL DEFAULT 'cli'" },
    { table: 'cli_models', column: 'superseded_by_model_id', definition: 'TEXT REFERENCES cli_models(id)' },
    { table: 'cli_models', column: 'last_seen_at', definition: 'DATETIME' },
    { table: 'cli_models', column: 'last_checked_at', definition: 'DATETIME' },
    { table: 'cli_models', column: 'updated_at', definition: 'DATETIME' },
    // Auto-delegation rule: JSON {"from":"claude","to":"codex"}, NULL = disabled.
    { table: 'projects', column: 'auto_delegate', definition: 'TEXT' },
    // Parent todo id when this todo was auto-created as a delegated review task.
    { table: 'todos', column: 'delegated_from', definition: 'TEXT' },
    { table: 'todos', column: 'resource_requirements', definition: 'TEXT' },
    { table: 'sessions', column: 'resource_requirements', definition: 'TEXT' },
    { table: 'schedules', column: 'resource_requirements', definition: 'TEXT' },
    { table: 'todos', column: 'review_enabled', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'todos', column: 'review_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'todos', column: 'rework_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'todos', column: 'max_review_rounds', definition: 'INTEGER NOT NULL DEFAULT 3' },
    { table: 'todos', column: 'pipeline_phase', definition: 'TEXT' },
    { table: 'projects', column: 'default_review_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'projects', column: 'default_max_review_rounds', definition: 'INTEGER' },
    { table: 'schedules', column: 'review_enabled', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'schedules', column: 'review_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'schedules', column: 'rework_profile_id', definition: 'TEXT REFERENCES execution_profiles(id)' },
    { table: 'schedules', column: 'max_review_rounds', definition: 'INTEGER' },
    { table: 'todo_execution_rounds', column: 'retry_of_round_id', definition: 'TEXT' },
    { table: 'todo_execution_rounds', column: 'attempt_index', definition: 'INTEGER NOT NULL DEFAULT 1' },
    { table: 'agent_forum_members', column: 'is_active', definition: 'INTEGER NOT NULL DEFAULT 1' },
    { table: 'agent_forum_turns', column: 'process_pid', definition: 'INTEGER' },
    { table: 'agent_forum_turns', column: 'process_identity', definition: 'TEXT' },
  ];

  for (const { table, column, definition } of migrations) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // Column already exists - ignore
    }
  }

  // Ensure index on retry_of_round_id exists
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_execution_rounds_retry_of ON todo_execution_rounds(retry_of_round_id)`);
  } catch {
    // Ignore if table or index doesn't exist yet
  }

  // Backfill vcs_type from legacy is_git_repo flag. Idempotent — only touches NULL rows.
  try {
    db.prepare(`UPDATE projects SET vcs_type = 'git' WHERE vcs_type IS NULL AND is_git_repo = 1`).run();
  } catch {
    // ignore — column may not exist yet on extremely old DBs that fail the ALTER above
  }

  // Backfill personal_items date range from legacy due_at (date part only —
  // time is dropped). Undated memos keep start_at NULL (stay in the backlog).
  // Idempotent — only touches rows not yet migrated.
  try {
    db.prepare(
      `UPDATE personal_items
         SET start_at = substr(due_at, 1, 10),
             end_at = substr(due_at, 1, 10)
       WHERE start_at IS NULL AND due_at IS NOT NULL`,
    ).run();
  } catch {
    // ignore — columns may not exist on DBs where the ALTER above failed
  }

  // Backfill sort_order for existing rows so projects keep their current
  // created_at DESC order when first migrated. Only runs when every row is
  // still at the default 0 (i.e. the column was just added).
  try {
    const allZero = db.prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE sort_order != 0`
    ).get() as { n: number };
    if (allZero.n === 0) {
      const rows = db.prepare(`SELECT id FROM projects ORDER BY created_at DESC`).all() as { id: string }[];
      const update = db.prepare(`UPDATE projects SET sort_order = ? WHERE id = ?`);
      const backfill = db.transaction(() => {
        rows.forEach((row, idx) => update.run(idx, row.id));
      });
      backfill();
    }
  } catch {
    // ignore — sort_order column may not exist on very old DBs that failed the ALTER above
  }

  // Deduplicate memory_nodes titles within a project, then enforce UNIQUE
  dedupeMemoryNodeTitles(db);
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_nodes_project_title ON memory_nodes(project_id, title)');
  } catch {
    // unique index creation may fail if dedupe missed a corner case; leave index off rather than crash startup
  }

  // Normalize catalogs created by older versions without turning a bundled
  // registry into a second source of truth.
  db.prepare(`UPDATE cli_models SET source = CASE WHEN source IN ('user', 'manual') THEN 'manual' ELSE 'cli' END`).run();
  const cliModelColumns = db.pragma('table_info(cli_models)') as Array<{ name: string }>;
  if (cliModelColumns.some((column) => column.name === 'availability_status')) {
    db.prepare(`UPDATE cli_models SET status = CASE WHEN status = 'missing' OR availability_status = 'unavailable' THEN 'missing' ELSE 'available' END`).run();
  }

  // Legacy single-agent profiles and star mappings are intentionally
  // destructive. SQLite 3.35+ can drop these columns in-place; older engines
  // retain only the column shell while all runtime paths ignore it.
  for (const [table, column] of [
    ['projects', 'default_effort_level'],
    ['todos', 'effort_level'], ['todos', 'agent_profile_id'],
    ['schedules', 'effort_level'], ['schedules', 'agent_profile_id'],
    ['sessions', 'effort_level'], ['sessions', 'agent_profile_id'],
    ['discussion_agents', 'effort_level'], ['discussion_agents', 'agent_profile_id'],
    ['cli_models', 'is_default'], ['cli_models', 'deprecated'],
    ['cli_models', 'last_verified_at'], ['cli_models', 'availability_status'],
  ] as const) dropColumnIfPresent(db, table, column);
  db.exec(`DELETE FROM execution_profile_executors
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM execution_profile_executors
      GROUP BY profile_id, cli_model_id, COALESCE(effort_value, '')
    )`);
  db.exec(`
    DROP TABLE IF EXISTS agent_profiles;
    DROP TABLE IF EXISTS agent_effort_profiles;
    CREATE INDEX IF NOT EXISTS idx_execution_profile_executors_profile
      ON execution_profile_executors(profile_id, priority);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_profile_executor_unique
      ON execution_profile_executors(profile_id, cli_model_id, COALESCE(effort_value, ''));
    CREATE INDEX IF NOT EXISTS idx_cli_models_tool_status
      ON cli_models(cli_tool, status);
  `);

  // Safely reconcile legacy duplicate rounds and enforce unique indexes
  enforceExecutionRoundUniqueIndexes(db);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Rename the retired 'gemini' CLI provider to 'antigravity' (Google shut down
  // Gemini CLI on 2026-06-18; Antigravity CLI is its successor). Idempotent —
  // once no 'gemini' rows remain these UPDATEs are no-ops.
  migrateGeminiToAntigravity(db);

  // Normalize legacy Antigravity effort variant rows to canonical logical models
  // with provider_variants JSON and migrate existing execution profile executors.
  normalizeAntigravityCatalogAndExecutors(db);

  // AgentForum V1 invariants: preserve turn history across participant removal
  // and enforce the core "one reply per agent per target" rule in the DB.
  migrateAgentForumTurnHistory(db);
  enforceAgentForumUniqueIndexes(db);
}
function dropColumnIfPresent(db: Database.Database, table: string, column: string): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) return;
  try { db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`); } catch { /* old SQLite or dependent legacy constraint */ }
}

/**
 * One-time rename of the 'gemini' cli_tool value to 'antigravity' across every
 * table that stores it, plus the 'gemini' token inside projects.cli_fallback_chain.
 * Idempotent and defensive: each statement is wrapped so a missing table/column on
 * an old DB doesn't abort startup.
 */
function migrateGeminiToAntigravity(db: Database.Database): void {
  const tables = [
    'cli_models',
    'cli_versions',
    'projects',
    'todos',
    'schedules',
    'sessions',
    'discussion_agents',
  ];
  const rename = db.transaction(() => {
    for (const table of tables) {
      try {
        db.prepare(`UPDATE ${table} SET cli_tool = 'antigravity' WHERE cli_tool = 'gemini'`).run();
      } catch {
        // table/column may not exist on very old DBs — skip
      }
    }
    // cli_fallback_chain stores an ordered CSV of cli_tool tokens (e.g. "claude,gemini,codex").
    try {
      db.prepare(
        `UPDATE projects
            SET cli_fallback_chain = replace(cli_fallback_chain, 'gemini', 'antigravity')
          WHERE cli_fallback_chain LIKE '%gemini%'`,
      ).run();
    } catch {
      // column may not exist on old DBs — skip
    }
  });
  rename();
}

/**
 * Suffix duplicate memory node titles within the same project (`-2`, `-3`, ...)
 * so a (project_id, title) UNIQUE index can be enforced. Idempotent.
 */
function dedupeMemoryNodeTitles(db: Database.Database): void {
  const dups = db.prepare(
    `SELECT project_id, title, COUNT(*) as cnt
       FROM memory_nodes
      GROUP BY project_id, title
     HAVING cnt > 1`
  ).all() as Array<{ project_id: string; title: string; cnt: number }>;
  if (dups.length === 0) return;

  const selectGroup = db.prepare(
    'SELECT id FROM memory_nodes WHERE project_id = ? AND title = ? ORDER BY created_at ASC, id ASC'
  );
  const titleExists = db.prepare(
    'SELECT 1 FROM memory_nodes WHERE project_id = ? AND title = ? LIMIT 1'
  );
  const updateTitle = db.prepare(
    'UPDATE memory_nodes SET title = ?, updated_at = ? WHERE id = ?'
  );

  const tx = db.transaction(() => {
    for (const dup of dups) {
      const rows = selectGroup.all(dup.project_id, dup.title) as Array<{ id: string }>;
      // Keep the first row's title; rename the rest with numeric suffixes
      for (let i = 1; i < rows.length; i++) {
        let suffix = i + 1;
        let candidate = `${dup.title}-${suffix}`;
        while (titleExists.get(dup.project_id, candidate)) {
          suffix += 1;
          candidate = `${dup.title}-${suffix}`;
        }
        updateTitle.run(candidate, new Date().toISOString(), rows[i].id);
      }
    }
  });
  tx();
}

/**
 * Reconciles legacy individual Antigravity effort variant rows (e.g. gemini-3.7-flash-high,
 * gemini-3.7-flash-medium, gemini-3.7-flash-low) into canonical logical models with
 * provider_variants JSON, and migrates execution_profile_executors, schedules, discussion_agents,
 * todos, and sessions to point to the canonical model + matching effort.
 * Idempotent.
 */
export function normalizeAntigravityCatalogAndExecutors(db: Database.Database): void {
  const rows = db.prepare(`SELECT * FROM cli_models WHERE cli_tool = 'antigravity'`).all() as Array<{
    id: string;
    model_value: string;
    model_label: string;
    supported_efforts: string | null;
    provider_variants: string | null;
    sort_order: number;
    status: string;
    source: string;
    last_seen_at: string | null;
    last_checked_at: string | null;
  }>;

  if (rows.length === 0) return;

  const EFFORT_SUFFIX_RE = /-(low|medium|high)$/i;
  const LABEL_SUFFIX_RE = /\s*\((?:low|medium|high)\)$/i;
  const STANDARD_EFFORTS = ['low', 'medium', 'high'];

  const variantGroups = new Map<string, Array<{ row: typeof rows[0]; effort: string }>>();
  for (const row of rows) {
    const match = row.model_value.match(EFFORT_SUFFIX_RE);
    if (match) {
      const base = row.model_value.slice(0, match.index);
      const effort = match[1].toLowerCase();
      const group = variantGroups.get(base) ?? [];
      group.push({ row, effort });
      variantGroups.set(base, group);
    }
  }

  const tx = db.transaction(() => {
    const now = new Date().toISOString();

    for (const [base, variants] of variantGroups.entries()) {
      if (variants.length < 2) continue;

      const availableEfforts = STANDARD_EFFORTS.filter((e) => variants.some((v) => v.effort === e));
      const providerVariantsMap: Record<string, string> = {};
      for (const effort of availableEfforts) {
        const variant = variants.find((v) => v.effort === effort);
        if (variant) providerVariantsMap[effort] = variant.row.model_value;
      }

      const firstVariant = variants[0];
      const baseLabel = firstVariant.row.model_label.replace(LABEL_SUFFIX_RE, '').trim() || base;
      const minSortOrder = Math.min(...variants.map((v) => v.row.sort_order));

      let canonicalRow = rows.find((r) => r.model_value === base);
      let canonicalId: string;
      if (!canonicalRow) {
        canonicalId = uuidv4();
        db.prepare(
          `INSERT INTO cli_models (id, cli_tool, model_value, model_label, supported_efforts, provider_variants, sort_order, status, source, last_seen_at, last_checked_at, created_at, updated_at)
           VALUES (?, 'antigravity', ?, ?, ?, ?, ?, 'available', 'cli', ?, ?, ?, ?)`
        ).run(
          canonicalId,
          base,
          baseLabel,
          JSON.stringify(availableEfforts),
          JSON.stringify(providerVariantsMap),
          minSortOrder,
          now,
          now,
          now,
          now
        );
      } else {
        canonicalId = canonicalRow.id;
        db.prepare(
          `UPDATE cli_models
              SET supported_efforts = COALESCE(supported_efforts, ?),
                  provider_variants = COALESCE(provider_variants, ?),
                  status = 'available',
                  updated_at = ?
            WHERE id = ?`
        ).run(
          JSON.stringify(availableEfforts),
          JSON.stringify(providerVariantsMap),
          now,
          canonicalId
        );
      }

      for (const { row: siblingRow, effort } of variants) {
        const executors = db.prepare(
          `SELECT * FROM execution_profile_executors WHERE cli_model_id = ?`
        ).all(siblingRow.id) as Array<{ id: string; profile_id: string; effort_value: string | null; priority: number; is_enabled: number }>;

        for (const executor of executors) {
          const duplicate = db.prepare(
            `SELECT id FROM execution_profile_executors
              WHERE profile_id = ? AND cli_model_id = ? AND COALESCE(effort_value, '') = ? AND id != ?`
          ).get(executor.profile_id, canonicalId, effort, executor.id) as { id: string } | undefined;

          if (duplicate) {
            db.prepare(`DELETE FROM execution_profile_executors WHERE id = ?`).run(executor.id);
          } else {
            db.prepare(
              `UPDATE execution_profile_executors
                  SET cli_model_id = ?, effort_value = ?, updated_at = ?
                WHERE id = ?`
            ).run(canonicalId, effort, now, executor.id);
          }
        }

        db.prepare(
          `UPDATE schedules
              SET cli_model_id = ?, cli_effort = COALESCE(cli_effort, ?), cli_model = ?, updated_at = ?
            WHERE cli_model_id = ? OR (cli_tool = 'antigravity' AND cli_model = ?)`
        ).run(canonicalId, effort, base, now, siblingRow.id, siblingRow.model_value);

        db.prepare(
          `UPDATE discussion_agents
              SET cli_model_id = ?, cli_effort = COALESCE(cli_effort, ?), cli_model = ?, updated_at = ?
            WHERE cli_model_id = ? OR (cli_tool = 'antigravity' AND cli_model = ?)`
        ).run(canonicalId, effort, base, now, siblingRow.id, siblingRow.model_value);

        db.prepare(
          `UPDATE todos
              SET cli_model_id = ?, cli_effort = COALESCE(cli_effort, ?), cli_model = ?, updated_at = ?
            WHERE cli_model_id = ? OR (cli_tool = 'antigravity' AND cli_model = ?)`
        ).run(canonicalId, effort, base, now, siblingRow.id, siblingRow.model_value);

        db.prepare(
          `UPDATE sessions
              SET cli_model_id = ?, cli_effort = COALESCE(cli_effort, ?), cli_model = ?, updated_at = ?
            WHERE cli_model_id = ? OR (cli_tool = 'antigravity' AND cli_model = ?)`
        ).run(canonicalId, effort, base, now, siblingRow.id, siblingRow.model_value);

        db.prepare(
          `UPDATE cli_models SET superseded_by_model_id = ?, status = 'missing', updated_at = ? WHERE id = ?`
        ).run(canonicalId, now, siblingRow.id);
      }
    }
  });

  tx();
}


/**
 * Deterministically reconciles legacy duplicate execution rounds from prior versions
 * before creating unique indexes. Older conflicting active rounds are marked 'failed'
 * with diagnostic metadata so that unique active-round index can be created safely
 * without deleting historical records.
 */
export function dedupeLegacyExecutionRounds(db: Database.Database): void {
  const roundsTableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='todo_execution_rounds'`
  ).get();
  if (!roundsTableExists) return;

  try {

    // 1. Reconcile duplicate (todo_id, round_index) rows if any
    const duplicateIndexRows = db.prepare(`
      SELECT todo_id, round_index
      FROM todo_execution_rounds
      GROUP BY todo_id, round_index
      HAVING COUNT(*) > 1
    `).all() as Array<{ todo_id: string; round_index: number }>;

    if (duplicateIndexRows.length > 0) {
      const now = new Date().toISOString();
      const reconcileIndexTx = db.transaction(() => {
        for (const { todo_id, round_index } of duplicateIndexRows) {
          const rows = db.prepare(`
            SELECT id, status FROM todo_execution_rounds
            WHERE todo_id = ? AND round_index = ?
            ORDER BY created_at DESC, id DESC
          `).all(todo_id, round_index) as Array<{ id: string; status: string }>;

          const duplicates = rows.slice(1);
          const maxRow = db.prepare(`SELECT MAX(round_index) as max_idx FROM todo_execution_rounds WHERE todo_id = ?`).get(todo_id) as { max_idx: number };
          let nextIdx = (maxRow?.max_idx ?? 100) + 1;
          for (let i = 0; i < duplicates.length; i++) {
            db.prepare(`
              UPDATE todo_execution_rounds
              SET round_index = ?,
                  status = 'failed',
                  error_message = 'Superseded legacy duplicate round during schema migration',
                  finished_at = COALESCE(finished_at, ?),
                  updated_at = ?
              WHERE id = ?
            `).run(nextIdx++, now, now, duplicates[i].id);
          }
        }
      });
      reconcileIndexTx();
    }

    // 2. Reconcile duplicate active rounds for the same todo_id
    const duplicateActiveRows = db.prepare(`
      SELECT todo_id
      FROM todo_execution_rounds
      WHERE status IN ('pending', 'waiting_executor', 'waiting_quota', 'waiting_resource', 'running')
      GROUP BY todo_id
      HAVING COUNT(*) > 1
    `).all() as Array<{ todo_id: string }>;

    if (duplicateActiveRows.length > 0) {
      const now = new Date().toISOString();
      const reconcileActiveTx = db.transaction(() => {
        for (const { todo_id } of duplicateActiveRows) {
          const activeRounds = db.prepare(`
            SELECT id, round_index
            FROM todo_execution_rounds
            WHERE todo_id = ? AND status IN ('pending', 'waiting_executor', 'waiting_quota', 'waiting_resource', 'running')
            ORDER BY round_index DESC, created_at DESC
          `).all(todo_id) as Array<{ id: string; round_index: number }>;

          // Keep the newest active round, mark older active rounds as failed
          const olderRounds = activeRounds.slice(1);
          for (const round of olderRounds) {
            db.prepare(`
              UPDATE todo_execution_rounds
              SET status = 'failed',
                  error_message = 'Superseded legacy active round during schema migration',
                  finished_at = COALESCE(finished_at, ?),
                  updated_at = ?
              WHERE id = ?
            `).run(now, now, round.id);
          }
        }
      });
      reconcileActiveTx();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reconcile legacy todo execution rounds during schema migration: ${message}`);
  }
}

/**
 * Enforces the two critical Review/Rework V1 invariants on todo_execution_rounds:
 * 1. UNIQUE(todo_id, round_index)
 * 2. At most one active execution round per Todo
 *
 * Runs deterministic legacy deduplication first, then creates both unique indexes.
 * Throws a descriptive startup error if either invariant cannot be enforced.
 */
export function enforceExecutionRoundUniqueIndexes(db: Database.Database): void {
  const roundsTableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='todo_execution_rounds'`
  ).get();
  if (!roundsTableExists) return;

  dedupeLegacyExecutionRounds(db);

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_execution_rounds_unique_index
        ON todo_execution_rounds(todo_id, round_index);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_execution_rounds_active_unique
        ON todo_execution_rounds(todo_id)
        WHERE status IN ('pending', 'waiting_executor', 'waiting_quota', 'waiting_resource', 'running');
    `);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to enforce todo execution round uniqueness after legacy reconciliation: ${message}`
    );
  }
}

/**
 * AgentForum V1: participant removal must never destroy execution history.
 *
 * The initial release declared `agent_forum_turns.member_id ... ON DELETE
 * CASCADE`, so deleting a participant silently erased that participant's turns
 * and execution snapshots while their messages survived — leaving orphaned
 * history. Rebuild the table with ON DELETE RESTRICT (removal is now expressed
 * as a soft-disable via `agent_forum_members.is_active`) and widen the status
 * CHECK to cover the transient non-success states.
 *
 * Idempotent: inspects the existing foreign key and CHECK before touching
 * anything, and preserves every existing row.
 */
export function migrateAgentForumTurnHistory(db: Database.Database): void {
  const tableRow = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_forum_turns'`
  ).get() as { sql: string } | undefined;
  if (!tableRow) return;

  const memberFk = (db.pragma('foreign_key_list(agent_forum_turns)') as Array<{ table: string; on_delete: string }>)
    .find((fk) => fk.table === 'agent_forum_members');
  const needsFkRebuild = !!memberFk && memberFk.on_delete.toUpperCase() !== 'RESTRICT';
  const needsStatusRebuild = !tableRow.sql.includes("'skipped'");
  if (!needsFkRebuild && !needsStatusRebuild) return;

  const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE agent_forum_turns_migrated (
          id TEXT PRIMARY KEY,
          forum_id TEXT NOT NULL REFERENCES agent_forums(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES agent_forum_members(id) ON DELETE RESTRICT,
          cycle_number INTEGER NOT NULL,
          turn_order INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'passed', 'skipped', 'stopped')),
          execution_snapshot TEXT,
          process_pid INTEGER,
          process_identity TEXT,
          raw_output TEXT,
          error_message TEXT,
          started_at DATETIME,
          completed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO agent_forum_turns_migrated
          (id, forum_id, member_id, cycle_number, turn_order, status,
           execution_snapshot, process_pid, process_identity, raw_output, error_message, started_at, completed_at, created_at)
        SELECT id, forum_id, member_id, cycle_number, turn_order, status,
               execution_snapshot, process_pid, process_identity, raw_output, error_message, started_at, completed_at, created_at
        FROM agent_forum_turns;

        DROP TABLE agent_forum_turns;
        ALTER TABLE agent_forum_turns_migrated RENAME TO agent_forum_turns;
        CREATE INDEX IF NOT EXISTS idx_agent_forum_turns_forum ON agent_forum_turns(forum_id, cycle_number);
      `);
    });
    rebuild();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to migrate agent_forum_turns history retention: ${message}`);
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

/**
 * Enforces the two AgentForum V1 persistence invariants at the DB level, so
 * they never depend on prompt compliance or extractor validation alone:
 *
 * 1. An agent may reply to a given target message at most once
 *    — partial UNIQUE(forum_id, author_id, parent_message_id) over agent rows.
 * 2. A logical turn identity is unique
 *    — UNIQUE(forum_id, cycle_number, turn_order).
 *
 * Legacy rows written before the indexes existed are reconciled first so the
 * migration cannot fail on an existing database: duplicate agent replies keep
 * the oldest row and are re-parented to NULL, duplicate turn identities are
 * pushed onto free turn_order slots.
 */
export function enforceAgentForumUniqueIndexes(db: Database.Database): void {
  const messagesExist = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_forum_messages'`
  ).get();
  const turnsExist = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_forum_turns'`
  ).get();

  try {
    if (messagesExist) {
      const duplicateReplies = db.prepare(`
        SELECT forum_id, author_id, parent_message_id
        FROM agent_forum_messages
        WHERE author_type = 'agent' AND author_id IS NOT NULL AND parent_message_id IS NOT NULL
        GROUP BY forum_id, author_id, parent_message_id
        HAVING COUNT(*) > 1
      `).all() as Array<{ forum_id: string; author_id: string; parent_message_id: string }>;

      if (duplicateReplies.length > 0) {
        const reconcile = db.transaction(() => {
          for (const dup of duplicateReplies) {
            const rows = db.prepare(`
              SELECT id FROM agent_forum_messages
              WHERE forum_id = ? AND author_id = ? AND parent_message_id = ? AND author_type = 'agent'
              ORDER BY created_at ASC, rowid ASC
            `).all(dup.forum_id, dup.author_id, dup.parent_message_id) as Array<{ id: string }>;
            // Keep the first reply attached; detach the rest to root so no
            // historical message content is destroyed by the migration.
            for (const row of rows.slice(1)) {
              db.prepare(`UPDATE agent_forum_messages SET parent_message_id = NULL WHERE id = ?`).run(row.id);
            }
          }
        });
        reconcile();
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_forum_messages_agent_reply_unique
          ON agent_forum_messages(forum_id, author_id, parent_message_id)
          WHERE author_type = 'agent' AND author_id IS NOT NULL AND parent_message_id IS NOT NULL;
      `);
    }

    if (turnsExist) {
      const duplicateTurns = db.prepare(`
        SELECT forum_id, cycle_number, turn_order
        FROM agent_forum_turns
        GROUP BY forum_id, cycle_number, turn_order
        HAVING COUNT(*) > 1
      `).all() as Array<{ forum_id: string; cycle_number: number; turn_order: number }>;

      if (duplicateTurns.length > 0) {
        const reconcile = db.transaction(() => {
          for (const dup of duplicateTurns) {
            const rows = db.prepare(`
              SELECT id FROM agent_forum_turns
              WHERE forum_id = ? AND cycle_number = ? AND turn_order = ?
              ORDER BY created_at ASC, rowid ASC
            `).all(dup.forum_id, dup.cycle_number, dup.turn_order) as Array<{ id: string }>;
            const maxRow = db.prepare(
              `SELECT COALESCE(MAX(turn_order), -1) AS max_order FROM agent_forum_turns WHERE forum_id = ? AND cycle_number = ?`
            ).get(dup.forum_id, dup.cycle_number) as { max_order: number };
            let nextOrder = maxRow.max_order + 1;
            for (const row of rows.slice(1)) {
              db.prepare(`UPDATE agent_forum_turns SET turn_order = ? WHERE id = ?`).run(nextOrder++, row.id);
            }
          }
        });
        reconcile();
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_forum_turns_identity_unique
          ON agent_forum_turns(forum_id, cycle_number, turn_order);
      `);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to enforce AgentForum uniqueness invariants: ${message}`);
  }
}
