import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runProcess } from "../../processRunner.ts";
import { purgeThreadNativeArchive } from "../nativeArchivePurge.ts";

import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EventId,
  NativeCaptureId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  NativeCaptureIdentity,
  NativeNormalizationLink,
  ProjectId,
  ThreadId,
} from "@synara/contracts";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import {
  NativeArchiveRepository,
  NATIVE_ARCHIVE_CHUNK_BYTES,
  type AppendNativeCapture,
} from "../Services/NativeArchive.ts";
import { NativeArchiveRepositoryLive } from "./NativeArchive.ts";
import { ProviderRuntimeEventRepositoryLive } from "./ProviderRuntimeEvents.ts";
import {
  ProviderRuntimeEventRepository,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  CHECKPOINT_RUNTIME_CONSUMER,
} from "../Services/ProviderRuntimeEvents.ts";

const timestamp = "2026-11-03T00:00:00.000Z";
const scope = {
  projectId: ProjectId.makeUnsafe("project-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
};
const identity = Schema.decodeUnknownSync(NativeCaptureIdentity)({
  ...scope,
  ingressOrdinal: 1,
  session: {
    provider: "codex",
    providerInstanceId: "codex_work",
    runtimeSessionId: "runtime-1",
    lifecycleGeneration: "generation-1",
  },
});
const capture = (text = "full content", ordinal = 1): AppendNativeCapture => ({
  schemaVersion: 1,
  identity: { ...identity, ingressOrdinal: ordinal },
  nativeSessionId: "reused-native-id",
  nativeEventId: "reused-native-id",
  nativeItemId: null,
  nativeTurnId: null,
  payloadType: "future.provider.event",
  direction: "incoming",
  observedAt: timestamp,
  capturePolicyVersion: 1,
  disposition: "retained",
  content: { encoding: "utf8-text", text },
});
const run = <A, E>(
  program: Effect.Effect<A, E, SqlClient.SqlClient | NativeArchiveRepository>,
  filename?: string,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(NativeArchiveRepositoryLive),
      Effect.provide(
        filename ? NodeSqliteClient.layer({ filename }) : NodeSqliteClient.layerMemory(),
      ),
    ),
  );
const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const id of [1, 2]) {
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${`project-${id}`}, 'Synthetic', '/synthetic', '[]', ${timestamp}, ${timestamp})`;
    yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
      VALUES (${`thread-${id}`}, ${`project-${id}`}, 'Synthetic', ${timestamp}, ${timestamp})`;
  }
});
const bytesFor = (
  payloadId: Parameters<NativeArchiveRepository["Service"]["streamPayload"]>[0]["payloadId"],
) =>
  Effect.gen(function* () {
    const archive = yield* NativeArchiveRepository;
    const chunks = yield* Stream.runCollect(archive.streamPayload({ ...scope, payloadId }));
    return Buffer.concat(chunks.map((bytes) => Buffer.from(bytes)));
  });
const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT (SELECT COUNT(*) FROM native_captures) AS captures,
    (SELECT COUNT(*) FROM durable_payloads) AS payloads, (SELECT COUNT(*) FROM durable_payload_chunks) AS chunks`;
  return rows[0];
});

describe("native archive", () => {
  it("keeps bounded tool previews linked to full content and rejects foreign or missing runtime provenance", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const runtime = yield* ProviderRuntimeEventRepository;
        const output = "🙂\0日本語\r\n".repeat(250_000) + "END_SENTINEL";
        const source = yield* archive.appendCapture(capture(JSON.stringify({ output })));
        const event: ProviderRuntimeEvent = {
          type: "item.completed",
          eventId: EventId.makeUnsafe("native-tool-preview"),
          threadId: scope.threadId,
          provider: "codex",
          providerInstanceId: ProviderInstanceId.makeUnsafe("codex_work"),
          lifecycleGeneration: "generation-1",
          nativeCaptureId: source.captureId,
          createdAt: timestamp,
          payload: { itemType: "command_execution", status: "completed", data: { output } },
        };
        const stored = yield* runtime.append(event);
        const duplicate = yield* runtime.append(event);
        expect(duplicate.sequence).toBe(stored.sequence);
        const replay = yield* runtime.readAfter({
          sequenceExclusive: 0,
          throughSequenceInclusive: stored.sequence,
          limit: 10,
        });
        expect(replay.map((row) => row.event)).toEqual([stored.event]);
        expect(Buffer.byteLength(JSON.stringify(stored.event))).toBeLessThan(128 * 1024);
        expect(stored.event.nativeCaptureId).toBe(source.captureId);
        if (source.disposition !== "retained") throw new Error("Retained source expected");
        expect(
          JSON.parse((yield* bytesFor(source.payload.payloadId)).toString("utf8")).output,
        ).toBe(output);
        const invalid = [
          { threadId: ThreadId.makeUnsafe("thread-2") },
          { provider: "claudeAgent" },
          { providerInstanceId: ProviderInstanceId.makeUnsafe("another-instance") },
          { lifecycleGeneration: "other-generation" },
          { nativeCaptureId: NativeCaptureId.makeUnsafe("missing-source") },
        ];
        for (const [index, change] of invalid.entries()) {
          const rejected = yield* Effect.flip(
            runtime.append({
              ...event,
              ...change,
              eventId: EventId.makeUnsafe(`invalid-source-${index}`),
            }),
          );
          expect(rejected._tag).toBe("PersistenceDecodeError");
        }
        expect(yield* runtime.getHighWaterSequence).toBe(stored.sequence);
      }).pipe(Effect.provide(ProviderRuntimeEventRepositoryLive)),
    );
  });

  it("reconstructs large text and JSON byte-for-byte through bounded pages, including NUL and split Unicode", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const text = "a".repeat(NATIVE_ARCHIVE_CHUNK_BYTES - 1) + "🙂\0日本語\r\n".repeat(180_000);
        for (const [encoding, value] of [
          ["utf8-text", text],
          ["utf8-json", JSON.stringify({ unknown: text, surrogate: "\uD800" })],
        ] as const) {
          const stored = yield* archive.appendPayload({
            ...scope,
            payloadKey: encoding,
            content: { encoding, text: value },
          });
          expect(stored.byteLength).toBe(Buffer.byteLength(value));
          expect(stored.sha256).toBe(createHash("sha256").update(Buffer.from(value)).digest("hex"));
          const first = yield* archive.readPayloadPage({
            ...scope,
            payloadId: stored.payloadId,
            fromChunkIndex: 0,
            limit: 1,
          });
          expect(first?.chunks).toHaveLength(1);
          expect(first?.nextChunkIndex).toBe(1);
          expect(first?.chunks[0]?.byteLength).toBe(NATIVE_ARCHIVE_CHUNK_BYTES);
          expect(yield* bytesFor(stored.payloadId)).toEqual(Buffer.from(value));
          expect((yield* bytesFor(stored.payloadId)).toString("utf8")).toBe(value);
        }
        const empty = yield* archive.appendPayload({
          ...scope,
          payloadKey: "empty",
          content: { encoding: "utf8-text", text: "" },
        });
        expect(empty.chunkCount).toBe(1);
        expect((yield* bytesFor(empty.payloadId)).byteLength).toBe(0);
      }),
    );
  });

  it("serializes duplicate appends and rejects content or metadata conflicts without replacing the original", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const results = yield* Effect.all(
          [
            archive.appendCapture(capture()),
            archive.appendCapture(capture()),
            archive.appendCapture(capture()),
          ],
          { concurrency: "unbounded" },
        );
        expect(new Set(results.map((row) => row.captureId)).size).toBe(1);
        expect(yield* counts).toEqual({ captures: 1, payloads: 1, chunks: 1 });
        for (const conflicting of [capture("different"), { ...capture(), observedAt: "changed" }]) {
          expect(yield* Effect.flip(archive.appendCapture(conflicting))).toMatchObject({
            reason: "identity-conflict",
          });
        }
        const original = results[0]!;
        if (original.disposition !== "retained") throw new Error("Expected retained capture");
        expect((yield* bytesFor(original.payload.payloadId)).toString()).toBe("full content");
        const payload = yield* archive.appendPayload({
          ...scope,
          payloadKey: "standalone",
          content: { encoding: "utf8-text", text: "same" },
        });
        expect(
          yield* archive.appendPayload({
            ...scope,
            payloadKey: "standalone",
            content: { encoding: "utf8-text", text: "same" },
          }),
        ).toEqual(payload);
        expect(
          yield* Effect.flip(
            archive.appendPayload({
              ...scope,
              payloadKey: "standalone",
              content: { encoding: "utf8-text", text: "other" },
            }),
          ),
        ).toMatchObject({ reason: "identity-conflict" });
      }),
    );
  });

  it("retains reused native IDs across providers, accounts, runtimes, generations and ordinals", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const sessions = [
          identity.session,
          { ...identity.session, provider: "claudeAgent" },
          { ...identity.session, providerInstanceId: "codex_personal" },
          {
            ...identity.session,
            runtimeSessionId: "runtime-2" as typeof identity.session.runtimeSessionId,
          },
          { ...identity.session, lifecycleGeneration: "generation-2" },
        ];
        const ids = new Set<string>();
        for (const session of sessions) {
          const row = yield* archive.appendCapture({
            ...capture(),
            identity: { ...identity, session },
          });
          ids.add(row.captureId);
        }
        ids.add((yield* archive.appendCapture(capture("full content", 2))).captureId);
        expect(ids.size).toBe(6);
      }),
    );
  });

  it("stores credential exclusions without content and rejects lossy text, malformed JSON and unsafe keys", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const {
          disposition: _disposition,
          content: _content,
          ...metadata
        } = capture() as Extract<AppendNativeCapture, { disposition: "retained" }>;
        const excluded = {
          ...metadata,
          disposition: "excluded" as const,
          reason: "authentication-exchange" as const,
        };
        expect((yield* archive.appendCapture(excluded)).disposition).toBe("excluded");
        expect(yield* counts).toEqual({ captures: 1, payloads: 0, chunks: 0 });
        expect(
          yield* Effect.flip(
            archive.appendCapture({
              ...excluded,
              content: { encoding: "utf8-text", text: "SECRET" },
            } as AppendNativeCapture),
          ),
        ).toMatchObject({ reason: "invalid-input" });
        for (const content of [
          { encoding: "utf8-text" as const, text: "\uD800" },
          { encoding: "utf8-json" as const, text: "{malformed" },
        ]) {
          const error = yield* Effect.flip(
            archive.appendPayload({ ...scope, payloadKey: "invalid", content }),
          );
          expect(error).toMatchObject({ reason: "invalid-input" });
          expect(JSON.stringify(error)).not.toContain(content.text);
        }
        expect(
          yield* Effect.flip(
            archive.appendPayload({
              ...scope,
              payloadKey: "key\0suffix",
              content: { encoding: "utf8-text", text: "valid\0text" },
            }),
          ),
        ).toMatchObject({ reason: "invalid-input" });
      }),
    );
  });

  it("rolls back all chunks and the capture if a later chunk write fails", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const sql = yield* SqlClient.SqlClient;
        const original = yield* archive.appendCapture(capture());
        const before = yield* counts;
        yield* sql`CREATE TRIGGER abort_archive_chunk BEFORE INSERT ON durable_payload_chunks
        WHEN NEW.chunk_index = 2 BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`;
        const error = yield* Effect.flip(
          archive.appendCapture(capture("large".repeat(100_000), 2)),
        );
        expect(error._tag).toBe("PersistenceSqlError");
        expect(yield* counts).toEqual(before);
        expect(JSON.stringify(error)).not.toContain("simulated storage failure");
        yield* sql`DROP TRIGGER abort_archive_chunk`;
        expect((yield* archive.appendCapture(capture())).captureId).toBe(original.captureId);
        expect(yield* archive.appendCapture(capture("large".repeat(100_000), 2))).toMatchObject({
          identity: { ingressOrdinal: 2 },
        });
      }),
    );
  });

  it("fails atomically on real SQLite disk-full and read-only errors, then permits safe storage retry", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const sql = yield* SqlClient.SqlClient;
        const original = yield* archive.appendCapture(capture());
        const before = yield* counts;
        const pages = yield* sql<{ page_count: number }>`PRAGMA page_count`;
        yield* sql`PRAGMA max_page_count = ${sql.literal(String(pages[0]!.page_count + 2))}`;
        const error = yield* Effect.flip(
          archive.appendCapture(capture("new content".repeat(300_000), 2)),
        );
        expect(error._tag).toBe("PersistenceSqlError");
        expect(yield* counts).toEqual(before);
        yield* sql`PRAGMA max_page_count = 2147483646`;
        yield* sql`PRAGMA query_only = ON`;
        expect((yield* Effect.flip(archive.appendCapture(capture("new content", 2))))._tag).toBe(
          "PersistenceSqlError",
        );
        yield* sql`PRAGMA query_only = OFF`;
        expect(yield* counts).toEqual(before);
        expect((yield* archive.appendCapture(capture())).captureId).toBe(original.captureId);
        expect(
          (yield* archive.appendCapture(capture("new content", 2))).identity.ingressOrdinal,
        ).toBe(2);
        expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }]);
      }),
    );
  });

  it("cancels a caller-owned transaction without publishing its staged archive rows", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const sql = yield* SqlClient.SqlClient;
        const staged = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* archive.appendCapture(capture("staged".repeat(60_000)));
              yield* Deferred.succeed(staged, undefined);
              yield* Effect.never;
            }),
          ),
        );
        yield* Deferred.await(staged);
        yield* Fiber.interrupt(fiber);
        expect(yield* counts).toEqual({ captures: 0, payloads: 0, chunks: 0 });
        expect((yield* archive.appendCapture(capture())).captureSequence).toBe(1);
      }),
    );
  });

  it("validates scoped normalization links, retains their sources and pages with a fixed capture fence", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* archive.appendCapture(capture());
        const fence = yield* archive.getHighWaterSequence(scope);
        yield* archive.appendCapture(capture("later", 2));
        expect(
          (yield* archive.listCaptures({
            ...scope,
            afterSequence: 0,
            throughSequence: fence,
            limit: 1,
          })).map((row) => row.captureId),
        ).toEqual([first.captureId]);
        yield* sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES ('event-1', 'thread', 'thread-1', 1, 'thread.message-sent', ${timestamp}, 'provider', '{}', '{}')`;
        const link = Schema.decodeUnknownSync(NativeNormalizationLink)({
          captureId: first.captureId,
          eventId: "event-1",
          eventSequence: 1,
          threadId: scope.threadId,
          turnId: null,
          messageId: null,
        });
        yield* archive.linkNormalization({ ...scope, link });
        yield* archive.linkNormalization({ ...scope, link });
        expect(
          yield* archive.listNormalizationLinks({
            ...scope,
            captureId: first.captureId,
            afterEventSequence: 0,
            limit: 1,
          }),
        ).toEqual([link]);
        expect(
          yield* Effect.flip(
            archive.linkNormalization({ ...scope, link: { ...link, eventSequence: 2 } }),
          ),
        ).toMatchObject({ reason: "ownership" });
        expect(
          yield* Effect.flip(
            archive.linkNormalization({
              ...scope,
              link: { ...link, messageId: "changed" as NonNullable<typeof link.messageId> },
            }),
          ),
        ).toMatchObject({ reason: "identity-conflict" });
        expect(
          (yield* Effect.exit(sql`DELETE FROM orchestration_events WHERE event_id = 'event-1'`))
            ._tag,
        ).toBe("Failure");
        if (first.disposition !== "retained") throw new Error("Expected retained capture");
        expect(
          (yield* Effect.exit(
            sql`DELETE FROM durable_payloads WHERE payload_id = ${first.payload.payloadId}`,
          ))._tag,
        ).toBe("Failure");
        expect(
          yield* archive.readPayloadPage({
            ...scope,
            projectId: ProjectId.makeUnsafe("project-2"),
            payloadId: first.payload.payloadId,
            fromChunkIndex: 0,
            limit: 1,
          }),
        ).toBeNull();
        yield* sql`UPDATE projection_threads SET deleted_at = ${timestamp} WHERE thread_id = ${scope.threadId}`;
        expect(
          yield* archive.listCaptures({
            ...scope,
            afterSequence: 0,
            throughSequence: 100,
            limit: 10,
          }),
        ).toEqual([]);
        expect((yield* counts)?.captures).toBe(2);
        // Explicit hard deletion releases archive edges before the existing event/projection purge.
        yield* sql.withTransaction(purgeThreadNativeArchive(sql, scope.threadId));
        yield* sql`DELETE FROM orchestration_events WHERE event_id = 'event-1'`;
        expect(yield* counts).toEqual({ captures: 0, payloads: 0, chunks: 0 });
      }),
    );
  });

  it("detects chunk corruption, missing chunks and total-hash mismatch instead of returning silent truncation", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const sql = yield* SqlClient.SqlClient;
        const original = yield* archive.appendPayload({
          ...scope,
          payloadKey: "corrupt",
          content: { encoding: "utf8-text", text: "x".repeat(100_000) },
        });
        yield* sql`UPDATE durable_payloads SET sha256 = ${"f".repeat(64)} WHERE payload_id = ${original.payloadId}`;
        expect(yield* Effect.flip(bytesFor(original.payloadId))).toMatchObject({
          reason: "integrity",
        });
        yield* sql`UPDATE durable_payloads SET sha256 = ${original.sha256} WHERE payload_id = ${original.payloadId}`;
        yield* sql`UPDATE durable_payload_chunks SET sha256 = ${"f".repeat(64)} WHERE payload_id = ${original.payloadId} AND chunk_index = 0`;
        expect(yield* Effect.flip(bytesFor(original.payloadId))).toMatchObject({
          reason: "integrity",
        });
        yield* sql`DELETE FROM durable_payload_chunks WHERE payload_id = ${original.payloadId} AND chunk_index = 0`;
        expect(yield* Effect.flip(bytesFor(original.payloadId))).toMatchObject({
          reason: "integrity",
        });
        expect(
          yield* Effect.flip(
            archive.readPayloadPage({
              ...scope,
              payloadId: original.payloadId,
              fromChunkIndex: 0,
              limit: 17,
            }),
          ),
        ).toMatchObject({ reason: "invalid-input" });
      }),
    );
  });

  it("replays archive migrations without resetting identities, recording intent or backfill progress", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* NativeArchiveRepository;
        const stored = yield* archive.appendCapture(capture("keep through replay"));
        if (stored.disposition !== "retained") throw new Error("Expected retained capture");
        yield* sql`UPDATE durable_archive_backfill SET cursor = through_row, completed = 1`;
        const progress = yield* sql`SELECT * FROM durable_archive_backfill ORDER BY source_kind`;
        yield* sql`INSERT INTO native_recording_sessions(thread_id, lifecycle_generation, provider, provider_instance_id, phase, created_at, updated_at)
          VALUES (${scope.threadId}, 'generation-1', 'codex', 'codex_work', 'starting', ${timestamp}, ${timestamp})`;
        const recording = yield* sql`SELECT * FROM native_recording_sessions`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 142`;
        expect(yield* runMigrations()).toEqual([
          [142, "DurableNativeArchive"],
          [143, "NativeRecordingSessions"],
          [144, "ProjectHistorySearch"],
        ]);
        expect(yield* sql`SELECT * FROM native_recording_sessions`).toEqual(recording);
        expect(yield* sql`SELECT * FROM durable_archive_backfill ORDER BY source_kind`).toEqual(
          progress,
        );
        expect((yield* archive.appendCapture(capture("keep through replay"))).captureId).toBe(
          stored.captureId,
        );
        expect((yield* bytesFor(stored.payload.payloadId)).toString()).toBe("keep through replay");
      }),
    );
  });

  it("keeps archive content after real operational journal pruning and a file-backed database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-archive-"));
    const filename = join(directory, "state.sqlite");
    try {
      const payloadId = await run(
        Effect.gen(function* () {
          yield* seed;
          const archive = yield* NativeArchiveRepository;
          const stored = yield* archive.appendCapture(capture("retained across pruning"));
          if (stored.disposition !== "retained") throw new Error("Expected retained capture");
          yield* Effect.gen(function* () {
            const journal = yield* ProviderRuntimeEventRepository;
            let last = 0;
            for (let index = 0; index < 1_030; index++) {
              last = (yield* journal.append({
                eventId: EventId.makeUnsafe(`runtime-${index}`),
                provider: "codex",
                threadId: scope.threadId,
                createdAt: timestamp,
                type: "runtime.warning",
                payload: { message: "operational" },
              })).sequence;
            }
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO provider_runtime_event_consumers(consumer_name, last_acked_sequence, created_at, updated_at)
            VALUES (${CHECKPOINT_RUNTIME_CONSUMER}, 0, ${timestamp}, ${timestamp})`;
            yield* journal.advanceConsumerCursorThrough({
              consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
              throughSequence: last,
              updatedAt: timestamp,
            });
            yield* journal.advanceConsumerCursorThrough({
              consumerName: CHECKPOINT_RUNTIME_CONSUMER,
              throughSequence: last,
              updatedAt: timestamp,
            });
            expect(
              yield* journal.readAfter({
                sequenceExclusive: 0,
                throughSequenceInclusive: 1,
                limit: 1,
              }),
            ).toEqual([]);
          }).pipe(Effect.provide(ProviderRuntimeEventRepositoryLive));
          return stored.payload.payloadId;
        }),
        filename,
      );
      expect(await run(bytesFor(payloadId), filename)).toEqual(
        Buffer.from("retained across pruning"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs the archive against the production Bun SQLite driver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-archive-bun-"));
    try {
      const source = `
        import { Effect, Layer, Stream } from "effect";
        import * as NodeServices from "@effect/platform-node/NodeServices";
        import * as SqlClient from "effect/unstable/sql/SqlClient";
        import { ProjectId, ThreadId } from "@synara/contracts";
        import { makeSqlitePersistenceLive } from ${JSON.stringify(new URL("./Sqlite.ts", import.meta.url).href)};
        import { NativeArchiveRepositoryLive } from ${JSON.stringify(new URL("./NativeArchive.ts", import.meta.url).href)};
        import { NativeArchiveRepository } from ${JSON.stringify(new URL("../Services/NativeArchive.ts", import.meta.url).href)};
        const scope = { projectId: ProjectId.makeUnsafe("project"), threadId: ThreadId.makeUnsafe("thread") };
        await Effect.runPromise(Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql\x60INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
            VALUES ('project','Synthetic','/synthetic','[]','2026-11-03','2026-11-03')\x60;
          yield* sql\x60INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
            VALUES ('thread','project','Synthetic','2026-11-03','2026-11-03')\x60;
          const archive = yield* NativeArchiveRepository;
          const text = "🙂日本語\\0".repeat(100000);
          const descriptor = yield* archive.appendPayload({ ...scope, payloadKey: "bun", content: { encoding: "utf8-text", text } });
          const chunks = yield* Stream.runCollect(archive.streamPayload({ ...scope, payloadId: descriptor.payloadId }));
          if (Buffer.concat(chunks.map(value => Buffer.from(value))).toString("utf8") !== text) throw new Error("Bun archive mismatch");
          const duplicate = yield* archive.appendPayload({ ...scope, payloadKey: "bun", content: { encoding: "utf8-text", text } });
          if (duplicate.payloadId !== descriptor.payloadId) throw new Error("Bun idempotency mismatch");
        }).pipe(Effect.provide(NativeArchiveRepositoryLive),
          Effect.provide(makeSqlitePersistenceLive(process.argv[1]).pipe(Layer.provide(NodeServices.layer)))));
      `;
      await runProcess("bun", ["--eval", source, join(directory, "state.sqlite")], {
        timeoutMs: 30_000,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers the last committed archive after a Bun writer exits with an open WAL transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-archive-crash-"));
    const filename = join(directory, "state.sqlite");
    const marker = join(directory, "staged");
    try {
      const payloadId = await run(
        Effect.gen(function* () {
          yield* seed;
          const archive = yield* NativeArchiveRepository;
          const stored = yield* archive.appendCapture(capture("last committed"));
          if (stored.disposition !== "retained") throw new Error("Expected retained capture");
          return stored.payload.payloadId;
        }),
        filename,
      );
      const source = `
        import { Effect } from "effect";
        import * as SqlClient from "effect/unstable/sql/SqlClient";
        import * as BunSqlite from "@effect/sql-sqlite-bun/SqliteClient";
        import { writeFile } from "node:fs/promises";
        import { NativeArchiveRepositoryLive } from ${JSON.stringify(new URL("./NativeArchive.ts", import.meta.url).href)};
        import { NativeArchiveRepository } from ${JSON.stringify(new URL("../Services/NativeArchive.ts", import.meta.url).href)};
        await Effect.runPromise(Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql\x60PRAGMA journal_mode = WAL\x60;
          yield* sql\x60PRAGMA synchronous = NORMAL\x60;
          yield* sql.withTransaction(Effect.gen(function* () {
            const archive = yield* NativeArchiveRepository;
            yield* archive.appendCapture({ ...${JSON.stringify(capture("staged", 2))}, content: { encoding: "utf8-text", text: "uncommitted".repeat(50000) } });
            yield* Effect.promise(() => writeFile(process.argv[2], "staged"));
            process.exit(23);
          }));
        }).pipe(Effect.provide(NativeArchiveRepositoryLive), Effect.provide(BunSqlite.layer({ filename: process.argv[1] }))));
      `;
      const result = await runProcess("bun", ["--eval", source, filename, marker], {
        timeoutMs: 30_000,
        allowNonZeroExit: true,
      });
      expect(result.code).toBe(23);
      expect(result.timedOut).toBe(false);
      expect(await readFile(marker, "utf8")).toBe("staged");
      expect(await run(counts, filename)).toEqual({ captures: 1, payloads: 1, chunks: 1 });
      expect(await run(bytesFor(payloadId), filename)).toEqual(Buffer.from("last committed"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
