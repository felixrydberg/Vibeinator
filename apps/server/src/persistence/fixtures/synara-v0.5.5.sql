-- Synthetic empty schema generated from v0.5.5; no user data.
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
      updated_at TEXT NOT NULL,
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id)
    );
CREATE TABLE automation_scheduler_leases (
      lease_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
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
CREATE TABLE orchestration_command_receipts (
      command_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT
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
CREATE TABLE projection_pending_approvals (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
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
    , default_model_selection_json TEXT, is_pinned INTEGER NOT NULL DEFAULT 0);
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
CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , attachments_json TEXT, source TEXT NOT NULL DEFAULT 'native', skills_json TEXT, mentions_json TEXT, dispatch_mode TEXT, dispatch_origin TEXT);
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
    , runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, handoff_json TEXT, env_mode TEXT NOT NULL DEFAULT 'local', fork_source_thread_id TEXT, associated_worktree_path TEXT, associated_worktree_branch TEXT, associated_worktree_ref TEXT, archived_at TEXT, parent_thread_id TEXT, subagent_agent_id TEXT, subagent_nickname TEXT, subagent_role TEXT, latest_user_message_at TEXT, pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0, last_known_pr_json TEXT, create_branch_flow_completed INTEGER NOT NULL DEFAULT 0, sidechat_source_thread_id TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, pinned_messages_json TEXT, notes TEXT, thread_markers_json TEXT);
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
CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    );
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
CREATE INDEX idx_orch_command_receipts_aggregate
    ON orchestration_command_receipts(aggregate_kind, aggregate_id)
  ;
CREATE INDEX idx_orch_command_receipts_sequence
    ON orchestration_command_receipts(result_sequence)
  ;
CREATE INDEX idx_orch_events_command_id
    ON orchestration_events(command_id)
  ;
CREATE INDEX idx_orch_events_correlation_id
    ON orchestration_events(correlation_id)
  ;
CREATE INDEX idx_orch_events_stream_sequence
    ON orchestration_events(aggregate_kind, stream_id, sequence)
  ;
CREATE UNIQUE INDEX idx_orch_events_stream_version
    ON orchestration_events(aggregate_kind, stream_id, stream_version)
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
CREATE INDEX idx_projection_pending_approvals_thread_status
    ON projection_pending_approvals(thread_id, status)
  ;
CREATE INDEX idx_projection_projects_updated_at
    ON projection_projects(updated_at)
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
CREATE INDEX idx_projection_thread_proposed_plans_thread_created
    ON projection_thread_proposed_plans(thread_id, created_at)
  ;
CREATE INDEX idx_projection_thread_sessions_provider_session
    ON projection_thread_sessions(provider_session_id)
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
CREATE INDEX idx_provider_session_runtime_provider
    ON provider_session_runtime(provider_name)
  ;
CREATE INDEX idx_provider_session_runtime_status
    ON provider_session_runtime(status)
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
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (54, 'ProjectPullRequestPins', '2026-11-03T00:00:00.000Z');
