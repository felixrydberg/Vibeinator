import { DatabaseSync } from "node:sqlite";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { LATEST_MIGRATION_ID, migrationEntries, runMigrations } from "./Migrations.ts";
import { MigrationSchemaTooNewError } from "./Errors.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { runNativeArchiveBackfill } from "./nativeArchiveBackfill.ts";

const fixtures = [
  { name: "synara-v0.5.5", migrationId: 54 },
  { name: "synara-v0.6.7", migrationId: 88 },
  { name: "synara-pinned", migrationId: 141 },
] as const;
const timestamp = "2026-11-03T00:00:00.000Z";
const messageText = `Keep the full conversation: café, 日本語, 🦀\n${"long response\n".repeat(12_000)}`;
const attachmentJson = JSON.stringify([
  { type: "file", id: "fixture-attachment", name: "design.txt" },
]);
const eventPayload = JSON.stringify({
  threadId: "fixture-thread",
  messageId: "fixture-message",
  role: "assistant",
  text: messageText,
  turnId: "fixture-turn",
  streaming: false,
  source: "native",
  createdAt: timestamp,
  updatedAt: timestamp,
});

const openFixture = async (filename: string, fixtureName: string) => {
  const schema = await readFile(new URL(`./fixtures/${fixtureName}.sql`, import.meta.url), "utf8");
  const database = new DatabaseSync(filename);
  try {
    database.exec(schema);
    database.exec("PRAGMA foreign_keys = ON");
    database
      .prepare(`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('fixture-project', 'Synthetic project', '/synthetic/project', '[]', ?, ?)`)
      .run(timestamp, timestamp);
    database
      .prepare(`INSERT INTO projection_threads
      (thread_id, project_id, title, created_at, updated_at)
      VALUES ('fixture-thread', 'fixture-project', 'Existing conversation', ?, ?)`)
      .run(timestamp, timestamp);
    database
      .prepare(`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, attachments_json, created_at, updated_at)
      VALUES ('fixture-message', 'fixture-thread', 'assistant', ?, 0, ?, ?, ?)`)
      .run(messageText, attachmentJson, timestamp, timestamp);
    database
      .prepare(`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
       actor_kind, payload_json, metadata_json)
      VALUES ('fixture-event', 'thread', 'fixture-thread', 1, 'thread.message-sent', ?, 'provider', ?, '{}')`)
      .run(timestamp, eventPayload);
    database
      .prepare(`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
      VALUES ('fixture-command', 'thread', 'fixture-thread', ?, 1, 'accepted')`)
      .run(timestamp);
    database
      .prepare(`INSERT INTO provider_session_runtime
      (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
      VALUES ('fixture-thread', 'codex', 'codex', 'ready', ?, ?)`)
      .run(timestamp, JSON.stringify({ threadId: "fixture-native-session" }));
    database
      .prepare(`INSERT INTO projection_turns
      (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
      VALUES ('fixture-thread', 'fixture-turn', 'completed', ?, ?, '[]')`)
      .run(timestamp, timestamp);
    if (
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'projection_pending_interactions'")
        .get()
    ) {
      database
        .prepare(`INSERT INTO projection_pending_interactions
        (interaction_kind, request_id, thread_id, turn_id, status, created_at)
        VALUES ('approval', 'fixture-approval', 'fixture-thread', 'fixture-turn', 'pending', ?)`)
        .run(timestamp);
    } else {
      database
        .prepare(`INSERT INTO projection_pending_approvals
        (request_id, thread_id, turn_id, status, created_at)
        VALUES ('fixture-approval', 'fixture-thread', 'fixture-turn', 'pending', ?)`)
        .run(timestamp);
    }
    if (
      database
        .prepare("SELECT name FROM pragma_table_info('projection_threads') WHERE name = 'goal'")
        .get()
    ) {
      database
        .prepare("UPDATE projection_threads SET goal = ? WHERE thread_id = 'fixture-thread'")
        .run(messageText);
    }
  } finally {
    database.close();
  }
};

const readConversation = (database: DatabaseSync) => ({
  project: database
    .prepare(
      "SELECT project_id, title, workspace_root FROM projection_projects WHERE project_id = 'fixture-project'",
    )
    .all(),
  thread: database
    .prepare(
      "SELECT thread_id, project_id, title FROM projection_threads WHERE thread_id = 'fixture-thread'",
    )
    .all(),
  message: database
    .prepare(
      "SELECT message_id, thread_id, role, text, attachments_json FROM projection_thread_messages WHERE thread_id = 'fixture-thread'",
    )
    .all(),
  event: database
    .prepare("SELECT * FROM orchestration_events WHERE event_id = 'fixture-event'")
    .all(),
  receipt: database
    .prepare(
      "SELECT command_id, aggregate_id, result_sequence, status FROM orchestration_command_receipts WHERE command_id = 'fixture-command'",
    )
    .all(),
  session: database
    .prepare(
      "SELECT thread_id, provider_name, resume_cursor_json FROM provider_session_runtime WHERE thread_id = 'fixture-thread'",
    )
    .all(),
  turn: database
    .prepare(
      "SELECT thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json FROM projection_turns WHERE thread_id = 'fixture-thread'",
    )
    .all(),
  approval: database
    .prepare(
      `SELECT request_id, thread_id, turn_id, status, created_at FROM ${
        database
          .prepare("SELECT name FROM sqlite_master WHERE name = 'projection_pending_interactions'")
          .get()
          ? "projection_pending_interactions"
          : "projection_pending_approvals"
      } WHERE thread_id = 'fixture-thread'`,
    )
    .all(),
  goal: database
    .prepare("SELECT name FROM pragma_table_info('projection_threads') WHERE name = 'goal'")
    .get()
    ? (database
        .prepare("SELECT goal FROM projection_threads WHERE thread_id = 'fixture-thread'")
        .get()?.goal ?? null)
    : null,
});

const readFileConversation = (filename: string) => {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return readConversation(database);
  } finally {
    database.close();
  }
};

describe("durable migration fixtures", () => {
  for (const fixture of fixtures) {
    it(`preserves ${fixture.name} conversations through upgrade, replay and reopen`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "vibeinator-migration-fixture-"));
      const filename = join(directory, "state.sqlite");
      try {
        await openFixture(filename, fixture.name);
        const before = readFileConversation(filename);
        const existing = new DatabaseSync(filename, { readOnly: true });
        try {
          expect(
            existing.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get(),
          ).toEqual({ id: fixture.migrationId });
        } finally {
          existing.close();
        }

        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA foreign_keys = ON`;
            yield* runMigrations();
            yield* runNativeArchiveBackfill;
            expect(
              yield* sql`SELECT COUNT(*) AS count FROM durable_legacy_sources WHERE source_kind = 'message'`,
            ).toEqual([{ count: 1 }]);
            expect(yield* sql`SELECT COUNT(*) AS count FROM native_captures`).toEqual([
              { count: 0 },
            ]);
            // A second startup is a no-op; neither startup creates or dispatches provider work.
            expect(yield* runMigrations()).toEqual([]);
            expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
            expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }]);
            const tracker = yield* sql<{
              migration_id: number;
              name: string;
            }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
            expect(tracker.map((row) => [row.migration_id, row.name])).toEqual(
              migrationEntries.map(([id, name]) => [id, name]),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
        );

        expect(readFileConversation(filename)).toEqual(before);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("refuses a future additive schema before changing its data or migration tracker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-newer-schema-"));
    const filename = join(directory, "state.sqlite");
    try {
      await openFixture(filename, "synara-pinned");
      await Effect.runPromise(
        runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      const futureId = LATEST_MIGRATION_ID + 1;
      const database = new DatabaseSync(filename);
      database.exec(
        "CREATE TABLE future_native_captures (id TEXT PRIMARY KEY, payload BLOB NOT NULL)",
      );
      database
        .prepare("INSERT INTO future_native_captures VALUES ('native-1', ?)")
        .run(Buffer.from(messageText));
      database
        .prepare(
          "INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (?, 'FutureNativeCapture', ?)",
        )
        .run(futureId, timestamp);
      const trackerBefore = database
        .prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id")
        .all();
      database.close();
      const before = readFileConversation(filename);

      const error = await Effect.runPromise(
        Effect.flip(runMigrations()).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      expect(error).toBeInstanceOf(MigrationSchemaTooNewError);
      expect(error).toMatchObject({
        databaseMigrationId: futureId,
        latestSupportedMigrationId: LATEST_MIGRATION_ID,
      });
      expect(readFileConversation(filename)).toEqual(before);
      const after = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          after.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
        ).toEqual(trackerBefore);
        const row = after
          .prepare("SELECT payload FROM future_native_captures WHERE id = 'native-1'")
          .get() as { payload: Uint8Array };
        expect(Buffer.from(row.payload).toString("utf8")).toBe(messageText);
      } finally {
        after.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
