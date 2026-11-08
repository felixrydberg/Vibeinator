import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS history_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('event', 'payload')),
    source_id TEXT NOT NULL,
    part INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL,
    body TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    UNIQUE (source_kind, source_id, part)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_history_scope ON history_documents(project_id, thread_id, id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_native_captures_payload ON native_captures(payload_id)`;
  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
    body, content='history_documents', content_rowid='id', tokenize='unicode61'
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS history_index_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), epoch TEXT NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO history_index_state VALUES (1, lower(hex(randomblob(16))))`;
  yield* sql`CREATE TABLE IF NOT EXISTS history_indexed_payloads (
    payload_id TEXT PRIMARY KEY REFERENCES durable_payloads(payload_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS history_documents_insert AFTER INSERT ON history_documents BEGIN
    INSERT INTO history_fts(rowid, body) VALUES (NEW.id, NEW.body);
  END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS history_documents_delete AFTER DELETE ON history_documents BEGIN
    INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
  END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS history_documents_update AFTER UPDATE ON history_documents BEGIN
    INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
    INSERT INTO history_fts(rowid, body) VALUES (NEW.id, NEW.body);
  END`;
  // Events are durable history, including earlier message revisions; never index settings or credentials.
  for (const action of ["INSERT", "UPDATE"] as const) {
    yield* sql`CREATE TRIGGER IF NOT EXISTS ${sql.literal(`history_event_${action.toLowerCase()}`)}
      AFTER ${sql.literal(action === "UPDATE" ? "UPDATE OF payload_json, stream_id, event_type, aggregate_kind, event_id" : "INSERT")} ON orchestration_events
      ${
        action === "UPDATE"
          ? sql`WHEN NEW.payload_json IS NOT OLD.payload_json OR NEW.stream_id IS NOT OLD.stream_id
        OR NEW.event_type IS NOT OLD.event_type OR NEW.aggregate_kind IS NOT OLD.aggregate_kind OR NEW.event_id IS NOT OLD.event_id`
          : sql``
      }
      BEGIN
      ${action === "UPDATE" ? sql`DELETE FROM history_documents WHERE source_kind = 'event' AND source_id = OLD.event_id AND OLD.event_id <> NEW.event_id;` : sql``}
      DELETE FROM history_documents WHERE source_kind = 'event' AND source_id = NEW.event_id
        AND (NEW.aggregate_kind <> 'thread' OR NEW.event_type NOT IN ('thread.message-sent', 'thread.activity-appended'));
      INSERT INTO history_documents(project_id, thread_id, source_kind, source_id, part, byte_offset, body)
        SELECT thread.project_id, NEW.stream_id, 'event', NEW.event_id, 0, 0, NEW.payload_json
        FROM projection_threads AS thread WHERE thread.thread_id = NEW.stream_id
          AND NEW.aggregate_kind = 'thread' AND NEW.event_type IN ('thread.message-sent', 'thread.activity-appended')
        ON CONFLICT(source_kind, source_id, part) DO UPDATE SET body = excluded.body,
          project_id = excluded.project_id, thread_id = excluded.thread_id, revision = history_documents.revision + 1;
    END`;
  }
  yield* sql`CREATE TRIGGER IF NOT EXISTS history_event_delete AFTER DELETE ON orchestration_events BEGIN
    DELETE FROM history_documents WHERE source_kind = 'event' AND source_id = OLD.event_id;
  END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS history_payload_delete BEFORE DELETE ON durable_payloads BEGIN
    DELETE FROM history_documents WHERE source_kind = 'payload' AND source_id = OLD.payload_id;
  END`;
  // Idempotent lineage replay preserves document IDs, revisions and cursor fences.
  yield* sql`INSERT OR IGNORE INTO history_documents(project_id, thread_id, source_kind, source_id, part, byte_offset, body)
    SELECT thread.project_id, event.stream_id, 'event', event.event_id, 0, 0, event.payload_json
    FROM orchestration_events AS event JOIN projection_threads AS thread ON thread.thread_id = event.stream_id
    WHERE event.aggregate_kind = 'thread' AND event.event_type IN ('thread.message-sent', 'thread.activity-appended')
    ORDER BY event.sequence`;
});
