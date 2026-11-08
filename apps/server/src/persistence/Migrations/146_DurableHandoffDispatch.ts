import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS handoff_packets (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, packet_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL, thread_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
    command_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt > 0),
    provider TEXT NOT NULL, provider_instance_id TEXT NOT NULL, lifecycle_generation TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('handoff', 'recovery')),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    prepared_json TEXT NOT NULL CHECK (json_valid(prepared_json))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_handoff_packet_thread ON handoff_packets(project_id, thread_id, sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_handoff_packet_delivery ON handoff_packets(event_sequence, sequence)`;
  yield* sql`CREATE TABLE IF NOT EXISTS handoff_outcomes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    packet_id TEXT NOT NULL REFERENCES handoff_packets(packet_id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'failed', 'uncertain')),
    occurred_at TEXT NOT NULL, UNIQUE(packet_id, outcome)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS handoff_dispatch_receipts (
    packet_id TEXT PRIMARY KEY REFERENCES handoff_packets(packet_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL, recorded_at TEXT NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_handoff_receipt_turn ON handoff_dispatch_receipts(turn_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS handoff_start_attempts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL, source_json TEXT NOT NULL, target_json TEXT NOT NULL, created_at TEXT NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS handoff_start_outcomes (
    id TEXT NOT NULL REFERENCES handoff_start_attempts(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('started', 'failed', 'uncertain')),
    occurred_at TEXT NOT NULL, PRIMARY KEY(id, outcome)
  ) WITHOUT ROWID`;
  // Either ordering is possible: a terminal can be journaled before sendTurn returns its turn ID.
  yield* sql`CREATE TRIGGER IF NOT EXISTS handoff_terminal_receipt AFTER INSERT ON provider_runtime_events
    WHEN NEW.event_type = 'turn.completed' AND json_extract(NEW.event_json, '$.payload.state') = 'completed'
    BEGIN
      INSERT OR IGNORE INTO handoff_outcomes(packet_id, outcome, occurred_at)
      SELECT packet.packet_id, 'accepted', json_extract(NEW.event_json, '$.createdAt')
      FROM handoff_packets AS packet JOIN handoff_dispatch_receipts AS receipt ON receipt.packet_id = packet.packet_id
      WHERE packet.thread_id = NEW.thread_id AND receipt.turn_id = NEW.turn_id
        AND packet.lifecycle_generation = NEW.lifecycle_generation
        AND packet.provider = json_extract(NEW.event_json, '$.provider')
        AND packet.provider_instance_id = json_extract(NEW.event_json, '$.providerInstanceId');
    END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS handoff_early_terminal_receipt AFTER INSERT ON handoff_dispatch_receipts
    BEGIN
      INSERT OR IGNORE INTO handoff_outcomes(packet_id, outcome, occurred_at)
      SELECT packet.packet_id, 'accepted', json_extract(event.event_json, '$.createdAt')
      FROM handoff_packets AS packet JOIN provider_runtime_events AS event
        ON event.thread_id = packet.thread_id AND event.lifecycle_generation = packet.lifecycle_generation
      WHERE packet.packet_id = NEW.packet_id AND event.turn_id = NEW.turn_id
        AND event.event_type = 'turn.completed' AND json_extract(event.event_json, '$.payload.state') = 'completed'
        AND packet.provider = json_extract(event.event_json, '$.provider')
        AND packet.provider_instance_id = json_extract(event.event_json, '$.providerInstanceId');
    END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS handoff_reconciled_receipt AFTER INSERT ON provider_delivery_reconciliations
    WHEN NEW.consumer_name = 'provider-command-reactor.v1' AND NEW.outcome = 'accepted'
    BEGIN
      INSERT OR IGNORE INTO handoff_outcomes(packet_id, outcome, occurred_at)
      SELECT packet_id, 'accepted', NEW.reconciled_at FROM handoff_packets
      WHERE thread_id = NEW.thread_id AND event_sequence = NEW.event_sequence
      ORDER BY sequence DESC LIMIT 1;
    END`;
});
