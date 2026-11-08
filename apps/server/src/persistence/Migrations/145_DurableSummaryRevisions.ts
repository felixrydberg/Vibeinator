import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS summary_scopes (
    scope_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT,
    workspace_root TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
    head_revision_id TEXT, last_invalidation_sequence INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_summary_scope_project ON summary_scopes(project_id, thread_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS summary_revisions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, revision_id TEXT NOT NULL UNIQUE,
    scope_key TEXT NOT NULL REFERENCES summary_scopes(scope_key), epoch INTEGER NOT NULL,
    revision INTEGER NOT NULL, record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    UNIQUE(scope_key, epoch, revision)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS summary_candidates (
    candidate_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES summary_scopes(scope_key),
    epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'consumed', 'discarded')),
    input_fingerprint TEXT NOT NULL, record_json TEXT NOT NULL CHECK (json_valid(record_json))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_summary_candidates_pending ON summary_candidates(scope_key, epoch, state, candidate_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS summary_source_refs (
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('revision', 'candidate')), owner_id TEXT NOT NULL,
    source_key TEXT NOT NULL, source_thread_id TEXT,
    capture_id TEXT REFERENCES native_captures(capture_id) ON DELETE RESTRICT,
    event_id TEXT REFERENCES orchestration_events(event_id) ON DELETE RESTRICT,
    PRIMARY KEY(owner_kind, owner_id, source_key),
    CHECK ((capture_id IS NULL) <> (event_id IS NULL))
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_summary_source_thread ON summary_source_refs(source_thread_id)`;
  // Invalidate on durable acceptance, not projection replay. Epochs fence already-running writers.
  yield* sql`CREATE TRIGGER IF NOT EXISTS summary_thread_invalidation AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread' AND NEW.event_type IN ('thread.reverted', 'thread.conversation-rolled-back', 'thread.deleted')
    BEGIN
      UPDATE summary_scopes SET epoch = epoch + 1, head_revision_id = NULL, last_invalidation_sequence = NEW.sequence
      WHERE last_invalidation_sequence < NEW.sequence AND (
        thread_id = NEW.stream_id OR (thread_id IS NULL AND project_id =
          (SELECT project_id FROM projection_threads WHERE thread_id = NEW.stream_id)));
    END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS summary_project_invalidation AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'project' AND (NEW.event_type = 'project.deleted'
      OR (NEW.event_type = 'project.meta-updated' AND json_type(NEW.payload_json, '$.workspaceRoot') = 'text'))
    BEGIN
      UPDATE summary_scopes SET epoch = epoch + 1, head_revision_id = NULL, last_invalidation_sequence = NEW.sequence,
        workspace_root = COALESCE(json_extract(NEW.payload_json, '$.workspaceRoot'), workspace_root)
      WHERE project_id = NEW.stream_id AND last_invalidation_sequence < NEW.sequence
        AND (NEW.event_type = 'project.deleted' OR workspace_root <> json_extract(NEW.payload_json, '$.workspaceRoot'));
    END`;
});
