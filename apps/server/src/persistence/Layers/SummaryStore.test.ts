import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  DurableRetentionCandidate,
  EventId,
  NativeCaptureIdentity,
  ProjectId,
  ThreadId,
  type CommitSummaryInput,
  type InformationScope,
  type InformationSource,
} from "@synara/contracts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import Migration145 from "../Migrations/145_DurableSummaryRevisions.ts";
import { NativeArchiveRepository } from "../Services/NativeArchive.ts";
import { NativeArchiveRepositoryLive } from "./NativeArchive.ts";
import { SummaryStoreRepository } from "../Services/SummaryStore.ts";
import { SummaryStoreRepositoryLive, makeSummaryStoreRepository } from "./SummaryStore.ts";
import { purgeThreadNativeArchive } from "../nativeArchivePurge.ts";
import { runProcess } from "../../processRunner.ts";

const time = "2026-11-08T12:00:00.000Z";
const project: InformationScope = { kind: "project", projectId: ProjectId.makeUnsafe("p") };
const chat = (id: string): InformationScope => ({
  kind: "chat",
  projectId: ProjectId.makeUnsafe(id === "c" ? "q" : "p"),
  threadId: ThreadId.makeUnsafe(id),
});
const watermark = { orchestrationSequence: 3, captureSequence: 3 };
const eventSource = (id = "a", sequence = 1): InformationSource => ({
  kind: "event",
  eventId: EventId.makeUnsafe(`event-${id}`),
  sequence,
});
const commitInput = (
  scope: InformationScope = project,
  overrides: Partial<CommitSummaryInput> = {},
): CommitSummaryInput => ({
  scope,
  expectedEpoch: 1,
  expectedPreviousRevisionId: null,
  text: "",
  sources: [],
  processedThrough: watermark,
  candidateIds: [],
  generation: null,
  ...overrides,
});
const candidate = (
  id: string,
  scope: InformationScope = project,
  sources: ReadonlyArray<InformationSource> = [eventSource()],
) =>
  Schema.decodeUnknownSync(DurableRetentionCandidate)({
    schemaVersion: 1,
    candidateId: id,
    scope,
    sources,
    sourceWatermark: watermark,
    category: "architecture",
    reason: "coding-turn",
    decision: "uncertain",
    classifier: { name: "fixture", version: "1" },
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: null,
    consumedByRevisionId: null,
    createdAt: time,
  });
const appendEvent = (id: string, kind: string, stream: string, type: string, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      sequence: number;
    }>`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES (${id}, ${kind}, ${stream}, (SELECT COALESCE(MAX(stream_version), 0) + 1 FROM orchestration_events WHERE aggregate_kind = ${kind} AND stream_id = ${stream}), ${type}, ${time}, 'server', ${JSON.stringify(payload)}, '{}') RETURNING sequence`;
    return rows[0]!.sequence;
  });
const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["p", "q"])
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, 'Fixture', ${`/work/${id}`}, '[]', ${time}, ${time})`;
  const archive = yield* NativeArchiveRepository;
  const captures: InformationSource[] = [];
  for (const [index, id] of ["a", "b", "c"].entries()) {
    const projectId = id === "c" ? "q" : "p";
    yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at) VALUES (${id}, ${projectId}, 'Fixture', ${time}, ${time})`;
    yield* appendEvent(`event-${id}`, "thread", id, "thread.message-sent", {
      threadId: id,
      text: `fact ${id}`,
    });
    const capture = yield* archive.appendCapture({
      schemaVersion: 1,
      identity: Schema.decodeUnknownSync(NativeCaptureIdentity)({
        projectId,
        threadId: id,
        ingressOrdinal: 1,
        session: {
          provider: "codex",
          providerInstanceId: "fixture",
          runtimeSessionId: `runtime-${id}`,
          lifecycleGeneration: "1",
        },
      }),
      nativeSessionId: null,
      nativeEventId: null,
      nativeItemId: null,
      nativeTurnId: null,
      payloadType: "tool.result",
      direction: "incoming",
      observedAt: time,
      capturePolicyVersion: 1,
      disposition: "retained",
      content: { encoding: "utf8-text", text: `complete native fact ${index}` },
    });
    captures.push({ kind: "capture", captureId: capture.captureId, byteRange: null });
  }
  return captures;
});
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | NativeArchiveRepository | SummaryStoreRepository
  >,
  filename?: string,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(SummaryStoreRepositoryLive),
      Effect.provide(NativeArchiveRepositoryLive),
      Effect.provide(
        filename ? NodeSqliteClient.layer({ filename }) : NodeSqliteClient.layerMemory(),
      ),
    ),
  );

describe("durable summary revisions", () => {
  it("commits cited candidates atomically with the production Bun SQLite driver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-summary-bun-"));
    try {
      const source = `
        import { Effect } from "effect";
        import * as SqlClient from "effect/unstable/sql/SqlClient";
        import * as BunSqlite from "@effect/sql-sqlite-bun/SqliteClient";
        import { runMigrations } from ${JSON.stringify(new URL("../Migrations.ts", import.meta.url).href)};
        import { SummaryStoreRepositoryLive } from ${JSON.stringify(new URL("./SummaryStore.ts", import.meta.url).href)};
        import { SummaryStoreRepository } from ${JSON.stringify(new URL("../Services/SummaryStore.ts", import.meta.url).href)};
        await Effect.runPromise(Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          yield* sql\x60INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
            VALUES ('p','Fixture','/work/p','[]','2026-11-08','2026-11-08')\x60;
          yield* sql\x60INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
            VALUES ('event-a','project','p',1,'project.meta-updated','2026-11-08','server','{}','{}')\x60;
          const store = yield* SummaryStoreRepository;
          const candidate = ${JSON.stringify(candidate("bun-candidate", project, [eventSource()]))};
          candidate.sourceWatermark = { orchestrationSequence: 1, captureSequence: 0 };
          yield* store.appendCandidate({ expectedEpoch: 1, candidate });
          const revision = yield* store.commit(${JSON.stringify(commitInput(project, { text: "durable fact", sources: [eventSource()], candidateIds: [candidate("bun-candidate").candidateId], processedThrough: { orchestrationSequence: 1, captureSequence: 0 } }))});
          const saved = yield* store.get(${JSON.stringify(project)});
          if (saved.current?.revisionId !== revision.revisionId) throw new Error("Bun head mismatch");
          if ((yield* store.getCandidate(candidate.scope, candidate.candidateId))?.candidate.state !== 'consumed') throw new Error("Bun candidate mismatch");
        }).pipe(Effect.provide(SummaryStoreRepositoryLive), Effect.provide(BunSqlite.layer({ filename: process.argv[1] }))));
      `;
      await runProcess("bun", ["--eval", source, join(directory, "state.sqlite")], {
        timeoutMs: 30_000,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("shares project knowledge while keeping independent, empty-valid chat summaries", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* SummaryStoreRepository;
        expect((yield* store.get(project)).current).toBeNull();
        const shared = yield* store.commit(
          commitInput(project, { text: "shared architecture", sources: [eventSource()] }),
        );
        const a = yield* store.commit(
          commitInput(chat("a"), { text: "implement parser", sources: [eventSource()] }),
        );
        const b = yield* store.commit(commitInput(chat("b")));
        expect((yield* store.get(project)).current?.revisionId).toBe(shared.revisionId);
        expect((yield* store.get(chat("a"))).current?.text).toBe("implement parser");
        expect((yield* store.get(chat("b"))).current?.text).toBe("");
        expect(new Set([shared.revisionId, a.revisionId, b.revisionId]).size).toBe(3);
        const next = yield* store.commit(
          commitInput(chat("a"), {
            expectedPreviousRevisionId: a.revisionId,
            text: "parser complete",
            sources: [eventSource()],
          }),
        );
        expect(next.revision).toBe(2);
        expect(next.previousRevisionId).toBe(a.revisionId);
        expect((yield* store.get(chat("b"))).current?.revisionId).toBe(b.revisionId);
      }),
    );
  });

  it("admits only one simultaneous scope writer and consumes only that writer's candidates", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const first = yield* SummaryStoreRepository;
        const second = yield* makeSummaryStoreRepository;
        const left = candidate("left");
        const right = candidate("right", project, [eventSource("b", 2)]);
        for (const item of [left, right])
          yield* first.appendCandidate({ expectedEpoch: 1, candidate: item });
        const results = yield* Effect.all(
          [
            Effect.result(
              first.commit(
                commitInput(project, {
                  text: "left",
                  sources: left.sources,
                  candidateIds: [left.candidateId],
                }),
              ),
            ),
            Effect.result(
              second.commit(
                commitInput(project, {
                  text: "right",
                  sources: right.sources,
                  candidateIds: [right.candidateId],
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
        const current = (yield* first.get(project)).current!;
        expect(["left", "right"]).toContain(current.text);
        expect(yield* first.listPending(project, 100)).toHaveLength(1);
        const original = current.text === "left" ? left : right;
        const replayed = yield* first.appendCandidate({ expectedEpoch: 1, candidate: original });
        expect(replayed.state).toBe("consumed");
        expect(replayed.consumedByRevisionId).toBe(current.revisionId);
        expect((yield* first.listRevisions({ scope: project, limit: 50 })).entries).toHaveLength(1);
      }),
    );
  });

  it("rolls back all revision, reference, head and candidate changes on failure or cancellation", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* SummaryStoreRepository;
        const sql = yield* SqlClient.SqlClient;
        const previous = yield* store.commit(commitInput());
        const item = candidate("pending");
        yield* store.appendCandidate({ expectedEpoch: 1, candidate: item });
        const update = commitInput(project, {
          expectedPreviousRevisionId: previous.revisionId,
          text: "next",
          sources: item.sources,
          candidateIds: [item.candidateId],
        });
        yield* sql`CREATE TRIGGER fail_summary_head BEFORE UPDATE OF head_revision_id ON summary_scopes BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`;
        const error = yield* Effect.flip(store.commit(update));
        expect(error._tag).toBe("PersistenceSqlError");
        expect(JSON.stringify(error)).not.toContain("synthetic failure");
        yield* sql`DROP TRIGGER fail_summary_head`;
        expect((yield* store.get(project)).current?.revisionId).toBe(previous.revisionId);
        expect((yield* store.listPending(project, 100)).map((row) => row.candidateId)).toEqual([
          item.candidateId,
        ]);
        expect((yield* store.listRevisions({ scope: project, limit: 50 })).entries).toHaveLength(1);
        const staged = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* store.commit(update);
              yield* Deferred.succeed(staged, undefined);
              yield* Effect.never;
            }),
          ),
        );
        yield* Deferred.await(staged);
        yield* Fiber.interrupt(fiber);
        expect((yield* store.get(project)).current?.revisionId).toBe(previous.revisionId);
        expect((yield* store.getCandidate(project, item.candidateId))?.candidate.state).toBe(
          "pending",
        );
        expect((yield* store.commit(update)).revision).toBe(2);
      }),
    );
  });

  it("validates ownership, citations, candidate membership and monotonic committed watermarks", async () => {
    await run(
      Effect.gen(function* () {
        const captures = yield* seed;
        const store = yield* SummaryStoreRepository;
        const badSources: ReadonlyArray<ReadonlyArray<InformationSource>> = [
          [captures[2]!],
          [eventSource("c", 3)],
          [eventSource("a", 2)],
          [{ kind: "objective", revisionId: "missing" } as InformationSource],
          [{ ...captures[0]!, byteRange: { start: 0, end: 999999 } } as InformationSource],
        ];
        for (const sources of badSources)
          expect((yield* Effect.flip(store.commit(commitInput(project, { sources }))))._tag).toBe(
            "SummaryStoreError",
          );
        expect(
          (yield* Effect.flip(store.commit(commitInput(chat("a"), { sources: [captures[1]!] }))))
            ._tag,
        ).toBe("SummaryStoreError");
        expect(
          (yield* Effect.flip(
            store.commit(
              commitInput(project, { processedThrough: { ...watermark, captureSequence: 4 } }),
            ),
          ))._tag,
        ).toBe("SummaryStoreError");
        const item = candidate("chat-only", chat("a"));
        yield* store.appendCandidate({ expectedEpoch: 1, candidate: item });
        expect(
          (yield* Effect.flip(
            store.commit(
              commitInput(project, {
                text: "wrong scope",
                sources: item.sources,
                candidateIds: [item.candidateId],
              }),
            ),
          ))._tag,
        ).toBe("SummaryStoreError");
        expect(
          (yield* Effect.flip(
            store.commit(
              commitInput(chat("a"), {
                text: "missing event citation",
                sources: [captures[0]!],
                candidateIds: [item.candidateId],
              }),
            ),
          ))._tag,
        ).toBe("SummaryStoreError");
        const first = yield* store.commit(
          commitInput(project, { sources: [captures[0]!, eventSource()] }),
        );
        expect(
          (yield* Effect.flip(store.commit(commitInput(chat("b"), { text: "uncited fact" }))))._tag,
        ).toBe("SummaryStoreError");
        expect(
          (yield* Effect.flip(
            store.commit(
              commitInput(project, {
                expectedPreviousRevisionId: first.revisionId,
                processedThrough: { orchestrationSequence: 0, captureSequence: 0 },
              }),
            ),
          ))._tag,
        ).toBe("SummaryStoreError");
        expect((yield* store.get(project)).current?.revisionId).toBe(first.revisionId);
      }),
    );
  });

  it("fences rollback, deletion and relocation while preserving immutable audit history", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* SummaryStoreRepository;
        const sql = yield* SqlClient.SqlClient;
        for (const scope of [project, chat("a"), chat("b")])
          yield* store.commit(commitInput(scope));
        const pending = candidate("before-rollback");
        yield* store.appendCandidate({ expectedEpoch: 1, candidate: pending });
        const sequence = yield* appendEvent(
          "rollback",
          "thread",
          "a",
          "thread.conversation-rolled-back",
          { threadId: "a" },
        );
        expect((yield* store.get(project)).current).toBeNull();
        expect((yield* store.get(chat("a"))).epoch).toBe(2);
        expect((yield* store.get(chat("b"))).current?.text).toBe("");
        expect(yield* store.listPending(project, 100)).toEqual([]);
        expect((yield* store.getCandidate(project, pending.candidateId))?.candidate.state).toBe(
          "pending",
        );
        expect((yield* Effect.flip(store.commit(commitInput(project))))._tag).toBe(
          "SummaryStoreError",
        );
        const newRevision = yield* store.commit(
          commitInput(project, {
            expectedEpoch: 2,
            processedThrough: { ...watermark, orchestrationSequence: sequence },
          }),
        );
        expect(newRevision.revision).toBe(1);
        expect(
          (yield* store.listRevisions({ scope: project, limit: 50 })).entries.map(
            (row) => row.epoch,
          ),
        ).toEqual([2, 1]);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* appendEvent("relocate", "project", "p", "project.meta-updated", {
              projectId: "p",
              workspaceRoot: "/new-root",
            });
            yield* sql`UPDATE projection_projects SET workspace_root = '/new-root' WHERE project_id = 'p'`;
          }),
        );
        expect((yield* store.get(project)).current).toBeNull();
        expect((yield* store.get(chat("b"))).current).toBeNull();
        yield* appendEvent("delete-a", "thread", "a", "thread.deleted", { threadId: "a" });
        yield* sql`UPDATE projection_threads SET deleted_at = ${time} WHERE thread_id = 'a'`;
        expect((yield* Effect.flip(store.get(chat("a"))))._tag).toBe("SummaryStoreError");
        yield* appendEvent("delete-p", "project", "p", "project.deleted", { projectId: "p" });
        yield* sql`UPDATE projection_projects SET deleted_at = ${time} WHERE project_id = 'p'`;
        expect((yield* Effect.flip(store.get(project)))._tag).toBe("SummaryStoreError");
      }),
    );
  });

  it("pins cited durable sources until explicit purge and makes their summaries/candidates inert", async () => {
    await run(
      Effect.gen(function* () {
        const captures = yield* seed;
        const store = yield* SummaryStoreRepository;
        const sql = yield* SqlClient.SqlClient;
        const item = candidate("retained", project, [eventSource(), captures[0]!]);
        yield* store.appendCandidate({ expectedEpoch: 1, candidate: item });
        yield* store.commit(commitInput(project, { sources: item.sources }));
        expect(
          (yield* Effect.exit(sql`DELETE FROM orchestration_events WHERE event_id = 'event-a'`))
            ._tag,
        ).toBe("Failure");
        yield* sql.withTransaction(purgeThreadNativeArchive(sql, "a"));
        yield* sql`DELETE FROM orchestration_events WHERE event_id = 'event-a'`;
        expect((yield* store.get(project)).current).toBeNull();
        expect(yield* store.listPending(project, 100)).toEqual([]);
        expect((yield* store.listRevisions({ scope: project, limit: 50 })).entries).toHaveLength(0);
        expect(yield* store.getCandidate(project, item.candidateId)).toBeNull();
      }),
    );
  });

  it("preserves revisions and consumed candidates across file reopen and idempotent migration replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-summary-"));
    const filename = join(directory, "state.sqlite");
    try {
      const id = await run(
        Effect.gen(function* () {
          yield* seed;
          const store = yield* SummaryStoreRepository;
          const item = candidate("durable");
          yield* store.appendCandidate({ expectedEpoch: 1, candidate: item });
          const first = yield* store.commit(
            commitInput(project, {
              text: "🙂\0full summary",
              sources: item.sources,
              candidateIds: [item.candidateId],
            }),
          );
          yield* store.commit(
            commitInput(project, {
              expectedPreviousRevisionId: first.revisionId,
              text: "latest",
              sources: first.sources,
            }),
          );
          return first.revisionId;
        }),
        filename,
      );
      await run(
        Effect.gen(function* () {
          const store = yield* SummaryStoreRepository;
          const before = yield* store.get(project);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 54`;
          yield* runMigrations();
          yield* Migration145;
          expect(yield* store.get(project)).toEqual(before);
          expect((yield* store.getRevision(project, id))?.revision.text).toBe("🙂\0full summary");
          expect(yield* store.getRevision(chat("b"), id)).toBeNull();
          expect(
            (yield* store.getCandidate(project, candidate("durable").candidateId))?.candidate
              .consumedByRevisionId,
          ).toBe(id);
          const firstPage = yield* store.listRevisions({ scope: project, limit: 1 });
          expect(firstPage.entries[0]?.revision.text).toBe("latest");
          const older = yield* store.listRevisions({
            scope: project,
            limit: 1,
            beforeSequence: firstPage.nextBeforeSequence!,
          });
          expect(older.entries[0]?.revision.text).toBe("🙂\0full summary");
          expect(older.nextBeforeSequence).toBeNull();
        }),
        filename,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
