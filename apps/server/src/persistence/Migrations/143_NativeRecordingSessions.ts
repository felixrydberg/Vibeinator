import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS native_recording_sessions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    lifecycle_generation TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    runtime_session_id TEXT,
    phase TEXT NOT NULL CHECK (phase IN ('starting', 'recording', 'stopped', 'failed')),
    failure_reason TEXT CHECK (failure_reason IN ('capture', 'journal', 'projection', 'restart', 'overflow')),
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (thread_id, lifecycle_generation)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS native_recording_sessions_thread ON native_recording_sessions(thread_id, sequence DESC)`;
});
