import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EventId,
  HISTORY_RESPONSE_MAX_CHARS,
  NativeCaptureIdentity,
  ProjectId,
  ThreadId,
  type HistorySource,
  type ProjectHistoryReadResult,
} from "@synara/contracts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import Migration144 from "../Migrations/144_ProjectHistorySearch.ts";
import { NativeArchiveRepository, type AppendNativeCapture } from "../Services/NativeArchive.ts";
import { NativeArchiveRepositoryLive } from "./NativeArchive.ts";
import { ProjectHistoryRepository } from "../Services/ProjectHistory.ts";
import { ProjectHistoryRepositoryLive } from "./ProjectHistory.ts";
import { backfillHistoryPayloads } from "../historyIndex.ts";
import { runNativeArchiveBackfill } from "../nativeArchiveBackfill.ts";
import { purgeThreadNativeArchive } from "../nativeArchivePurge.ts";
import { ProviderRuntimeEventRepositoryLive } from "./ProviderRuntimeEvents.ts";
import {
  CHECKPOINT_RUNTIME_CONSUMER,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../Services/ProviderRuntimeEvents.ts";
import { makeHistoryTools } from "../../agentGateway/historyTools.ts";
import type { ToolContext } from "../../agentGateway/toolRuntime.ts";

const time = "2026-11-08T10:00:00.000Z";
const caller = ThreadId.makeUnsafe("caller");
const otherCaller = ThreadId.makeUnsafe("foreign");
const projectId = ProjectId.makeUnsafe("project");
const scope = { projectId, threadId: caller };
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | NativeArchiveRepository | ProjectHistoryRepository
  >,
  filename?: string,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(ProjectHistoryRepositoryLive),
      Effect.provide(NativeArchiveRepositoryLive),
      Effect.provide(
        filename ? NodeSqliteClient.layer({ filename }) : NodeSqliteClient.layerMemory(),
      ),
    ),
  );
const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["project", "foreign-project"])
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${id}, 'Fixture', '/synthetic', '[]', ${time}, ${time})`;
  for (const id of ["caller", "sibling", "archived", "foreign"])
    yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, archived_at, created_at, updated_at)
    VALUES (${id}, ${id === "foreign" ? "foreign-project" : "project"}, 'Fixture', ${id === "archived" ? time : null}, ${time}, ${time})`;
});
const capture = (
  provider: "codex" | "claudeAgent",
  threadId: ThreadId,
  ordinal: number,
  text: string,
): Extract<AppendNativeCapture, { disposition: "retained" }> => ({
  schemaVersion: 1,
  identity: Schema.decodeUnknownSync(NativeCaptureIdentity)({
    projectId: threadId === otherCaller ? "foreign-project" : projectId,
    threadId,
    session: {
      provider,
      providerInstanceId: `${provider}-instance`,
      runtimeSessionId: `${provider}-runtime`,
      lifecycleGeneration: `${provider}-generation`,
    },
    ingressOrdinal: ordinal,
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
  content: { encoding: "utf8-text", text },
});
const event = (id: string, text: string, threadId = caller) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES (${id}, 'thread', ${threadId}, (SELECT COALESCE(MAX(stream_version), 0) + 1 FROM orchestration_events WHERE stream_id = ${threadId}),
      'thread.message-sent', ${time}, 'user', ${JSON.stringify({ threadId, messageId: `message-${id}`, text })}, '{}')`;
  });
const readAll = (source: HistorySource) =>
  Effect.gen(function* () {
    const history = yield* ProjectHistoryRepository;
    let offset: number | null = 0;
    let text = "";
    while (offset !== null) {
      const page: ProjectHistoryReadResult = yield* history.read(caller, {
        ...source,
        threadId: ThreadId.makeUnsafe(source.threadId),
        byteOffset: offset,
      });
      expect(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          result: { content: [{ type: "text", text: JSON.stringify(page) }] },
        }).length,
      ).toBeLessThanOrEqual(HISTORY_RESPONSE_MAX_CHARS);
      expect(page.byteOffset).toBe(offset);
      if (page.nextByteOffset !== null) expect(page.nextByteOffset).toBeGreaterThan(offset);
      text += page.text;
      offset = page.nextByteOffset;
    }
    return text;
  });
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: caller,
    provider: "codex",
    turnId: null,
  },
  callerThreadId: caller,
  callerThreadLabel: null,
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:read"]),
  callerTurnId: null,
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 42,
};

describe("project history", () => {
  it("retrieves both providers' oversized results after handoff, operational pruning and database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-history-"));
    const filename = join(directory, "state.sqlite");
    const text = "preface " + '🙂\0日本語\r\n\\"'.repeat(9000) + " recalledfact END";
    try {
      const sourceIds = await run(
        Effect.gen(function* () {
          yield* seed;
          const archive = yield* NativeArchiveRepository;
          const sql = yield* SqlClient.SqlClient;
          const ids: string[] = [];
          for (const provider of ["codex", "claudeAgent"] as const) {
            const stored = yield* archive.appendCapture(
              capture(provider, ThreadId.makeUnsafe("sibling"), 1, text),
            );
            if (stored.disposition !== "retained") throw new Error("Retained capture required");
            ids.push(stored.payload.payloadId);
          }
          // A handoff changes the active provider; retained history belongs to the project, not that runtime.
          yield* sql`UPDATE projection_threads SET model_selection_json = '{"provider":"claudeAgent","model":"fixture"}' WHERE thread_id = 'caller'`;
          yield* Effect.gen(function* () {
            const journal = yield* ProviderRuntimeEventRepository;
            let last = 0;
            for (let i = 0; i < 1030; i++)
              last = (yield* journal.append({
                eventId: EventId.makeUnsafe(`runtime-${i}`),
                provider: "codex",
                threadId: caller,
                createdAt: time,
                type: "runtime.warning",
                payload: { message: "operational" },
              })).sequence;
            yield* sql`INSERT INTO provider_runtime_event_consumers(consumer_name, last_acked_sequence, created_at, updated_at) VALUES (${CHECKPOINT_RUNTIME_CONSUMER}, 0, ${time}, ${time})`;
            for (const consumerName of [
              PROVIDER_RUNTIME_INGESTION_CONSUMER,
              CHECKPOINT_RUNTIME_CONSUMER,
            ])
              yield* journal.advanceConsumerCursorThrough({
                consumerName,
                throughSequence: last,
                updatedAt: time,
              });
            expect(
              yield* journal.readAfter({
                sequenceExclusive: 0,
                throughSequenceInclusive: 1,
                limit: 1,
              }),
            ).toEqual([]);
          }).pipe(Effect.provide(ProviderRuntimeEventRepositoryLive));
          return ids;
        }),
        filename,
      );
      await run(
        Effect.gen(function* () {
          const history = yield* ProjectHistoryRepository;
          const result = yield* history.search(caller, { query: "recalledfact" });
          expect(new Set(result.matches.map((match) => match.sourceId))).toEqual(
            new Set(sourceIds),
          );
          for (const match of result.matches) {
            expect(match.captureId).toBeTruthy();
            expect(match.excerpt).toContain("recalledfact");
            expect(yield* readAll(match)).toBe(text);
          }
        }),
        filename,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects foreign IDs and cursors at the service boundary and requires explicit archived scope", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const history = yield* ProjectHistoryRepository;
        const sql = yield* SqlClient.SqlClient;
        for (const id of [caller, ThreadId.makeUnsafe("archived"), otherCaller]) {
          for (let i = 1; i <= 12; i++)
            yield* archive.appendCapture(capture("codex", id, i, `scopedfact ${i}`));
        }
        const { content: _excludedContent, ...excluded } = capture(
          "codex",
          caller,
          13,
          "excludedsecret",
        );
        yield* archive.appendCapture({
          ...excluded,
          disposition: "excluded",
          reason: "credential-material",
        });
        expect((yield* history.search(caller, { query: "excludedsecret" })).matches).toEqual([]);
        yield* event("foreign-event", "foreignfact", otherCaller);
        const foreignEvent = (yield* history.search(otherCaller, { query: "foreignfact" }))
          .matches[0]!;
        expect(
          (yield* Effect.flip(history.read(caller, { ...foreignEvent, threadId: caller })))._tag,
        ).toBe("ProjectHistoryError");
        const own = yield* history.search(caller, { query: "scopedfact" });
        expect(own.matches.every((match) => match.threadId === caller)).toBe(true);
        expect(own.nextCursor).toBeTruthy();
        expect(
          (yield* Effect.flip(
            history.search(otherCaller, { query: "scopedfact", cursor: own.nextCursor! }),
          ))._tag,
        ).toBe("ProjectHistoryError");
        for (const target of [otherCaller, ThreadId.makeUnsafe("archived")])
          expect(
            (yield* Effect.flip(history.search(caller, { query: "scopedfact", threadId: target })))
              ._tag,
          ).toBe("ProjectHistoryError");
        const foreign = yield* history.search(otherCaller, { query: "scopedfact" });
        const source = foreign.matches[0]!;
        expect(
          (yield* Effect.flip(history.read(caller, { ...source, threadId: otherCaller })))._tag,
        ).toBe("ProjectHistoryError");
        expect(
          (yield* Effect.flip(history.read(caller, { ...source, threadId: caller })))._tag,
        ).toBe("ProjectHistoryError");
        const archived = yield* history.search(caller, {
          query: "scopedfact",
          threadId: ThreadId.makeUnsafe("archived"),
          includeArchived: true,
        });
        const archivedSource = {
          ...archived.matches[0]!,
          threadId: ThreadId.makeUnsafe("archived"),
        };
        expect((yield* Effect.flip(history.read(caller, archivedSource)))._tag).toBe(
          "ProjectHistoryError",
        );
        expect(
          (yield* history.read(caller, { ...archivedSource, includeArchived: true })).text,
        ).toContain("scopedfact");
        expect(
          (yield* Effect.flip(
            history.search(caller, {
              query: "scopedfact",
              includeArchived: true,
              cursor: own.nextCursor!,
            }),
          ))._tag,
        ).toBe("ProjectHistoryError");
        yield* sql`UPDATE projection_threads SET deleted_at = ${time} WHERE thread_id = 'archived'`;
        expect(
          (yield* history.search(caller, {
            query: "scopedfact",
            includeArchived: true,
          })).matches.every((match) => match.threadId === caller),
        ).toBe(true);
        expect(
          (yield* Effect.flip(history.read(caller, { ...archivedSource, includeArchived: true })))
            ._tag,
        ).toBe("ProjectHistoryError");
        yield* sql`UPDATE projection_projects SET deleted_at = ${time} WHERE project_id = 'project'`;
        expect((yield* Effect.flip(history.search(caller, { query: "scopedfact" })))._tag).toBe(
          "ProjectHistoryError",
        );
      }),
    );
  });

  it("keeps fenced pagination stable, updates/deletes indexed events and rebuilds without accepting stale cursors", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const history = yield* ProjectHistoryRepository;
        const sql = yield* SqlClient.SqlClient;
        for (let i = 0; i < 15; i++) yield* event(`old-${i}`, "oldfact");
        const first = yield* history.search(caller, { query: "oldfact" });
        expect(first.matches.length).toBeGreaterThan(0);
        expect(first.nextCursor).toBeTruthy();
        yield* event("later", "oldfact");
        const ids = first.matches.map((match) => match.sourceId);
        let cursor = first.nextCursor;
        while (cursor) {
          const page = yield* history.search(caller, { query: "oldfact", cursor });
          ids.push(...page.matches.map((match) => match.sourceId));
          cursor = page.nextCursor;
        }
        expect(ids).toHaveLength(15);
        expect(new Set(ids).size).toBe(15);
        expect(ids).not.toContain("later");
        const original = first.matches[0]!;
        yield* sql`UPDATE orchestration_events SET payload_json = '{"text":"replacementfact"}' WHERE event_id = ${original.sourceId}`;
        expect(
          (yield* Effect.flip(history.read(caller, { ...original, threadId: caller })))._tag,
        ).toBe("ProjectHistoryError");
        const updated = yield* history.search(caller, { query: "replacementfact" });
        expect(updated.matches.map((match) => match.sourceId)).toEqual([original.sourceId]);
        expect(JSON.parse(yield* readAll(updated.matches[0]!))).toEqual({
          text: "replacementfact",
        });
        yield* sql`DELETE FROM orchestration_events WHERE event_id = ${original.sourceId}`;
        expect((yield* history.search(caller, { query: "replacementfact" })).matches).toEqual([]);
        yield* sql`INSERT INTO history_fts(history_fts) VALUES ('delete-all')`;
        expect((yield* history.search(caller, { query: "oldfact" })).matches).toEqual([]);
        yield* history.rebuildIndex;
        expect(
          (yield* Effect.flip(
            history.search(caller, { query: "oldfact", cursor: first.nextCursor! }),
          ))._tag,
        ).toBe("ProjectHistoryError");
        expect(
          (yield* history.search(caller, { query: "oldfact" })).matches.length,
        ).toBeGreaterThan(0);
        yield* Migration144;
        yield* sql`INSERT INTO history_fts(history_fts, rank) VALUES ('integrity-check', 1)`;
      }),
    );
  });

  it("backfills old normalized facts and native payloads, then resumes safely after an interrupted index transaction", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const sql = yield* SqlClient.SqlClient;
        const history = yield* ProjectHistoryRepository;
        const stored = yield* archive.appendCapture(
          capture("codex", caller, 1, " ".repeat(65530) + "seamword followed by a nativefact"),
        );
        if (stored.disposition !== "retained") throw new Error("Retained capture required");
        yield* sql`INSERT INTO projection_thread_messages(thread_id, message_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('caller', 'legacy', 'user', 'legacyfact survives migration', 0, ${time}, ${time})`;
        // The old archive's finite fence predates this synthetic legacy fixture.
        yield* sql`UPDATE durable_archive_backfill SET cursor = 0, through_row = (SELECT MAX(rowid) FROM projection_thread_messages), completed = 0 WHERE source_kind = 'message'`;
        yield* runNativeArchiveBackfill;
        yield* sql`DELETE FROM history_documents WHERE source_kind = 'payload'`;
        yield* sql`DELETE FROM history_indexed_payloads`;
        yield* sql`CREATE TRIGGER interrupt_history BEFORE INSERT ON history_documents WHEN NEW.part = 1 BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END`;
        expect((yield* Effect.exit(backfillHistoryPayloads))._tag).toBe("Failure");
        expect(
          yield* sql`SELECT 1 FROM history_indexed_payloads WHERE payload_id = ${stored.payload.payloadId}`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT 1 FROM history_documents WHERE source_id = ${stored.payload.payloadId}`,
        ).toEqual([]);
        yield* sql`DROP TRIGGER interrupt_history`;
        yield* backfillHistoryPayloads;
        yield* backfillHistoryPayloads;
        for (const query of ["nativefact", "seamword", "legacyfact"])
          expect((yield* history.search(caller, { query })).matches.length).toBeGreaterThan(0);
        yield* history.rebuildIndex;
        expect(
          (yield* history.search(caller, { query: "nativefact" })).matches.length,
        ).toBeGreaterThan(0);
        yield* purgeThreadNativeArchive(sql, caller);
        expect((yield* history.search(caller, { query: "nativefact" })).matches).toEqual([]);
        expect((yield* history.search(caller, { query: "legacyfact" })).matches).toEqual([]);
      }),
    );
  });

  it("keeps gateway envelopes bounded with escaped text, exact Unicode/NUL/BOM pages and invalid input", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const archive = yield* NativeArchiveRepository;
        const history = yield* ProjectHistoryRepository;
        const text = "\uFEFF" + "a".repeat(8190) + '🙂\0\r\n"\\'.repeat(12000) + " budgetfact";
        const payload = yield* archive.appendPayload({
          ...scope,
          payloadKey: "escaping",
          content: { encoding: "utf8-text", text },
        });
        const tools = makeHistoryTools(history);
        const searchTool = tools.find((tool) => tool.definition.name === "synara_search_history")!;
        const readTool = tools.find(
          (tool) => tool.definition.name === "synara_read_history_source",
        )!;
        const found = yield* searchTool.handler({ query: "budgetfact" }, context);
        expect(found.isError).toBeUndefined();
        expect(
          JSON.stringify({ jsonrpc: "2.0", id: 42, result: found }).length,
        ).toBeLessThanOrEqual(HISTORY_RESPONSE_MAX_CHARS);
        if (found.content[0]?.type !== "text") throw new Error("Expected text");
        const source = JSON.parse(found.content[0].text).matches[0];
        expect(yield* readAll(source)).toBe(text);
        const page = yield* readTool.handler(
          {
            threadId: caller,
            sourceKind: "payload",
            sourceId: payload.payloadId,
            sourceVersion: payload.sha256,
          },
          context,
        );
        expect(JSON.stringify({ jsonrpc: "2.0", id: 42, result: page }).length).toBeLessThanOrEqual(
          HISTORY_RESPONSE_MAX_CHARS,
        );
        expect(payload.sha256).toBe(createHash("sha256").update(text).digest("hex"));
        for (const byteOffset of [
          -1,
          0.5,
          Number.MAX_SAFE_INTEGER + 1,
          Buffer.byteLength(text) + 1,
          8194,
        ]) {
          const rejected = yield* readTool.handler(
            {
              threadId: caller,
              sourceKind: "payload",
              sourceId: payload.payloadId,
              sourceVersion: payload.sha256,
              byteOffset,
            },
            context,
          );
          expect(rejected.isError).toBe(true);
        }
        for (const args of [
          { query: "" },
          { query: "x".repeat(257) },
          { query: '" OR *' },
          { query: "budgetfact", cursor: "garbage" },
        ]) {
          const response = yield* searchTool.handler(args, context);
          if (args.query === '" OR *') expect(response.isError).toBeUndefined();
          else expect(response.isError).toBe(true);
        }
        const empty = yield* archive.appendPayload({
          ...scope,
          payloadKey: "empty",
          content: { encoding: "utf8-text", text: "" },
        });
        expect(
          (yield* history.read(caller, {
            threadId: caller,
            sourceKind: "payload",
            sourceId: empty.payloadId,
            sourceVersion: empty.sha256,
          })).text,
        ).toBe("");
        expect(
          (yield* history.read(caller, {
            threadId: caller,
            sourceKind: "payload",
            sourceId: payload.payloadId,
            sourceVersion: payload.sha256,
            byteOffset: Buffer.byteLength(text),
          })).nextByteOffset,
        ).toBeNull();
      }),
    );
  });
});
