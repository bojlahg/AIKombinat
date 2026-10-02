# Database ERD

<!-- AUTO-GENERATED FROM src/server/db/schema.ts — DO NOT EDIT MANUALLY -->
<!-- To regenerate: npm run docs:erd -->
<!-- CI verifies this file is in sync: npm run docs:erd:check -->

Source: `src/server/db/schema.ts`
Stats: 73 tables, 880 columns, 116 foreign keys

## Diagram

```mermaid
erDiagram
    projects ||--o{ orchestrators : "project_id"
    execution_profiles ||--o{ orchestrators : "primary_execution_profile_id"
    orchestrators ||--o{ orchestrator_turns : "orchestrator_id"
    orchestrators ||--o{ orchestrator_messages : "orchestrator_id"
    orchestrator_turns ||--o{ orchestrator_messages : "turn_id"
    orchestrators ||--o{ orchestrator_events : "orchestrator_id"
    orchestrator_turns ||--o{ orchestrator_events : "assigned_turn_id"
    orchestrators ||--o{ orchestrator_operations : "orchestrator_id"
    orchestrator_turns ||--o{ orchestrator_operations : "turn_id"
    resource_requests ||--o{ orchestrator_resource_requests : "id"
    orchestrators ||--o{ orchestrator_resource_requests : "orchestrator_id"
    orchestrator_turns ||--o{ orchestrator_resource_requests : "created_by_turn_id"
    todos ||--o{ orchestrator_resource_requests : "claimed_todo_id"
    orchestrators ||--o{ orchestrator_child_jobs : "orchestrator_id"
    todos ||--o{ orchestrator_child_jobs : "todo_id"
    orchestrator_turns ||--o{ orchestrator_child_jobs : "created_by_turn_id"
    orchestrator_resource_requests ||--o{ orchestrator_child_jobs : "resource_request_id"
    review_policies ||--o{ projects : "default_review_policy_id"
    execution_profiles ||--o{ projects : "default_review_profile_id"
    projects ||--o{ todos : "project_id"
    review_policies ||--o{ todos : "review_policy_id"
    provider_accounts ||--o{ todos : "provider_account_id"
    cli_models ||--o{ todos : "cli_model_id"
    execution_profiles ||--o{ todos : "execution_profile_id"
    execution_profiles ||--o{ todos : "review_profile_id"
    execution_profiles ||--o{ todos : "rework_profile_id"
    todos ||--o{ task_logs : "todo_id"
    projects ||--o{ schedules : "project_id"
    provider_accounts ||--o{ schedules : "provider_account_id"
    execution_profiles ||--o{ schedules : "review_profile_id"
    execution_profiles ||--o{ schedules : "rework_profile_id"
    schedules ||--o{ schedule_runs : "schedule_id"
    todos |o--o{ schedule_runs : "todo_id"
    cli_models ||--o{ cli_models : "superseded_by_model_id"
    execution_profiles ||--o{ execution_profile_executors : "profile_id"
    cli_models ||--o{ execution_profile_executors : "cli_model_id"
    provider_accounts ||--o{ execution_profile_executors : "provider_account_id"
    execution_profiles |o--o{ execution_profile_rebind_audit : "profile_id"
    execution_profile_executors |o--o{ execution_profile_rebind_audit : "executor_candidate_id"
    projects ||--o{ discussion_agents : "project_id"
    provider_accounts ||--o{ discussion_agents : "provider_account_id"
    cli_models ||--o{ discussion_agents : "cli_model_id"
    execution_profiles ||--o{ discussion_agents : "execution_profile_id"
    projects ||--o{ discussions : "project_id"
    discussions ||--o{ discussion_messages : "discussion_id"
    discussions ||--o{ discussion_logs : "discussion_id"
    projects ||--o{ sessions : "project_id"
    provider_accounts ||--o{ sessions : "provider_account_id"
    cli_models ||--o{ sessions : "cli_model_id"
    execution_profiles ||--o{ sessions : "execution_profile_id"
    sessions ||--o{ session_logs : "session_id"
    sessions ||--o{ session_raw_chunks : "session_id"
    compute_nodes ||--o{ compute_node_connections : "node_id"
    compute_nodes ||--o{ inventory_snapshots : "node_id"
    compute_nodes ||--o{ resource_policies : "node_id"
    compute_nodes ||--o{ resource_instances : "node_id"
    resource_requests ||--o{ resource_bindings : "request_id"
    compute_nodes ||--o{ resource_bindings : "node_id"
    resource_bindings ||--o{ resource_binding_items : "binding_id"
    resource_instances ||--o{ resource_binding_items : "resource_instance_id"
    compute_nodes ||--o{ resource_observations : "node_id"
    resource_bindings ||--o{ remote_executions : "binding_id"
    resource_bindings ||--o{ resource_leases : "binding_id"
    projects ||--o{ planner_items : "project_id"
    projects ||--o{ planner_tags : "project_id"
    projects ||--o{ planner_pages : "project_id"
    projects ||--o{ memory_nodes : "project_id"
    projects ||--o{ memory_edges : "project_id"
    memory_nodes ||--o{ memory_edges : "from_node_id"
    memory_nodes ||--o{ memory_edges : "to_node_id"
    projects ||--o{ memory_logs : "project_id"
    todos ||--o{ todo_execution_rounds : "todo_id"
    todos ||--o{ delegation_parent_executions : "owner_id"
    delegation_parent_executions ||--o{ delegation_tool_observations : "parent_execution_id"
    delegation_parent_executions ||--o{ delegation_runs : "parent_execution_id"
    execution_profiles ||--o{ delegation_runs : "execution_profile_id"
    delegation_parent_executions ||--o{ delegation_fallback_grants : "parent_execution_id"
    projects ||--o{ agent_forums : "project_id"
    agent_forums ||--o{ agent_forum_members : "forum_id"
    cli_models ||--o{ agent_forum_members : "cli_model_id"
    execution_profiles ||--o{ agent_forum_members : "execution_profile_id"
    agent_forums ||--o{ agent_forum_messages : "forum_id"
    agent_forum_messages |o--o{ agent_forum_messages : "parent_message_id"
    agent_forums ||--o{ agent_forum_turns : "forum_id"
    agent_forum_members ||--o{ agent_forum_turns : "member_id"
    provider_accounts ||--o{ provider_account_quota_state : "provider_account_id"
    provider_accounts ||--o{ account_failover_events : "from_account_id"
    provider_accounts ||--o{ account_failover_events : "to_account_id"
    execution_profiles ||--o{ review_policies : "judge_execution_profile_id"
    review_policies ||--o{ review_policy_members : "review_policy_id"
    execution_profiles ||--o{ review_policy_members : "execution_profile_id"
    todos ||--o{ consensus_review_batches : "todo_id"
    todo_execution_rounds ||--o{ consensus_review_batches : "review_round_id"
    review_policies ||--o{ consensus_review_batches : "review_policy_id"
    execution_profiles ||--o{ consensus_review_batches : "judge_execution_profile_id"
    consensus_review_batches ||--o{ consensus_review_jobs : "batch_id"
    review_policy_members ||--o{ consensus_review_jobs : "policy_member_id"
    execution_profiles ||--o{ consensus_review_jobs : "execution_profile_id"
    consensus_review_jobs ||--o{ consensus_review_attempts : "review_job_id"
    consensus_review_attempts ||--o{ consensus_review_attempts : "retry_of_attempt_id"
    projects ||--o{ review_evaluation_feedback : "project_id"
    todos ||--o{ review_evaluation_feedback : "todo_id"
    consensus_review_batches ||--o{ review_evaluation_feedback : "batch_id"
    consensus_review_jobs ||--o{ review_evaluation_feedback : "review_job_id"
    todos ||--o{ review_human_actions : "todo_id"
    todo_execution_rounds ||--o{ review_human_actions : "review_round_id"
    consensus_review_batches ||--o{ review_human_actions : "batch_id"
    projects ||--o{ evaluation_campaigns : "project_id"
    evaluation_campaigns ||--o{ evaluation_campaign_arms : "campaign_id"
    execution_profiles ||--o{ evaluation_campaign_arms : "review_profile_id"
    review_policies ||--o{ evaluation_campaign_arms : "review_policy_id"
    execution_profiles ||--o{ evaluation_campaign_arms : "rework_profile_id"
    evaluation_campaigns ||--o{ evaluation_campaign_assignments : "campaign_id"
    evaluation_campaign_arms ||--o{ evaluation_campaign_assignments : "arm_id"
    todos ||--o{ evaluation_campaign_assignments : "todo_id"
    evaluation_campaign_assignments ||--o{ evaluation_campaign_assignment_feedback : "assignment_id"

    orchestrators {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT objective
        TEXT status
        TEXT primary_execution_profile_id FK
        TEXT state_summary
        TEXT current_plan
        TEXT waiting_reason
        TEXT wake_condition_json
        INTEGER max_turns
        INTEGER max_children
        INTEGER max_concurrent_children
        INTEGER max_active_resource_requests
        INTEGER turn_count
        INTEGER child_count
        TEXT created_at
        TEXT updated_at
        TEXT started_at
        TEXT finished_at
    }
    orchestrator_turns {
        TEXT id PK
        TEXT orchestrator_id FK
        INTEGER turn_index
        TEXT status
        TEXT trigger_type
        TEXT execution_snapshot
        INTEGER process_pid
        TEXT process_identity
        TEXT input_context_hash
        TEXT assistant_output
        TEXT error_message
        TEXT terminal_action
        INTEGER retry_count
        TEXT started_at
        TEXT finished_at
        TEXT created_at
        TEXT quota_chain_id
    }
    orchestrator_messages {
        TEXT id PK
        TEXT orchestrator_id FK
        TEXT turn_id FK
        TEXT role
        TEXT content
        TEXT created_at
    }
    orchestrator_events {
        TEXT id PK
        TEXT orchestrator_id FK
        TEXT type
        TEXT source_type
        TEXT source_id
        TEXT dedupe_key
        TEXT payload_json
        TEXT created_at
        TEXT assigned_turn_id FK
        TEXT consumed_at
    }
    orchestrator_operations {
        TEXT id PK
        TEXT orchestrator_id FK
        TEXT turn_id FK
        TEXT idempotency_key
        TEXT tool_name
        TEXT input_hash
        TEXT result_json
        TEXT created_at
    }
    orchestrator_resource_requests {
        TEXT id PK
        TEXT orchestrator_id FK
        TEXT created_by_turn_id FK
        TEXT purpose
        TEXT claim_expires_at
        TEXT claimed_todo_id FK
        TEXT created_at
    }
    orchestrator_child_jobs {
        TEXT id PK
        TEXT orchestrator_id FK
        TEXT todo_id FK,UK
        TEXT purpose
        TEXT created_by_turn_id FK
        TEXT resource_request_id FK
        TEXT created_at
    }
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
        TEXT default_review_mode
        TEXT default_review_policy_id FK
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
        TEXT process_identity
        TEXT review_baseline
        DATETIME created_at
        DATETIME updated_at
        TEXT review_mode
        TEXT review_policy_id FK
        TEXT quota_chain_id
        TEXT provider_account_id FK
        TEXT account_policy
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
        TEXT provider_account_id FK
        TEXT account_policy
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
        TEXT last_seen_refresh_id
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
        TEXT provider_account_id FK
        TEXT account_policy
    }
    cli_versions {
        TEXT cli_tool PK
        TEXT last_version
        DATETIME last_synced_at
        TEXT last_refresh_id
        TEXT last_source
        INTEGER last_authoritative
        INTEGER last_primary_succeeded
        TEXT last_refreshed_at
        INTEGER models_seen
    }
    execution_profile_rebind_audit {
        TEXT id PK
        TEXT profile_id FK
        TEXT executor_candidate_id FK
        TEXT provider
        TEXT old_model_id
        TEXT old_model_value
        TEXT old_model_label
        TEXT new_model_id
        TEXT new_model_value
        TEXT new_model_label
        TEXT old_effort
        TEXT new_effort
        TEXT source
        TEXT created_at
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
        TEXT provider_account_id FK
        TEXT account_policy
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
        TEXT process_identity
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
        TEXT provider_account_id FK
        TEXT account_policy
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
        TEXT process_identity
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
    compute_nodes {
        TEXT id PK
        TEXT name
        TEXT transport
        INTEGER enabled
        TEXT scheduler_state
        TEXT identity
        INTEGER identity_changed
        TEXT last_scan_at
        TEXT last_health_at
        TEXT last_error
    }
    compute_node_connections {
        TEXT node_id PK
        TEXT connection_json
    }
    inventory_snapshots {
        TEXT id PK
        TEXT node_id FK
        TEXT inventory_json
        TEXT diff_json
        TEXT created_at
    }
    resource_policies {
        TEXT node_id PK
        TEXT policy_json
    }
    resource_instances {
        TEXT id PK
        TEXT node_id FK
        TEXT kind
        TEXT legacy_key UK
        TEXT hardware_uuid
        INTEGER local_index
        TEXT model
        INTEGER vram_bytes
        TEXT origin
        INTEGER present
        TEXT policy
        TEXT desired_policy
        TEXT reserve_reason
    }
    resource_requests {
        TEXT id PK
        TEXT owner_type
        TEXT owner_id
        TEXT run_token UK
        TEXT requirements_json
        TEXT status
        INTEGER priority
        TEXT reasons_json
        TEXT created_at
    }
    resource_bindings {
        TEXT id PK
        TEXT request_id FK,UK
        TEXT node_id FK
        TEXT binding_json
        TEXT created_at
    }
    resource_binding_items {
        TEXT id PK
        TEXT binding_id FK
        TEXT resource_instance_id FK
        TEXT resource_key
        INTEGER amount
    }
    resource_observations {
        TEXT node_id PK
        TEXT observation_json
        TEXT observed_at
    }
    remote_executions {
        TEXT binding_id PK
        TEXT workspace
        INTEGER pid
        TEXT identity_json
        TEXT status
        INTEGER exit_code
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
        TEXT binding_id FK
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
        TEXT retry_of_round_id
        INTEGER attempt_index
        TEXT artifact_identity
        DATETIME started_at
        DATETIME finished_at
        DATETIME created_at
        DATETIME updated_at
        INTEGER duration_ms
        INTEGER input_tokens
        INTEGER output_tokens
        INTEGER cache_read_input_tokens
        INTEGER cache_creation_input_tokens
        REAL cost_usd
    }
    delegation_parent_executions {
        TEXT id PK
        TEXT owner_type
        TEXT owner_id FK
        TEXT work_dir
        TEXT execution_snapshot
        TEXT provider
        TEXT model
        TEXT effective_model
        TEXT policy_mode
        TEXT capability_hash UK
        TEXT status
        INTEGER process_pid
        TEXT process_identity
        DATETIME created_at
        DATETIME finished_at
    }
    delegation_tool_observations {
        TEXT id PK
        TEXT parent_execution_id FK
        TEXT parent_provider
        TEXT parent_model
        TEXT parent_effective_model
        TEXT tool_name
        TEXT operation_type
        TEXT source_path_relative
        INTEGER requested_offset
        INTEGER requested_limit
        INTEGER file_size
        TEXT command_kind
        INTEGER command_raw_length
        TEXT command_hash
        TEXT policy_mode
        TEXT decision
        TEXT decision_reason
        INTEGER hook_latency_ms
        TEXT managed_definition_hash
        DATETIME observed_at
        DATETIME created_at
    }
    delegation_hook_installations {
        TEXT provider PK
        TEXT definition_hash
        DATETIME installed_at
    }
    delegation_runs {
        TEXT id PK
        TEXT parent_execution_id FK
        TEXT parent_owner_type
        TEXT parent_owner_id
        TEXT operation
        TEXT status
        TEXT execution_profile_id FK
        TEXT execution_snapshot
        TEXT source_path_relative
        TEXT source_sha256
        INTEGER source_bytes
        INTEGER source_chars
        INTEGER source_lines
        TEXT query_hash
        INTEGER query_length
        DATETIME started_at
        DATETIME finished_at
        INTEGER latency_ms
        INTEGER process_pid
        TEXT process_identity
        INTEGER worker_input_tokens
        INTEGER worker_output_tokens
        INTEGER returned_chars
        INTEGER context_avoided_chars
        TEXT error_code
        TEXT error_detail_bounded
        INTEGER fallback_granted
    }
    delegation_fallback_grants {
        TEXT id PK
        TEXT parent_execution_id FK
        TEXT canonical_path_hash
        TEXT source_sha256
        INTEGER uses_remaining
        DATETIME expires_at
        DATETIME created_at
    }
    agent_forums {
        TEXT id PK
        TEXT project_id FK
        TEXT title
        TEXT rules
        INTEGER max_reply_length
        TEXT status
        INTEGER current_cycle
        TEXT current_member_id
        DATETIME created_at
        DATETIME updated_at
    }
    agent_forum_members {
        TEXT id PK
        TEXT forum_id FK
        TEXT name
        TEXT role
        TEXT system_prompt
        TEXT cli_tool
        TEXT cli_model
        TEXT cli_model_id FK
        TEXT execution_profile_id FK
        TEXT cli_effort
        TEXT avatar_color
        INTEGER sort_order
        INTEGER is_active
        DATETIME created_at
    }
    agent_forum_messages {
        TEXT id PK
        TEXT forum_id FK
        TEXT author_type
        TEXT author_id
        TEXT author_name
        TEXT author_role
        TEXT content
        TEXT parent_message_id FK
        TEXT turn_id
        DATETIME created_at
    }
    agent_forum_turns {
        TEXT id PK
        TEXT forum_id FK
        TEXT member_id FK
        INTEGER cycle_number
        INTEGER turn_order
        TEXT status
        TEXT execution_snapshot
        INTEGER process_pid
        TEXT process_identity
        TEXT raw_output
        TEXT error_message
        DATETIME started_at
        DATETIME completed_at
        DATETIME created_at
    }
    provider_accounts {
        TEXT id PK
        TEXT provider
        TEXT slug
        TEXT label
        TEXT description
        TEXT auth_strategy
        TEXT auth_config_json
        INTEGER is_enabled
        TEXT health_state
        TEXT health_reason
        TEXT last_health_at
        INTEGER max_concurrency
        INTEGER sort_order
        TEXT created_at
        TEXT updated_at
    }
    provider_account_quota_state {
        TEXT provider_account_id PK
        TEXT provider
        TEXT state
        TEXT source
        TEXT reason
        TEXT observed_at
        TEXT reset_at
        TEXT window_type
        REAL used_value
        REAL remaining_value
        TEXT unit
        TEXT confidence
        TEXT created_at
        TEXT updated_at
    }
    account_failover_events {
        TEXT id PK
        TEXT owner_type
        TEXT owner_id
        TEXT chain_id
        TEXT round_id
        TEXT from_account_id FK
        TEXT to_account_id FK
        TEXT provider
        TEXT reason
        TEXT classification
        TEXT reset_at
        INTEGER attempt_index_from
        INTEGER attempt_index_to
        TEXT created_at
    }
    review_policies {
        TEXT id PK
        TEXT name
        TEXT description
        TEXT strategy
        TEXT failure_policy
        INTEGER min_successful_reviewers
        TEXT judge_execution_profile_id FK
        TEXT diversity_policy
        INTEGER max_parallel_reviewers
        INTEGER is_enabled
        INTEGER sort_order
        TEXT created_at
        TEXT updated_at
    }
    review_policy_members {
        TEXT id PK
        TEXT review_policy_id FK
        TEXT execution_profile_id FK
        TEXT label
        INTEGER weight
        INTEGER priority
        INTEGER is_enabled
        INTEGER retired
        TEXT created_at
        TEXT updated_at
    }
    consensus_review_batches {
        TEXT id PK
        TEXT todo_id FK
        TEXT review_round_id FK,UK
        TEXT review_policy_id FK
        TEXT strategy
        TEXT failure_policy
        INTEGER min_successful_reviewers
        TEXT diversity_policy
        INTEGER max_parallel_reviewers
        TEXT judge_execution_profile_id FK
        TEXT status
        INTEGER stop_requested
        TEXT artifact_identity_json
        TEXT evidence_hash
        TEXT aggregate_result_json
        TEXT failure_reason
        TEXT judge_job_id
        TEXT created_at
        TEXT started_at
        TEXT finished_at
        TEXT updated_at
    }
    consensus_review_jobs {
        TEXT id PK
        TEXT batch_id FK
        TEXT role
        TEXT policy_member_id FK
        TEXT execution_profile_id FK
        TEXT label
        INTEGER weight
        INTEGER priority
        TEXT status
        TEXT final_result_payload
        TEXT final_error_message
        TEXT quota_chain_id
        TEXT created_at
        TEXT started_at
        TEXT finished_at
        TEXT updated_at
    }
    consensus_review_attempts {
        TEXT id PK
        TEXT review_job_id FK
        INTEGER attempt_index
        TEXT status
        TEXT run_token UK
        TEXT execution_snapshot
        TEXT input_payload
        TEXT result_payload
        TEXT error_message
        INTEGER process_pid
        TEXT process_identity
        TEXT quota_chain_id
        TEXT retry_of_attempt_id FK
        TEXT diversity_diagnostics_json
        INTEGER duration_ms
        INTEGER input_tokens
        INTEGER output_tokens
        REAL cost_usd
        INTEGER cache_read_input_tokens
        INTEGER cache_creation_input_tokens
        TEXT started_at
        TEXT finished_at
        TEXT created_at
        TEXT updated_at
    }
    review_evaluation_feedback {
        TEXT id PK
        TEXT project_id FK
        TEXT todo_id FK
        TEXT batch_id FK
        TEXT review_job_id FK
        TEXT scope
        TEXT issue_fingerprint
        TEXT issue_snapshot_json
        TEXT label
        TEXT note
        TEXT source
        TEXT created_at
        TEXT updated_at
    }
    review_human_actions {
        TEXT id PK
        TEXT todo_id FK
        TEXT review_round_id FK
        TEXT batch_id FK
        TEXT action
        TEXT previous_verdict
        TEXT created_at
    }
    evaluation_campaigns {
        TEXT id PK
        TEXT project_id FK
        TEXT name
        TEXT description
        TEXT status
        TEXT assignment_algorithm
        TEXT assignment_salt
        TEXT campaign_definition_hash
        INTEGER auto_enroll
        INTEGER max_assignments
        TEXT created_at
        TEXT started_at
        TEXT paused_at
        TEXT completed_at
        TEXT updated_at
    }
    evaluation_campaign_arms {
        TEXT id PK
        TEXT campaign_id FK
        TEXT name
        TEXT description
        INTEGER is_control
        INTEGER weight
        INTEGER sort_order
        INTEGER is_enabled
        TEXT review_mode
        TEXT review_profile_id FK
        TEXT review_policy_id FK
        TEXT rework_profile_id FK
        INTEGER max_review_rounds
        TEXT definition_hash
        TEXT created_at
        TEXT updated_at
    }
    evaluation_campaign_assignments {
        TEXT id PK
        TEXT campaign_id FK
        TEXT arm_id FK
        TEXT todo_id FK,UK
        TEXT assignment_source
        TEXT assignment_algorithm
        TEXT assignment_hash
        INTEGER assignment_bucket
        TEXT campaign_definition_hash
        TEXT arm_definition_hash
        TEXT arm_snapshot_json
        TEXT assigned_review_config_hash
        TEXT integrity_state
        TEXT integrity_reason
        TEXT assigned_at
        TEXT first_execution_at
        TEXT review_started_at
        TEXT finished_at
    }
    evaluation_campaign_assignment_feedback {
        TEXT id PK
        TEXT assignment_id FK,UK
        TEXT label
        TEXT note
        TEXT created_at
        TEXT updated_at
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
