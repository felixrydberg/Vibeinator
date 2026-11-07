import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Archive ownership never depends on rebuildable projections or prunable runtime rows.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS durable_payloads (
    payload_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    payload_key TEXT NOT NULL,
    encoding TEXT NOT NULL CHECK (encoding IN ('utf8-text', 'utf8-json')),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    UNIQUE (project_id, thread_id, payload_key),
    UNIQUE (project_id, thread_id, payload_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS durable_payload_chunks (
    payload_id TEXT NOT NULL REFERENCES durable_payloads(payload_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    bytes BLOB NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) = byte_length),
    PRIMARY KEY (payload_id, chunk_index)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS native_captures (
    capture_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    runtime_session_id TEXT NOT NULL,
    lifecycle_generation TEXT NOT NULL,
    ingress_ordinal INTEGER NOT NULL CHECK (ingress_ordinal > 0),
    fingerprint TEXT NOT NULL,
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    payload_id TEXT,
    committed_at TEXT NOT NULL,
    UNIQUE (project_id, thread_id, provider, provider_instance_id, runtime_session_id, lifecycle_generation, ingress_ordinal),
    FOREIGN KEY (project_id, thread_id, payload_id)
      REFERENCES durable_payloads(project_id, thread_id, payload_id) ON DELETE RESTRICT,
    CHECK ((json_extract(metadata_json, '$.disposition') = 'retained' AND payload_id IS NOT NULL)
      OR (json_extract(metadata_json, '$.disposition') = 'excluded' AND payload_id IS NULL))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_native_captures_scope_sequence
    ON native_captures(project_id, thread_id, capture_sequence)`;
  yield* sql`CREATE TABLE IF NOT EXISTS native_normalization_links (
    capture_id TEXT NOT NULL REFERENCES native_captures(capture_id) ON DELETE RESTRICT,
    event_id TEXT NOT NULL REFERENCES orchestration_events(event_id) ON DELETE RESTRICT,
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    message_id TEXT,
    PRIMARY KEY (capture_id, event_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_native_normalization_event ON native_normalization_links(event_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS durable_legacy_sources (
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('event', 'message', 'goal')),
    source_id TEXT NOT NULL,
    payload_id TEXT,
    event_id TEXT REFERENCES orchestration_events(event_id) ON DELETE RESTRICT,
    coverage TEXT NOT NULL CHECK (coverage IN ('normalized-only', 'unavailable')),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    PRIMARY KEY (project_id, thread_id, source_kind, source_id),
    FOREIGN KEY (project_id, thread_id, payload_id)
      REFERENCES durable_payloads(project_id, thread_id, payload_id) ON DELETE RESTRICT,
    CHECK ((source_kind = 'event' AND event_id IS NOT NULL AND payload_id IS NULL)
      OR (source_kind <> 'event' AND event_id IS NULL))
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS durable_capture_coverage (
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
    PRIMARY KEY (project_id, thread_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS durable_attachment_references (
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    message_id TEXT,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
    sha256 TEXT,
    availability TEXT NOT NULL CHECK (availability IN ('available', 'missing', 'expired', 'deleted')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, thread_id, attachment_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS durable_archive_backfill (
    source_kind TEXT PRIMARY KEY CHECK (source_kind IN ('event', 'message', 'goal', 'attachment')),
    cursor INTEGER NOT NULL DEFAULT 0,
    through_row INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
  )`;
  // Freeze finite fences once. Replaying this migration never restarts completed work.
  yield* sql`INSERT OR IGNORE INTO durable_archive_backfill(source_kind, through_row)
    VALUES ('event', (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)),
      ('message', (SELECT COALESCE(MAX(rowid), 0) FROM projection_thread_messages)),
      ('goal', (SELECT COALESCE(MAX(rowid), 0) FROM projection_threads)),
      ('attachment', (SELECT COALESCE(MAX(rowid), 0) FROM managed_attachment_blobs))`;
  for (const action of ["INSERT", "UPDATE"] as const) {
    yield* sql`CREATE TRIGGER IF NOT EXISTS ${sql.literal(`trg_durable_attachment_${action.toLowerCase()}`)}
      AFTER ${sql.literal(action)} ON managed_attachment_blobs BEGIN
      INSERT INTO durable_attachment_references
        (project_id, thread_id, attachment_id, message_id, original_name, mime_type, byte_length, sha256, availability, created_at)
      SELECT thread.project_id, NEW.owner_thread_id, NEW.attachment_id, NEW.claim_message_id,
        NEW.original_name, NEW.mime_type, NEW.size_bytes, NEW.sha256,
        CASE WHEN NEW.state IN ('deleting', 'deleted') THEN
          CASE WHEN NEW.delete_reason = 'staging-expired' THEN 'expired' ELSE 'deleted' END
          WHEN NEW.state IN ('staged', 'claimed') THEN 'available' ELSE 'missing' END,
        NEW.created_at
      FROM projection_threads AS thread WHERE thread.thread_id = NEW.owner_thread_id
      ON CONFLICT(project_id, thread_id, attachment_id) DO UPDATE SET
        message_id = COALESCE(excluded.message_id, durable_attachment_references.message_id),
        byte_length = COALESCE(excluded.byte_length, durable_attachment_references.byte_length),
        sha256 = COALESCE(excluded.sha256, durable_attachment_references.sha256),
        availability = excluded.availability;
      END`;
  }
  yield* sql`CREATE TRIGGER IF NOT EXISTS trg_durable_attachment_delete
    BEFORE DELETE ON managed_attachment_blobs BEGIN
    UPDATE durable_attachment_references SET availability = CASE WHEN availability = 'expired' THEN 'expired' ELSE 'deleted' END
      WHERE thread_id = OLD.owner_thread_id AND attachment_id = OLD.attachment_id;
    END`;
});
