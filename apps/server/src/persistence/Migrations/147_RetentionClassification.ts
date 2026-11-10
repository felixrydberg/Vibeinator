import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS retention_jobs (
    job_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
    reason TEXT NOT NULL CHECK (reason IN ('coding-turn', 'objective-change', 'status-change')),
    boundary_sequence INTEGER NOT NULL REFERENCES orchestration_events(sequence) ON DELETE CASCADE,
    through_sequence INTEGER NOT NULL, source_sequence INTEGER NOT NULL DEFAULT 0,
    source_offset INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
    project_epoch INTEGER, chat_epoch INTEGER, workspace_root TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_retention_pending ON retention_jobs(done, boundary_sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_retention_turn ON retention_jobs(thread_id, turn_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS retention_sections (
    candidate_id TEXT PRIMARY KEY REFERENCES summary_candidates(candidate_id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK (field IN ('message-text', 'tool-payload', 'explicit-change')),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset)
  )`;
  // The normalized terminal is appended after message settlement. No provider dispatch is replayed.
  yield* sql`CREATE TRIGGER IF NOT EXISTS retention_completed_turn AFTER INSERT ON orchestration_events
    WHEN NEW.event_type = 'thread.activity-appended'
      AND json_extract(NEW.payload_json, '$.activity.kind') = 'turn.completed'
      AND json_extract(NEW.payload_json, '$.activity.payload.state') = 'completed'
      AND json_type(NEW.payload_json, '$.activity.turnId') = 'text'
    BEGIN
      INSERT OR IGNORE INTO retention_jobs(job_key, thread_id, turn_id, reason, boundary_sequence, through_sequence)
      VALUES (json_array('turn', NEW.stream_id, json_extract(NEW.payload_json, '$.activity.turnId')),
        NEW.stream_id, json_extract(NEW.payload_json, '$.activity.turnId'), 'coding-turn', NEW.sequence, NEW.sequence);
    END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS retention_explicit_change AFTER INSERT ON orchestration_events
    WHEN NEW.event_type = 'thread.meta-updated' AND (
      json_type(NEW.payload_json, '$.goal') IS NOT NULL OR json_type(NEW.payload_json, '$.goalStartedAt') IS NOT NULL
      OR json_type(NEW.payload_json, '$.goalPausedAt') IS NOT NULL OR json_type(NEW.payload_json, '$.goalAchievements') IS NOT NULL
      OR json_type(NEW.payload_json, '$.settledAt') IS NOT NULL)
    BEGIN
      INSERT OR IGNORE INTO retention_jobs(job_key, thread_id, reason, boundary_sequence, through_sequence)
      VALUES (json_array('change', NEW.event_id), NEW.stream_id,
        CASE WHEN json_type(NEW.payload_json, '$.goal') IS NOT NULL THEN 'objective-change' ELSE 'status-change' END,
        NEW.sequence, NEW.sequence);
    END`;
  // Providers may finalize an item after the terminal. Reopen only its existing successful job.
  yield* sql`CREATE TRIGGER IF NOT EXISTS retention_late_source AFTER INSERT ON orchestration_events
    WHEN (NEW.event_type = 'thread.message-sent' AND json_extract(NEW.payload_json, '$.streaming') = 0)
      OR (NEW.event_type = 'thread.activity-appended' AND json_extract(NEW.payload_json, '$.activity.kind') = 'tool.completed')
    BEGIN
      UPDATE retention_jobs SET through_sequence = NEW.sequence, done = 0
      WHERE thread_id = NEW.stream_id AND reason = 'coding-turn'
        AND turn_id = COALESCE(json_extract(NEW.payload_json, '$.turnId'), json_extract(NEW.payload_json, '$.activity.turnId'))
        AND through_sequence < NEW.sequence;
    END`;
  // Existing successful boundaries are eligible too; the durable cursor begins at zero.
  yield* sql`INSERT OR IGNORE INTO retention_jobs(job_key, thread_id, turn_id, reason, boundary_sequence, through_sequence)
    SELECT json_array('turn', stream_id, json_extract(payload_json, '$.activity.turnId')), stream_id,
      json_extract(payload_json, '$.activity.turnId'), 'coding-turn', MIN(sequence),
      COALESCE((SELECT MAX(late.sequence) FROM orchestration_events AS late WHERE late.stream_id = event.stream_id
        AND (json_extract(late.payload_json, '$.turnId') = json_extract(event.payload_json, '$.activity.turnId')
          OR json_extract(late.payload_json, '$.activity.turnId') = json_extract(event.payload_json, '$.activity.turnId'))), MAX(sequence))
    FROM orchestration_events AS event WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') = 'turn.completed'
      AND json_extract(payload_json, '$.activity.payload.state') = 'completed'
      AND json_type(payload_json, '$.activity.turnId') = 'text'
    GROUP BY stream_id, json_extract(payload_json, '$.activity.turnId')`;
  yield* sql`INSERT OR IGNORE INTO retention_jobs(job_key, thread_id, reason, boundary_sequence, through_sequence)
    SELECT json_array('change', event_id), stream_id,
      CASE WHEN json_type(payload_json, '$.goal') IS NOT NULL THEN 'objective-change' ELSE 'status-change' END,
      sequence, sequence FROM orchestration_events WHERE event_type = 'thread.meta-updated' AND (
        json_type(payload_json, '$.goal') IS NOT NULL OR json_type(payload_json, '$.goalStartedAt') IS NOT NULL
        OR json_type(payload_json, '$.goalPausedAt') IS NOT NULL OR json_type(payload_json, '$.goalAchievements') IS NOT NULL
        OR json_type(payload_json, '$.settledAt') IS NOT NULL)`;
});
