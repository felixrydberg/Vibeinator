-- Synthetic empty schema generated from v0.6.7; no user data.
CREATE TABLE agent_gateway_operations (
      operation_id TEXT PRIMARY KEY,
      caller_thread_id TEXT NOT NULL,
      caller_turn_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create_threads')),
      request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
      fingerprint TEXT NOT NULL,
      requested_count INTEGER NOT NULL CHECK (requested_count BETWEEN 1 AND 20),
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('reserved', 'dispatching', 'completed', 'failed', 'compensating')
      ),
      result_json TEXT,
      error_json TEXT,
      caller_purged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (caller_thread_id, caller_turn_id, operation_kind)
    );
CREATE TABLE auth_pairing_links (
      id TEXT PRIMARY KEY,
      credential TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      role TEXT NOT NULL,
      subject TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );
CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      method TEXT NOT NULL,
      client_label TEXT,
      client_ip_address TEXT,
      client_user_agent TEXT,
      client_device_type TEXT NOT NULL DEFAULT 'unknown',
      client_os TEXT,
      client_browser TEXT,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_connected_at TEXT,
      revoked_at TEXT
    );
CREATE TABLE automation_definitions (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_thread_id TEXT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at TEXT,
      model_selection_json TEXT NOT NULL,
      provider_options_json TEXT,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      worktree_mode TEXT NOT NULL,
      mode TEXT NOT NULL,
      target_thread_id TEXT,
      max_iterations INTEGER,
      stop_on_error INTEGER NOT NULL,
      completion_policy_json TEXT NOT NULL DEFAULT '{"type":"none"}',
      completion_policy_version INTEGER NOT NULL DEFAULT 0,
      completion_policy_updated_at TEXT,
      minimum_interval_seconds INTEGER NOT NULL,
      max_runtime_seconds INTEGER,
      retry_policy_json TEXT NOT NULL,
      misfire_policy TEXT NOT NULL,
      acknowledged_risks_json TEXT NOT NULL,
      iteration_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    , proposal_state TEXT
      CHECK (proposal_state IS NULL OR proposal_state IN ('pending', 'accepted', 'dismissed')), heartbeat_cooldown_seconds INTEGER NOT NULL DEFAULT 60, notification_policy TEXT
      CHECK (
        notification_policy IS NULL
        OR notification_policy IN ('all', 'failed-runs-only')
      ));
CREATE TABLE automation_memory (
      automation_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id)
    );
CREATE TABLE automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      thread_create_command_id TEXT,
      turn_start_command_id TEXT,
      message_id TEXT,
      error TEXT,
      result_json TEXT,
      permission_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deferred_until TEXT,
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id)
    );
CREATE TABLE automation_scheduler_leases (
      lease_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
    );
CREATE TABLE automation_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE checkpoint_diff_blobs (
      thread_id TEXT NOT NULL,
      from_turn_count INTEGER NOT NULL,
      to_turn_count INTEGER NOT NULL,
      diff TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, from_turn_count, to_turn_count)
    );
CREATE TABLE "effect_sql_migrations" (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
);
CREATE TABLE external_mcp_audit_log (
      audit_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id),
      tool TEXT NOT NULL,
      request_id TEXT,
      project_id TEXT,
      runtime_mode TEXT,
      environment TEXT,
      outcome TEXT NOT NULL,
      created_task_ids_json TEXT NOT NULL DEFAULT '[]',
      detail TEXT,
      created_at TEXT NOT NULL
    );
CREATE TABLE external_mcp_integration_projects (
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id)
        ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      PRIMARY KEY (integration_id, project_id)
    );
CREATE TABLE external_mcp_integrations (
      integration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      audience TEXT NOT NULL CHECK (audience = 'synara.external-mcp'),
      client_kind TEXT NOT NULL CHECK (
        client_kind IN ('codex', 'claudeCode', 'claudeDesktop', 'other')
      ),
      credential_hash TEXT UNIQUE,
      capabilities_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      paired_at TEXT,
      revoked_at TEXT,
      rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
      concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 100)
    , project_scope TEXT NOT NULL DEFAULT 'selected'
      CHECK (project_scope IN ('all', 'selected')));
CREATE TABLE external_mcp_operations (
      operation_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id),
      request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
      fingerprint TEXT NOT NULL,
      requested_count INTEGER NOT NULL CHECK (requested_count = 1),
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('reserved', 'dispatching', 'completed', 'failed', 'compensating')
      ),
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (integration_id, request_id)
    );
CREATE TABLE external_mcp_pairing_codes (
      pairing_hash TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL UNIQUE REFERENCES external_mcp_integrations(integration_id)
        ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
CREATE TABLE external_mcp_rate_windows (
      integration_id TEXT PRIMARY KEY REFERENCES external_mcp_integrations(integration_id)
        ON DELETE CASCADE,
      window_id INTEGER NOT NULL,
      admitted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      rejection_audit_id TEXT,
      updated_at TEXT NOT NULL
    );
CREATE TABLE external_mcp_tasks (
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id),
      operation_id TEXT NOT NULL UNIQUE REFERENCES external_mcp_operations(operation_id),
      request_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned', 'created', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (integration_id, thread_id)
    );
CREATE TABLE git_handoff_operations (
      command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('pending', 'git_applied', 'completed', 'uncertain')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE managed_attachment_blobs (
      attachment_id TEXT PRIMARY KEY,
      owner_thread_id TEXT NOT NULL CHECK (length(owner_thread_id) > 0),
      owner_kind TEXT NOT NULL CHECK (length(owner_kind) > 0),
      owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
      original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 100),
      reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
      size_bytes INTEGER CHECK (
        size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= reserved_bytes)
      ),
      sha256 TEXT CHECK (
        sha256 IS NULL OR (
          length(sha256) = 64 AND
          sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      relative_path TEXT NOT NULL UNIQUE CHECK (
        length(relative_path) > 0 AND
        relative_path NOT LIKE '/%' AND
        relative_path NOT LIKE '../%' AND
        relative_path NOT LIKE '%/../%' AND
        instr(relative_path, char(0)) = 0
      ),
      state TEXT NOT NULL CHECK (
        state IN ('uploading', 'staged', 'claimed', 'deleting', 'deleted')
      ),
      staging_expires_at TEXT,
      claim_command_id TEXT,
      claim_message_id TEXT,
      claimed_at TEXT,
      delete_reason TEXT,
      delete_requested_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'uploading' AND size_bytes IS NULL AND sha256 IS NULL AND
          claim_command_id IS NULL AND claim_message_id IS NULL AND claimed_at IS NULL AND
          delete_reason IS NULL AND delete_requested_at IS NULL AND deleted_at IS NULL) OR
        (state = 'staged' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND
          staging_expires_at IS NOT NULL AND claim_command_id IS NULL AND
          claim_message_id IS NULL AND claimed_at IS NULL AND
          delete_reason IS NULL AND delete_requested_at IS NULL AND deleted_at IS NULL) OR
        (state = 'claimed' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND
          claim_command_id IS NOT NULL AND claim_message_id IS NOT NULL AND
          claimed_at IS NOT NULL AND delete_reason IS NULL AND
          delete_requested_at IS NULL AND deleted_at IS NULL) OR
        (state = 'deleting' AND delete_reason IS NOT NULL AND
          delete_requested_at IS NOT NULL AND deleted_at IS NULL) OR
        (state = 'deleted' AND delete_reason IS NOT NULL AND
          delete_requested_at IS NOT NULL AND deleted_at IS NOT NULL)
      )
    );
CREATE TABLE managed_attachment_cleanup_jobs (
      attachment_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL CHECK (length(reason) > 0),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (attachment_id)
        REFERENCES managed_attachment_blobs(attachment_id)
        ON DELETE CASCADE,
      CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND length(lease_owner) > 0 AND lease_expires_at IS NOT NULL)
      )
    );
CREATE TABLE operational_diagnostics (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('server', 'browser')),
      diagnostic_kind TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      code TEXT,
      detail_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
CREATE TABLE orchestration_command_receipts (
      command_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    , fingerprint_version INTEGER
      CHECK (fingerprint_version IS NULL OR fingerprint_version > 0), command_fingerprint TEXT
      CHECK (
        command_fingerprint IS NULL OR (
          length(command_fingerprint) = 64 AND
          command_fingerprint NOT GLOB '*[^0-9a-f]*'
        )
      ));
CREATE TABLE orchestration_consumer_state (
      consumer_name TEXT PRIMARY KEY,
      last_acked_sequence INTEGER NOT NULL CHECK (last_acked_sequence >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE orchestration_event_deliveries (
      consumer_name TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('inflight', 'retry', 'succeeded', 'dead', 'uncertain')
      ),
      claim_owner TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (consumer_name, event_sequence),
      FOREIGN KEY (consumer_name)
        REFERENCES orchestration_consumer_state(consumer_name)
        ON DELETE CASCADE
    );
CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
CREATE TABLE profile_stats_deleted_prompts (
      thread_id TEXT NOT NULL,
      project_id TEXT,
      created_at TEXT NOT NULL
    );
CREATE TABLE profile_stats_deleted_skills (
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      run_count INTEGER NOT NULL
    );
CREATE TABLE profile_stats_deleted_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      deleted_at TEXT NOT NULL
    );
CREATE TABLE profile_stats_deleted_tokens (
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provider TEXT,
      tokens INTEGER NOT NULL
    , model TEXT);
CREATE TABLE profile_stats_deleted_turns (
      thread_id TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      reasoning TEXT,
      turn_count INTEGER NOT NULL
    );
CREATE TABLE project_pull_request_pins (
      project_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      PRIMARY KEY (project_id, repository_key, pull_request_number)
    );
CREATE TABLE "projection_pending_interactions" (
      interaction_kind TEXT NOT NULL,
      request_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      lifecycle_generation TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      response_command_id TEXT,
      response_requested_at TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (thread_id, interaction_kind, request_id)
    );
CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'project',
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , default_model_selection_json TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, space_id TEXT);
CREATE TABLE projection_spaces (
      space_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
CREATE TABLE projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    , sequence INTEGER);
CREATE TABLE "projection_thread_messages" (
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attachments_json TEXT,
      source TEXT NOT NULL DEFAULT 'native',
      skills_json TEXT,
      mentions_json TEXT,
      dispatch_mode TEXT,
      dispatch_origin TEXT, sequence INTEGER,
      PRIMARY KEY (thread_id, message_id)
    );
CREATE TABLE projection_thread_proposed_plans (
      plan_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , implemented_at TEXT, implementation_thread_id TEXT);
CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      active_turn_id TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    , runtime_mode TEXT NOT NULL DEFAULT 'full-access');
CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, handoff_json TEXT, env_mode TEXT NOT NULL DEFAULT 'local', fork_source_thread_id TEXT, associated_worktree_path TEXT, associated_worktree_branch TEXT, associated_worktree_ref TEXT, archived_at TEXT, parent_thread_id TEXT, subagent_agent_id TEXT, subagent_nickname TEXT, subagent_role TEXT, latest_user_message_at TEXT, pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0, last_known_pr_json TEXT, create_branch_flow_completed INTEGER NOT NULL DEFAULT 0, sidechat_source_thread_id TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, pinned_messages_json TEXT, notes TEXT, thread_markers_json TEXT, creation_source TEXT, source_thread_id TEXT, source_turn_id TEXT, gateway_operation_id TEXT, gateway_operation_index INTEGER, working_directory TEXT, settled_at TEXT);
CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      pending_message_id TEXT,
      assistant_message_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL, source_proposed_plan_thread_id TEXT, source_proposed_plan_id TEXT,
      UNIQUE (thread_id, turn_id),
      UNIQUE (thread_id, checkpoint_turn_count)
    );
CREATE TABLE provider_delivery_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      consumer_name TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      previous_state TEXT NOT NULL CHECK (previous_state IN ('dead', 'uncertain')),
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'safe_retry', 'abandon')),
      reconciled_by TEXT NOT NULL,
      note TEXT,
      reconciled_at TEXT NOT NULL,
      FOREIGN KEY (consumer_name, event_sequence)
        REFERENCES orchestration_event_deliveries(consumer_name, event_sequence)
        ON DELETE CASCADE
    );
CREATE TABLE provider_runtime_event_consumers (
      consumer_name TEXT PRIMARY KEY,
      last_acked_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (last_acked_sequence >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE provider_runtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      lifecycle_generation TEXT,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL
        CHECK (length(CAST(event_json AS BLOB)) <= 2097152),
      persisted_at TEXT NOT NULL
    );
CREATE TABLE provider_runtime_open_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    );
CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    , lifecycle_generation TEXT NOT NULL DEFAULT 'legacy');
CREATE TABLE queued_turn_promotions (
      queued_event_sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      dispatch_mode TEXT NOT NULL CHECK (dispatch_mode IN ('queue', 'steer')),
      state TEXT NOT NULL CHECK (state IN ('queued', 'promoting', 'promoted', 'cancelled')),
      claim_owner TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      promoted_at TEXT,
      FOREIGN KEY (queued_event_sequence) REFERENCES orchestration_events(sequence) ON DELETE RESTRICT
    );
CREATE INDEX idx_agent_gateway_operations_status
    ON agent_gateway_operations (status, updated_at)
  ;
CREATE INDEX idx_auth_pairing_links_active
    ON auth_pairing_links(revoked_at, consumed_at, expires_at)
  ;
CREATE INDEX idx_auth_sessions_active
    ON auth_sessions(revoked_at, expires_at, issued_at)
  ;
CREATE INDEX idx_automation_definitions_due
    ON automation_definitions (enabled, archived_at, next_run_at, automation_id)
  ;
CREATE INDEX idx_automation_runs_completion_eval
    ON automation_runs (finished_at, run_id)
    WHERE status = 'succeeded' AND finished_at IS NOT NULL
  ;
CREATE INDEX idx_automation_runs_history
    ON automation_runs (automation_id, scheduled_for DESC, run_id DESC)
  ;
CREATE INDEX idx_automation_runs_project
    ON automation_runs (project_id, scheduled_for DESC, run_id DESC)
  ;
CREATE INDEX idx_automation_runs_recovery
    ON automation_runs (status, lease_expires_at)
  ;
CREATE INDEX idx_automation_runs_thread
    ON automation_runs (thread_id, created_at DESC)
  ;
CREATE UNIQUE INDEX idx_automation_runs_unique_occurrence
    ON automation_runs (automation_id, scheduled_for)
    WHERE trigger_type = 'scheduled'
  ;
CREATE INDEX idx_checkpoint_diff_blobs_thread_to_turn
    ON checkpoint_diff_blobs(thread_id, to_turn_count)
  ;
CREATE INDEX idx_external_mcp_audit_rate
    ON external_mcp_audit_log (integration_id, created_at)
  ;
CREATE INDEX idx_external_mcp_operations_status
    ON external_mcp_operations (status, updated_at)
  ;
CREATE INDEX idx_external_mcp_tasks_project
    ON external_mcp_tasks (integration_id, project_id, status, updated_at)
  ;
CREATE INDEX idx_git_handoff_operations_recovery
    ON git_handoff_operations(phase, updated_at, command_id)
  ;
CREATE INDEX idx_managed_attachment_blobs_claim
    ON managed_attachment_blobs(claim_command_id, claim_message_id, attachment_id)
  ;
CREATE INDEX idx_managed_attachment_blobs_owner_principal
    ON managed_attachment_blobs(owner_kind, owner_id, state, attachment_id)
  ;
CREATE INDEX idx_managed_attachment_blobs_owner_thread
    ON managed_attachment_blobs(owner_thread_id, state, attachment_id)
  ;
CREATE INDEX idx_managed_attachment_blobs_state_expiry
    ON managed_attachment_blobs(state, staging_expires_at, attachment_id)
  ;
CREATE INDEX idx_managed_attachment_blobs_state_reserved
    ON managed_attachment_blobs(state, reserved_bytes)
  ;
CREATE INDEX idx_managed_attachment_cleanup_jobs_due
    ON managed_attachment_cleanup_jobs(next_attempt_at, lease_expires_at, attachment_id)
  ;
CREATE INDEX idx_operational_diagnostics_occurred_at
    ON operational_diagnostics(occurred_at)
  ;
CREATE INDEX idx_operational_diagnostics_thread_sequence
    ON operational_diagnostics(thread_id, sequence DESC)
  ;
CREATE INDEX idx_orch_command_receipts_aggregate
    ON orchestration_command_receipts(aggregate_kind, aggregate_id)
  ;
CREATE INDEX idx_orch_command_receipts_sequence
    ON orchestration_command_receipts(result_sequence)
  ;
CREATE INDEX idx_orch_events_stream_sequence
    ON orchestration_events(aggregate_kind, stream_id, sequence)
  ;
CREATE UNIQUE INDEX idx_orch_events_stream_version
    ON orchestration_events(aggregate_kind, stream_id, stream_version)
  ;
CREATE INDEX idx_orchestration_event_deliveries_state_sequence
    ON orchestration_event_deliveries(consumer_name, state, event_sequence)
  ;
CREATE INDEX idx_orchestration_event_deliveries_thread_state
    ON orchestration_event_deliveries(consumer_name, thread_id, state, event_sequence)
  ;
CREATE INDEX idx_orchestration_events_profile_turn_events
    ON orchestration_events(event_type, stream_id)
  ;
CREATE INDEX idx_profile_stats_deleted_prompts_thread
    ON profile_stats_deleted_prompts(thread_id)
  ;
CREATE INDEX idx_profile_stats_deleted_skills_thread
    ON profile_stats_deleted_skills(thread_id)
  ;
CREATE INDEX idx_profile_stats_deleted_tokens_thread
    ON profile_stats_deleted_tokens(thread_id)
  ;
CREATE INDEX idx_profile_stats_deleted_turns_thread
    ON profile_stats_deleted_turns(thread_id)
  ;
CREATE INDEX idx_projection_pending_interactions_request_id
    ON projection_pending_interactions(request_id)
  ;
CREATE INDEX idx_projection_pending_interactions_thread_kind_status
    ON projection_pending_interactions(thread_id, interaction_kind, status)
  ;
CREATE INDEX idx_projection_projects_space_id
    ON projection_projects(space_id)
  ;
CREATE INDEX idx_projection_projects_updated_at
    ON projection_projects(updated_at)
  ;
CREATE INDEX idx_projection_spaces_active_order
    ON projection_spaces(deleted_at, sort_order, space_id)
  ;
CREATE INDEX idx_projection_thread_activities_profile_token_activity
    ON projection_thread_activities(kind, thread_id, sequence, created_at, activity_id)
  ;
CREATE INDEX idx_projection_thread_activities_thread_created
    ON projection_thread_activities(thread_id, created_at)
  ;
CREATE INDEX idx_projection_thread_activities_thread_rank_desc
    ON projection_thread_activities(
      thread_id,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END) DESC,
      sequence DESC,
      created_at DESC,
      activity_id DESC
    )
  ;
CREATE INDEX idx_projection_thread_activities_thread_sequence
    ON projection_thread_activities(thread_id, sequence)
  ;
CREATE INDEX idx_projection_thread_messages_message_id
    ON projection_thread_messages(message_id)
  ;
CREATE INDEX idx_projection_thread_messages_profile_prompt_activity
    ON projection_thread_messages(role, source, created_at)
  ;
CREATE INDEX idx_projection_thread_messages_thread_created
    ON projection_thread_messages(thread_id, created_at)
  ;
CREATE INDEX idx_projection_thread_messages_thread_created_desc
    ON projection_thread_messages(thread_id, created_at DESC, message_id DESC)
  ;
CREATE INDEX idx_projection_thread_messages_thread_role_created_desc
    ON projection_thread_messages(thread_id, role, created_at DESC, message_id DESC)
  ;
CREATE INDEX idx_projection_thread_messages_thread_sequence
    ON projection_thread_messages(thread_id, sequence, message_id)
  ;
CREATE INDEX idx_projection_thread_proposed_plans_thread_created
    ON projection_thread_proposed_plans(thread_id, created_at)
  ;
CREATE INDEX idx_projection_thread_sessions_provider_session
    ON projection_thread_sessions(provider_session_id)
  ;
CREATE INDEX idx_projection_threads_gateway_operation
    ON projection_threads (gateway_operation_id, gateway_operation_index)
  ;
CREATE INDEX idx_projection_threads_parent_thread_id
    ON projection_threads(parent_thread_id)
  ;
CREATE INDEX idx_projection_threads_project_id
    ON projection_threads(project_id)
  ;
CREATE INDEX idx_projection_turns_thread_checkpoint_completed
    ON projection_turns(thread_id, checkpoint_turn_count, completed_at)
  ;
CREATE INDEX idx_projection_turns_thread_requested
    ON projection_turns(thread_id, requested_at)
  ;
CREATE INDEX idx_provider_delivery_reconciliations_delivery
    ON provider_delivery_reconciliations(consumer_name, event_sequence, reconciled_at DESC)
  ;
CREATE INDEX idx_provider_runtime_events_thread_sequence
    ON provider_runtime_events(thread_id, sequence)
  ;
CREATE INDEX idx_provider_runtime_events_turn_sequence
    ON provider_runtime_events(thread_id, turn_id, sequence)
  ;
CREATE INDEX idx_provider_session_runtime_provider
    ON provider_session_runtime(provider_name)
  ;
CREATE INDEX idx_provider_session_runtime_status
    ON provider_session_runtime(status)
  ;
CREATE UNIQUE INDEX idx_queued_turn_promotions_active_message
    ON queued_turn_promotions(thread_id, message_id)
    WHERE state IN ('queued', 'promoting')
  ;
CREATE INDEX idx_queued_turn_promotions_state_expiry
    ON queued_turn_promotions(state, claim_expires_at)
  ;
CREATE INDEX idx_queued_turn_promotions_thread_state_order
    ON queued_turn_promotions(thread_id, state, dispatch_mode, queued_event_sequence)
  ;
CREATE VIEW automation_pending_completion_evaluations AS
    SELECT
      runs.run_id,
      runs.automation_id,
      runs.thread_id,
      runs.finished_at
    FROM automation_runs runs
    INNER JOIN automation_definitions definitions
      ON definitions.automation_id = runs.automation_id
    WHERE runs.status = 'succeeded'
      AND definitions.enabled = 1
      AND definitions.archived_at IS NULL
      AND definitions.mode = 'heartbeat'
      AND json_extract(definitions.completion_policy_json, '$.type') = 'ai-evaluated'
      AND runs.finished_at IS NOT NULL
      AND (
        json_extract(runs.permission_snapshot_json, '$.completionPolicyVersion') =
          definitions.completion_policy_version
        OR (
          json_type(runs.permission_snapshot_json, '$.completionPolicyVersion') IS NULL
          AND COALESCE(runs.started_at, runs.created_at) >
            COALESCE(
              definitions.completion_policy_updated_at,
              definitions.updated_at,
              definitions.created_at,
              '1970-01-01T00:00:00.000Z'
            )
        )
      )
      AND (
        runs.result_json IS NULL
        OR json_type(runs.result_json, '$.completionEvaluation') IS NULL
      );
CREATE VIEW external_mcp_active_capacity_claims AS
    SELECT operations.integration_id, operations.operation_id
    FROM external_mcp_operations AS operations
    WHERE operations.status IN ('reserved', 'dispatching', 'compensating')

    UNION

    SELECT tasks.integration_id, tasks.operation_id
    FROM external_mcp_tasks AS tasks
    INNER JOIN external_mcp_operations AS operations
      ON operations.operation_id = tasks.operation_id
    WHERE tasks.status IN ('planned', 'created', 'failed')
      AND COALESCE((
        SELECT CASE
          WHEN turns.state IN ('pending', 'running') THEN turns.state
          WHEN sessions.status = 'error' THEN 'error'
          WHEN sessions.status IN ('interrupted', 'stopped') THEN 'interrupted'
          ELSE COALESCE(
            turns.state,
            CASE
              WHEN tasks.status = 'failed' AND operations.status <> 'compensating'
                THEN 'completed'
              ELSE 'pending'
            END
          )
        END
        FROM projection_threads AS threads
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        LEFT JOIN projection_turns AS turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = tasks.thread_id
        LIMIT 1
      ), CASE
        WHEN tasks.status = 'failed' AND operations.status <> 'compensating' THEN 'completed'
        ELSE 'pending'
      END) IN ('pending', 'running');
CREATE TRIGGER orchestration_command_receipts_fingerprint_insert_guard
    BEFORE INSERT ON orchestration_command_receipts
    WHEN (NEW.fingerprint_version IS NULL) <> (NEW.command_fingerprint IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'command receipt fingerprint fields must both be null or both be set');
    END;
CREATE TRIGGER orchestration_command_receipts_fingerprint_update_guard
    BEFORE UPDATE OF fingerprint_version, command_fingerprint
    ON orchestration_command_receipts
    WHEN (NEW.fingerprint_version IS NULL) <> (NEW.command_fingerprint IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'command receipt fingerprint fields must both be null or both be set');
    END;
CREATE TRIGGER trg_managed_attachment_blobs_immutable_content
    BEFORE UPDATE OF size_bytes, sha256
    ON managed_attachment_blobs
    WHEN
      (OLD.size_bytes IS NOT NULL AND NEW.size_bytes IS NOT OLD.size_bytes) OR
      (OLD.sha256 IS NOT NULL AND NEW.sha256 IS NOT OLD.sha256) OR
      ((OLD.size_bytes IS NULL OR OLD.sha256 IS NULL) AND NEW.state <> 'staged')
    BEGIN
      SELECT RAISE(ABORT, 'managed attachment content identity is immutable');
    END;
CREATE TRIGGER trg_managed_attachment_blobs_immutable_metadata
    BEFORE UPDATE OF
      owner_thread_id,
      owner_kind,
      owner_id,
      kind,
      original_name,
      mime_type,
      reserved_bytes,
      relative_path
    ON managed_attachment_blobs
    BEGIN
      SELECT RAISE(ABORT, 'managed attachment metadata is immutable');
    END;
CREATE TRIGGER trg_managed_attachment_blobs_state_transition
    BEFORE UPDATE OF state
    ON managed_attachment_blobs
    WHEN NOT (
      NEW.state = OLD.state OR
      (OLD.state = 'uploading' AND NEW.state IN ('staged', 'deleting')) OR
      (OLD.state = 'staged' AND NEW.state IN ('claimed', 'deleting')) OR
      (OLD.state = 'claimed' AND NEW.state = 'deleting') OR
      (OLD.state = 'deleting' AND NEW.state = 'deleted')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid managed attachment state transition');
    END;
CREATE TRIGGER trg_project_pull_request_pins_limit
    BEFORE INSERT ON project_pull_request_pins
    WHEN
      NOT EXISTS (
        SELECT 1
        FROM project_pull_request_pins
        WHERE project_id = NEW.project_id
          AND repository_key = NEW.repository_key
          AND pull_request_number = NEW.pull_request_number
      )
      AND (
        SELECT COUNT(*)
        FROM project_pull_request_pins
        WHERE project_id = NEW.project_id
      ) >= 20
    BEGIN
      SELECT RAISE(ABORT, 'project pull request pin limit exceeded');
    END;
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (1, 'OrchestrationEvents', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (2, 'OrchestrationCommandReceipts', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (3, 'CheckpointDiffBlobs', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (4, 'ProviderSessionRuntime', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (5, 'Projections', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (6, 'ProjectionThreadSessionRuntimeModeColumns', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (7, 'ProjectionThreadMessageAttachments', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (8, 'ProjectionThreadActivitySequence', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (9, 'ProviderSessionRuntimeMode', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (10, 'ProjectionThreadsRuntimeMode', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (11, 'OrchestrationThreadCreatedRuntimeMode', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (12, 'ProjectionThreadsInteractionMode', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (13, 'ProjectionThreadProposedPlans', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (14, 'ProjectionThreadProposedPlanImplementation', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (15, 'ProjectionTurnsSourceProposedPlan', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (16, 'CanonicalizeModelSelections', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (17, 'ThreadHandoffMetadata', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (18, 'ProjectionThreadMessageMentions', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (19, 'ProjectionThreadsEnvMode', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (20, 'ProjectionThreadsForkSource', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (21, 'ProjectionThreadsAssociatedWorktree', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (22, 'ProjectionThreadsAssociatedWorktreeBranch', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (23, 'ProjectionThreadsAssociatedWorktreeRef', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (24, 'ProjectionThreadsArchivedAt', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (25, 'ProjectionThreadsSubagents', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (26, 'ProjectionThreadShellSummary', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (27, 'BackfillProjectionThreadShellSummary', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (28, 'ProjectionProjectsKind', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (29, 'ProjectionThreadsLastKnownPr', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (30, 'ProjectionThreadMessagesDispatchMode', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (31, 'ProjectionThreadsCreateBranchFlowCompleted', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (32, 'ReconcileImportedSchemaLineage', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (33, 'ProjectionThreadsSidechatSource', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (34, 'AuthAccessManagement', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (35, 'NormalizeLegacyModelSelectionOptions', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (36, 'ProjectionThreadsPinned', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (37, 'ProjectionSnapshotCapIndexes', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (38, 'ReconcileLegacySidechatSource', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (39, 'ReconcileLegacyPinnedThreads', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (40, 'ProjectionThreadsPinnedMessagesNotes', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (41, 'ProjectionProjectsPinned', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (42, 'ProjectionThreadsMarkers', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (43, 'ProfileStatsIndexes', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (44, 'Automations', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (45, 'AutomationPolicies', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (46, 'AutomationCompletionPolicy', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (47, 'AutomationCompletionPolicyVersion', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (48, 'AutomationCompletionEvaluationBacklog', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (49, 'ProjectionThreadMessagesDispatchOrigin', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (50, 'ProfileStatsArchive', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (51, 'ProfileStatsDeletedTokensModel', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (52, 'ProjectionThreadUserMessageSummaryIndex', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (53, 'BackfillThreadActivitySequence', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (54, 'DurableProviderCommandDelivery', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (55, 'ManagedAttachments', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (56, 'CommandReceiptFingerprints', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (57, 'ThreadScopedProjectionMessageIdentity', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (58, 'ThreadScopedPendingApprovalIdentity', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (59, 'ProviderSessionLifecycleGeneration', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (60, 'PendingApprovalLifecycleGeneration', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (61, 'PendingApprovalSettlementState', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (62, 'PendingInteractionSettlementParity', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (63, 'ProjectionMessageCausalSequence', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (64, 'DurableProviderCommandDeliveryCutover', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (65, 'DurableQueuedTurnPromotions', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (66, 'DurableProviderRuntimeEvents', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (67, 'ProviderDeliveryReconciliation', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (68, 'GitHandoffOperations', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (69, 'ProjectPullRequestPins', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (70, 'AgentGatewayOperations', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (71, 'ProjectionThreadsGatewayProvenance', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (72, 'AgentGatewayOperationRetention', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (73, 'OperationalDiagnostics', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (74, 'ExternalMcpIntegrations', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (75, 'ExternalMcpActiveCapacity', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (76, 'ExternalMcpHardening', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (77, 'ExternalMcpCompensatingCapacity', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (78, 'ExternalMcpLiveTurnCapacity', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (79, 'Spaces', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (80, 'ExternalMcpProjectScope', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (81, 'AutomationProposals', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (82, 'AutomationMemory', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (83, 'AutomationHeartbeatEligibility', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (84, 'AutomationNotificationPolicy', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (85, 'AutomationSettings', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (86, 'NormalizeStudioThreadWorkspaces', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (87, 'DropUnusedOrchestrationEventIndexes', '2026-11-03T00:00:00.000Z');
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (88, 'ProjectionThreadsSettledAt', '2026-11-03T00:00:00.000Z');
