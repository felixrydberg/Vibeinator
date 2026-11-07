import { Effect, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { runNativeArchiveBackfill } from "./nativeArchiveBackfill.ts";
import { NativeArchiveRepositoryLive } from "./Layers/NativeArchive.ts";
import { NativeArchiveRepository } from "./Services/NativeArchive.ts";
import { makeManagedAttachmentRepositoryLive } from "./Layers/ManagedAttachments.ts";
import { ManagedAttachmentRepository } from "./Services/ManagedAttachments.ts";

const timestamp = "2026-11-03T00:00:00.000Z";
const scope = {
  projectId: ProjectId.makeUnsafe("project"),
  threadId: ThreadId.makeUnsafe("thread"),
};
const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | NativeArchiveRepository>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(NativeArchiveRepositoryLive),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
  );
const seedLegacy = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 141 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Synthetic', '/synthetic', '[]', ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, goal, created_at, updated_at)
    VALUES ('thread', 'project', 'Synthetic', 'complete inline objective', ${timestamp}, ${timestamp}),
      ('file-goal', 'project', 'Synthetic', 'Read this file: C:/untrusted/credentials.txt', ${timestamp}, ${timestamp}),
      ('empty', 'project', 'Synthetic', NULL, ${timestamp}, ${timestamp})`;
});
const readJsonPayload = (
  payloadId: Parameters<NativeArchiveRepository["Service"]["streamPayload"]>[0]["payloadId"],
) =>
  Effect.gen(function* () {
    const archive = yield* NativeArchiveRepository;
    const bytes = yield* Stream.runCollect(archive.streamPayload({ ...scope, payloadId }));
    return JSON.parse(Buffer.concat(bytes.map((value) => Buffer.from(value))).toString("utf8"));
  });

describe("native archive backfill", () => {
  it("preserves normalized event ownership, complete chunked messages, goal coverage and missing attachment metadata", async () => {
    await run(
      Effect.gen(function* () {
        yield* seedLegacy;
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* NativeArchiveRepository;
        const prefix = "prefix\0\uD800";
        const suffix = "\uDC00🙂日本語".repeat(20_000);
        const attachment = {
          type: "image",
          id: "old-image",
          name: "design.png",
          mimeType: "image/png",
          sizeBytes: 123,
        };
        yield* sql`INSERT INTO projection_thread_messages(thread_id, message_id, role, text, text_json, is_streaming, attachments_json, created_at, updated_at)
        VALUES ('thread', 'message', 'assistant', '', ${JSON.stringify(prefix)}, 1, ${JSON.stringify([attachment])}, ${timestamp}, ${timestamp})`;
        yield* sql`INSERT INTO message_text_chunks(thread_id, message_id, event_sequence, text_json, updated_at)
        VALUES ('thread', 'message', 5, ${JSON.stringify(suffix)}, ${timestamp})`;
        yield* sql`INSERT INTO projection_thread_messages(thread_id, message_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('thread', 'raw-nul', 'assistant', ${"legacy\0retained suffix"}, 0, ${timestamp}, ${timestamp})`;
        yield* sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES ('existing-event', 'thread', 'thread', 1, 'thread.message-sent', ${timestamp}, 'provider', '{}', '{}')`;
        yield* runMigrations();
        yield* runNativeArchiveBackfill;
        const before = yield* sql`SELECT * FROM durable_archive_backfill ORDER BY source_kind`;
        yield* runNativeArchiveBackfill;
        expect(yield* sql`SELECT * FROM durable_archive_backfill ORDER BY source_kind`).toEqual(
          before,
        );
        const messages = yield* archive.listLegacySources({
          ...scope,
          sourceKind: "message",
          afterSourceId: "",
          limit: 10,
        });
        expect(messages).toHaveLength(2);
        expect((yield* readJsonPayload(messages[0]!.payload!.payloadId)).text).toBe(
          prefix + suffix,
        );
        expect((yield* readJsonPayload(messages[1]!.payload!.payloadId)).text).toBe(
          "legacy\0retained suffix",
        );
        expect(
          (yield* archive.listLegacySources({
            ...scope,
            sourceKind: "event",
            afterSourceId: "",
            limit: 10,
          }))[0],
        ).toMatchObject({ eventId: "existing-event", payload: null, coverage: "normalized-only" });
        expect(yield* archive.getCoverage(scope)).toMatchObject({
          coverage: "normalized-only",
          through: { orchestrationSequence: 1, captureSequence: 0 },
        });
        const goal = (yield* archive.listLegacySources({
          ...scope,
          sourceKind: "goal",
          afterSourceId: "",
          limit: 10,
        }))[0]!;
        expect(yield* readJsonPayload(goal.payload!.payloadId)).toBe("complete inline objective");
        expect(
          (yield* archive.listLegacySources({
            ...scope,
            threadId: ThreadId.makeUnsafe("file-goal"),
            sourceKind: "goal",
            afterSourceId: "",
            limit: 10,
          }))[0],
        ).toMatchObject({
          coverage: "unavailable",
          payload: null,
          metadata: { reason: "external-objective-not-imported" },
        });
        expect(
          yield* archive.getCoverage({ ...scope, threadId: ThreadId.makeUnsafe("empty") }),
        ).toMatchObject({ coverage: "unavailable" });
        expect(
          (yield* archive.listAttachmentReferences({
            ...scope,
            afterAttachmentId: "",
            limit: 10,
          }))[0],
        ).toMatchObject({
          attachmentId: "old-image",
          availability: "missing",
          byteLength: 123,
          sha256: null,
        });
        expect(yield* sql`SELECT * FROM native_captures`).toEqual([]);
        expect(
          (yield* Effect.exit(
            sql`DELETE FROM orchestration_events WHERE event_id = 'existing-event'`,
          ))._tag,
        ).toBe("Failure");
        expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      }),
    );
  });

  it("resumes at the last committed page and excludes rows beyond the migration fence", async () => {
    await run(
      Effect.gen(function* () {
        yield* seedLegacy;
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* NativeArchiveRepository;
        for (let i = 1; i <= 120; i++)
          yield* sql`INSERT INTO projection_thread_messages
        (thread_id, message_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('thread', ${`message-${i}`}, 'assistant', ${`full text ${i}`}, 0, ${timestamp}, ${timestamp})`;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_thread_messages(thread_id, message_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('thread', 'post-fence', 'user', 'new work', 0, ${timestamp}, ${timestamp})`;
        yield* sql`CREATE TRIGGER fail_backfill_page BEFORE INSERT ON durable_legacy_sources
        WHEN NEW.source_kind = 'message' AND NEW.source_id = 'message-75'
        BEGIN SELECT RAISE(ABORT, 'failed page'); END`;
        expect((yield* Effect.flip(runNativeArchiveBackfill))._tag).toBe("PersistenceSqlError");
        expect(
          yield* sql`SELECT cursor, completed FROM durable_archive_backfill WHERE source_kind = 'message'`,
        ).toEqual([{ cursor: 50, completed: 0 }]);
        expect(yield* sql`SELECT COUNT(*) AS count FROM durable_payloads`).toEqual([{ count: 50 }]);
        yield* sql`DROP TRIGGER fail_backfill_page`;
        yield* runNativeArchiveBackfill;
        expect(
          yield* sql`SELECT COUNT(*) AS count FROM durable_legacy_sources WHERE source_kind = 'message'`,
        ).toEqual([{ count: 120 }]);
        expect(yield* sql`SELECT COUNT(*) AS count FROM durable_payloads`).toEqual([
          { count: 121 },
        ]);
        const page1 = yield* archive.listLegacySources({
          ...scope,
          sourceKind: "message",
          afterSourceId: "",
          limit: 100,
        });
        const page2 = yield* archive.listLegacySources({
          ...scope,
          sourceKind: "message",
          afterSourceId: page1.at(-1)!.sourceId,
          limit: 100,
        });
        expect(new Set([...page1, ...page2].map((row) => row.sourceId)).size).toBe(120);
        expect([...page1, ...page2].some((row) => row.sourceId === "post-fence")).toBe(false);
        expect(yield* sql`SELECT DISTINCT completed FROM durable_archive_backfill`).toEqual([
          { completed: 1 },
        ]);
      }),
    );
  });

  it("keeps attachment metadata and availability through upload, expiry, cleanup and tombstone compaction", async () => {
    await run(
      Effect.gen(function* () {
        yield* seedLegacy;
        yield* runMigrations();
        const archive = yield* NativeArchiveRepository;
        yield* Effect.gen(function* () {
          const attachments = yield* ManagedAttachmentRepository;
          yield* attachments.reserve({
            attachmentId: "image",
            ownerThreadId: "thread",
            ownerKind: "principal",
            ownerId: "test",
            kind: "image",
            originalName: "design.png",
            mimeType: "image/png",
            reservedBytes: 10,
            relativePath: "images/design.png",
            now: timestamp,
          });
          yield* attachments.finalizeStaged({
            attachmentId: "image",
            ownerThreadId: "thread",
            ownerKind: "principal",
            ownerId: "test",
            sizeBytes: 10,
            sha256: "a".repeat(64),
            stagingExpiresAt: timestamp,
            now: timestamp,
          });
          expect(
            (yield* archive.listAttachmentReferences({
              ...scope,
              afterAttachmentId: "",
              limit: 10,
            }))[0],
          ).toMatchObject({ availability: "available", sha256: "a".repeat(64) });
          yield* attachments.markExpiredForCleanup({
            now: "2026-11-04T00:00:00.000Z",
            uploadingCutoff: timestamp,
            limit: 10,
          });
          expect(
            (yield* archive.listAttachmentReferences({
              ...scope,
              afterAttachmentId: "",
              limit: 10,
            }))[0]?.availability,
          ).toBe("expired");
          yield* attachments.leaseCleanup({
            leaseOwner: "test",
            now: "2026-11-04T00:00:00.000Z",
            leaseExpiresAt: "2026-11-05T00:00:00.000Z",
            limit: 10,
          });
          yield* attachments.completeCleanup({
            attachmentId: "image",
            expectedLeaseOwner: "test",
            disposition: "already-missing",
            completedAt: "2026-11-04T00:00:00.000Z",
          });
          yield* attachments.compactDeleted({
            deletedBefore: "2026-11-05T00:00:00.000Z",
            limit: 10,
          });
          const retained = yield* archive.listAttachmentReferences({
            ...scope,
            afterAttachmentId: "",
            limit: 10,
          });
          expect(retained).toHaveLength(1);
          expect(retained[0]).toMatchObject({
            attachmentId: "image",
            originalName: "design.png",
            availability: "expired",
          });
        }).pipe(
          Effect.provide(
            makeManagedAttachmentRepositoryLive({
              homeBytes: 100,
              homeCount: 100,
              principalStagingBytes: 100,
              principalStagingCount: 100,
            }),
          ),
        );
      }),
    );
  });
});
