# Database ERD

<!-- AUTO-GENERATED FROM src/server/db/schema.ts — DO NOT EDIT MANUALLY -->
<!-- To regenerate: npm run docs:erd -->
<!-- CI verifies this file is in sync: npm run docs:erd:check -->

Source: `src/server/db/schema.ts`
Stats: 32 tables, 372 columns, 35 foreign keys

## Diagram

```mermaid
erDiagram
    execution_profiles ||--o{ projects : "default_review_profile_id"
    projects ||--o{ todos : "project_id"
    cli_models ||--o{ todos : "cli_model_id"
    execution_profiles ||--o{ todos : "execution_profile_id"
    execution_profiles ||--o{ todos : "review_profile_id"
    execution_profiles ||--o{ todos : "rework_profile_id"
    todos ||--o{ task_logs : "todo_id"
    projects ||--o{ schedules : "project_id"
    execution_profiles ||--o{ schedules : "review_profile_id"
    execution_profiles ||--o{ schedules : "rework_profile_id"
    schedules ||--o{ schedule_runs : "schedule_id"
    todos |o--o{ schedule_runs : "todo_id"
    cli_models ||--o{ cli_models : "superseded_by_model_id"
    execution_profiles ||--o{ execution_profile_executors : "profile_id"
    cli_models ||--o{ execution_profile_executors : "cli_model_id"
    projects ||--o{ discussion_agents : "project_id"
    cli_models ||--o{ discussion_agents : "cli_model_id"
    execution_profiles ||--o{ discussion_agents : "execution_profile_id"
    projects ||--o{ discussions : "project_id"
    discussions ||--o{ discussion_messages : "discussion_id"
    discussions ||--o{ discussion_logs : "discussion_id"
    projects ||--o{ sessions : "project_id"
    cli_models ||--o{ sessions : "cli_model_id"
    execution_profiles ||--o{ sessions : "execution_profile_id"
    sessions ||--o{ session_logs : "session_id"
    sessions ||--o{ session_raw_chunks : "session_id"
    projects ||--o{ planner_items : "project_id"
    projects ||--o{ planner_tags : "project_id"
    projects ||--o{ planner_pages : "project_id"
    projects ||--o{ memory_nodes : "project_id"
    projects ||--o{ memory_edges : "project_id"
    memory_nodes ||--o{ memory_edges : "from_node_id"
    memory_nodes ||--o{ memory_edges : "to_node_id"
    projects ||--o{ memory_logs : "project_id"
    todos ||--o{ todo_execution_rounds : "todo_id"

    projects {
        TEXT id PK
        TEXT name
        TEXT path UK
        TEXT default_branch
        INTEGER is_git_repo
        INTEGER max_concurrent
        TEXT claude_model
        TEXT claude_options
        DATETIME created_at
        DATETIME updated_at
        TEXT cli_tool
        INTEGER default_max_turns
        TEXT cli_fallback_chain
        TEXT sandbox_mode
        INTEGER debug_logging
        INTEGER use_worktree
        INTEGER show_token_usage
        INTEGER npm_auto_install
        TEXT memory_default_mode
        INTEGER memory_auto_ingest
        TEXT vcs_type
        INTEGER svn_enabled
        INTEGER is_svn_wc
        TEXT color
        INTEGER sort_order
        TEXT auto_delegate
        TEXT default_review_profile_id FK
        INTEGER default_max_review_rounds
    }
    todos {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT description
        TEXT status
        INTEGER priority
        TEXT branch_name
        TEXT worktree_path
        INTEGER process_pid
        DATETIME created_at
        DATETIME updated_at
        TEXT cli_tool
        TEXT cli_model
        TEXT cli_model_id FK
        TEXT execution_profile_id FK
        TEXT execution_snapshot
        TEXT cli_effort
        TEXT schedule_id
        TEXT images
        TEXT depends_on
        INTEGER max_turns
        TEXT token_usage
        REAL position_x
        REAL position_y
        TEXT merged_from_branch
        INTEGER context_switch_count
        TEXT execution_mode
        INTEGER round_count
        REAL total_cost_usd
        INTEGER total_tokens
        INTEGER use_worktree
        TEXT summary
        INTEGER diff_lines
        INTEGER diff_files
        TEXT memory_inject_mode
        TEXT memory_node_ids
        TEXT memory_raw_file_paths
        TEXT delegated_from
        TEXT resource_requirements
        INTEGER review_enabled
        TEXT review_profile_id FK
        TEXT rework_profile_id FK
        INTEGER max_review_rounds
        TEXT pipeline_phase
    }
    task_logs {
        TEXT id PK
        TEXT todo_id FK
        TEXT log_type
        TEXT message
        DATETIME created_at
        INTEGER round_number
    }
    schedules {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT description
        TEXT cron_expression
        TEXT cli_tool
        TEXT cli_model
        TEXT cli_model_id
        TEXT cli_effort
        TEXT execution_profile_id
        INTEGER max_turns
        INTEGER use_worktree
        TEXT memory_inject_mode
        TEXT memory_node_ids
        TEXT memory_raw_file_paths
        INTEGER is_active
        INTEGER skip_if_running
        DATETIME last_run_at
        DATETIME next_run_at
        DATETIME created_at
        DATETIME updated_at
        TEXT schedule_type
        DATETIME run_at
        TEXT resource_requirements
        INTEGER review_enabled
        TEXT review_profile_id FK
        TEXT rework_profile_id FK
        INTEGER max_review_rounds
    }
    schedule_runs {
        TEXT id PK
        TEXT schedule_id FK
        TEXT todo_id FK
        TEXT status
        TEXT skipped_reason
        DATETIME started_at
        DATETIME completed_at
    }
    cli_models {
        TEXT id PK
        TEXT cli_tool
        TEXT model_value
        TEXT model_label
        TEXT supported_efforts
        TEXT provider_variants
        INTEGER sort_order
        TEXT status
        TEXT source
        TEXT superseded_by_model_id FK
        DATETIME last_seen_at
        DATETIME last_checked_at
        DATETIME created_at
        DATETIME updated_at
    }
    execution_profiles {
        TEXT id PK
        TEXT slug UK
        TEXT name
        TEXT description
        INTEGER is_enabled
        INTEGER sort_order
        DATETIME created_at
        DATETIME updated_at
    }
    execution_profile_executors {
        TEXT id PK
        TEXT profile_id FK
        TEXT cli_model_id FK
        TEXT effort_value
        INTEGER priority
        INTEGER is_enabled
        DATETIME created_at
        DATETIME updated_at
    }
    cli_versions {
        TEXT cli_tool PK
        TEXT last_version
        DATETIME last_synced_at
    }
    plugin_configs {
        TEXT id PK
        TEXT project_id
        TEXT plugin_id
        TEXT config_key
        TEXT config_value
        DATETIME created_at
        DATETIME updated_at
    }
    discussion_agents {
        TEXT id PK
        TEXT project_id FK
        TEXT name
        TEXT role
        TEXT system_prompt
        TEXT cli_tool
        TEXT cli_model
        TEXT avatar_color
        INTEGER sort_order
        DATETIME created_at
        DATETIME updated_at
        INTEGER can_implement
        TEXT cli_model_id FK
        TEXT execution_profile_id FK
        TEXT cli_effort
    }
    discussions {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT description
        TEXT status
        INTEGER current_round
        INTEGER max_rounds
        TEXT current_agent_id
        TEXT branch_name
        TEXT worktree_path
        INTEGER process_pid
        TEXT agent_ids
        DATETIME created_at
        DATETIME updated_at
        INTEGER auto_implement
        TEXT implement_agent_id
        INTEGER use_worktree
        TEXT memory_inject_mode
        TEXT memory_node_ids
        TEXT memory_raw_file_paths
        TEXT execution_snapshot
    }
    discussion_messages {
        TEXT id PK
        TEXT discussion_id FK
        TEXT agent_id
        INTEGER round_number
        INTEGER turn_order
        TEXT role
        TEXT agent_name
        TEXT content
        TEXT status
        DATETIME started_at
        DATETIME completed_at
        DATETIME created_at
    }
    discussion_logs {
        TEXT id PK
        TEXT discussion_id FK
        TEXT message_id
        TEXT log_type
        TEXT message
        DATETIME created_at
    }
    sessions {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT description
        TEXT status
        TEXT cli_tool
        TEXT cli_model
        INTEGER process_pid
        TEXT branch_name
        TEXT worktree_path
        TEXT base_commit
        TEXT token_usage
        REAL total_cost_usd
        INTEGER total_tokens
        DATETIME created_at
        DATETIME updated_at
        INTEGER use_worktree
        TEXT memory_inject_mode
        TEXT memory_node_ids
        TEXT memory_raw_file_paths
        TEXT tag_id
        TEXT session_alias_id
        TEXT snapshots
        TEXT cli_model_id FK
        TEXT execution_profile_id FK
        TEXT execution_snapshot
        TEXT cli_effort
        TEXT resource_requirements
    }
    session_logs {
        TEXT id PK
        TEXT session_id FK
        TEXT log_type
        TEXT message
        DATETIME created_at
    }
    session_raw_chunks {
        TEXT session_id FK
        INTEGER seq
        BLOB bytes
        DATETIME created_at
        KEY PRIMARY
    }
    resource_leases {
        TEXT id PK
        TEXT resource_key
        INTEGER amount
        TEXT owner_type
        TEXT owner_id
        TEXT run_token
        DATETIME acquired_at
        DATETIME heartbeat_at
        DATETIME expires_at
    }
    planner_items {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT description
        TEXT tags
        TEXT due_date
        TEXT end_date
        TEXT status
        INTEGER priority
        TEXT converted_type
        TEXT converted_id
        DATETIME created_at
        DATETIME updated_at
        TEXT images
        TEXT page_id
        TEXT source_discussion_id
    }
    planner_tags {
        TEXT id PK
        TEXT project_id FK
        TEXT name
        TEXT color
    }
    planner_pages {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT content
        DATETIME created_at
        DATETIME updated_at
    }
    personal_items {
        TEXT id PK
        TEXT title
        TEXT description
        TEXT due_at
        TEXT start_at
        TEXT end_at
        INTEGER all_day
        TEXT status
        INTEGER priority
        TEXT tags
        DATETIME created_at
        DATETIME updated_at
        TEXT images
    }
    app_settings {
        TEXT key PK
        TEXT value
        DATETIME updated_at
    }
    memory_nodes {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT body
        TEXT tags
        REAL position_x
        REAL position_y
        INTEGER pinned
        DATETIME created_at
        DATETIME updated_at
        TEXT source_type
        TEXT source_id
        TEXT source_path
    }
    memory_edges {
        TEXT id PK
        TEXT project_id FK
        TEXT from_node_id FK
        TEXT to_node_id FK
        TEXT relation_type
        TEXT label
        DATETIME created_at
    }
    memory_logs {
        TEXT id PK
        TEXT project_id FK
        TEXT event_type
        TEXT severity
        TEXT source_type
        TEXT source_id
        TEXT source_title
        TEXT message
        TEXT metadata
        DATETIME created_at
    }
    favorites {
        TEXT id PK
        TEXT name
        TEXT type
        TEXT target
        TEXT args
        TEXT cwd
        TEXT icon
        INTEGER sort_order
        DATETIME created_at
        DATETIME updated_at
    }
    app_settings {
        TEXT key PK
        TEXT value
        DATETIME updated_at
    }
    session_tags {
        TEXT id PK
        TEXT name UK
        TEXT color
        INTEGER sort_order
        DATETIME created_at
        DATETIME updated_at
    }
    session_aliases {
        TEXT id PK
        TEXT name UK
        TEXT command_template
        INTEGER sort_order
        DATETIME created_at
        DATETIME updated_at
    }
    provider_quota_state {
        TEXT tool PK
        TEXT state
        TEXT source
        TEXT reason
        DATETIME observed_at
        DATETIME reset_at
        DATETIME updated_at
    }
    todo_execution_rounds {
        TEXT id PK
        TEXT todo_id FK
        INTEGER round_index
        TEXT phase
        TEXT status
        TEXT run_token
        TEXT execution_snapshot
        TEXT input_payload
        TEXT result_payload
        TEXT error_message
        DATETIME started_at
        DATETIME finished_at
        DATETIME created_at
        DATETIME updated_at
    }
```

## Domain Groupings

- **Todo Execution**: `projects` → `todos` → `task_logs`
- **Scheduling**: `projects` → `schedules` → `schedule_runs` → `todos`
- **Discussion**: `projects` → `discussion_agents` / `discussions` → `discussion_messages` / `discussion_logs`
- **Session**: `projects` → `sessions` → `session_logs`
- **Planner**: `projects` → `planner_items` / `planner_tags`
- **Plugin Config**: `projects` → `plugin_configs` (implicit FK, see notes)
- **CLI Registry**: `cli_models`, `cli_versions` (standalone)

## Notes

- `plugin_configs.project_id` has no SQL `REFERENCES` declaration but conceptually points to `projects.id`. It is a generic key-value table used by the plugin system.
- Relationships: `||--o{` = parent required (ON DELETE CASCADE), `|o--o{` = parent optional (ON DELETE SET NULL).
- Columns added via `ALTER TABLE` migrations in `schema.ts` are merged into their parent tables in declaration order.
- Composite `UNIQUE(...)` constraints are omitted from the diagram; see `schema.ts` for the full definition.
