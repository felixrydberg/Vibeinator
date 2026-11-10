import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  DurableRetentionCandidate,
  OrchestrationEvent,
  type DecisionResult,
} from "@synara/contracts";
import {
  DecisionEngine,
  type DecisionEngineShape,
} from "../../decisionEngine/Services/DecisionEngine.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import Migration147 from "../../persistence/Migrations/147_RetentionClassification.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SummaryStoreRepositoryLive } from "../../persistence/Layers/SummaryStore.ts";
import { RetentionClassification } from "../Services/RetentionClassification.ts";
import { RetentionClassificationLive } from "./RetentionClassification.ts";
import { purgeThreadNativeArchive } from "../../persistence/nativeArchivePurge.ts";
import { runProcess } from "../../processRunner.ts";

const time = "2026-11-10T12:00:00.000Z";
const fallback: DecisionResult = {
  status: "fallback",
  reason: "unavailable",
  retainInformation: true,
};
const advice = (
  choice: "retain" | "discard" | "uncertain",
  category = "architecture",
): DecisionResult => ({
  status: "decided",
  answers: {
    retention: {
      type: "choice",
      choice,
      probabilities: {
        retain: choice === "retain" ? 1 : 0,
        discard: choice === "discard" ? 1 : 0,
        uncertain: choice === "uncertain" ? 1 : 0,
      },
      confidence: 1,
    },
    category: { type: "choice", choice: category, probabilities: { [category]: 1 }, confidence: 1 },
  },
});
const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('p','Fixture','/work/p','[]',${time},${time})`;
  for (const id of ["a", "b"])
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
      VALUES (${id},'p','Fixture',${time},${time})`;
});
const append = (id: string, type: string, payload: unknown, thread = "a") =>
  Effect.gen(function* () {
    const events = yield* OrchestrationEventStore;
    return yield* events.append(
      Schema.decodeUnknownSync(OrchestrationEvent)({
        sequence: 0,
        eventId: id,
        aggregateKind: "thread",
        aggregateId: thread,
        occurredAt: time,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type,
        payload,
      }),
    );
  });
const message = (
  id: string,
  text: string,
  turnId: string | null = "turn-1",
  thread = "a",
  streaming = false,
) =>
  append(
    id,
    "thread.message-sent",
    {
      threadId: thread,
      messageId: id,
      role: "assistant",
      text,
      turnId,
      streaming,
      createdAt: time,
      updatedAt: time,
    },
    thread,
  );
const terminal = (id = "terminal", state = "completed", turnId = "turn-1", thread = "a") =>
  append(
    id,
    "thread.activity-appended",
    {
      threadId: thread,
      activity: {
        id,
        kind: "turn.completed",
        summary: "Terminal",
        tone: "info",
        turnId,
        payload: { state },
        createdAt: time,
      },
    },
    thread,
  );
const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | OrchestrationEventStore>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(OrchestrationEventStoreLive),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
  );
const drain = (decide: DecisionEngineShape["decide"] = () => Effect.succeed(fallback)) =>
  Effect.gen(function* () {
    const classifier = yield* RetentionClassification;
    yield* classifier.drain;
  }).pipe(
    Effect.provide(
      RetentionClassificationLive.pipe(
        Layer.provide(SummaryStoreRepositoryLive),
        Layer.provide(Layer.succeed(DecisionEngine, { decide })),
      ),
    ),
  );
const candidates = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    json: string;
  }>`SELECT record_json AS json FROM summary_candidates ORDER BY candidate_id`;
  return rows.map((row) =>
    Schema.decodeUnknownSync(Schema.fromJsonString(DurableRetentionCandidate))(row.json),
  );
});

describe("durable retention classification", () => {
  it("resumes the production Bun SQLite cursor after closing and reopening the desktop database in a new process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-retention-restart-"));
    const script = `
      import { Effect, Layer, Deferred, Fiber } from "effect";
      import * as SqlClient from "effect/unstable/sql/SqlClient";
      import * as BunSqlite from "@effect/sql-sqlite-bun/SqliteClient";
      import { runMigrations } from ${JSON.stringify(new URL("../../persistence/Migrations.ts", import.meta.url).href)};
      import { SummaryStoreRepositoryLive } from ${JSON.stringify(new URL("../../persistence/Layers/SummaryStore.ts", import.meta.url).href)};
      import { RetentionClassificationLive } from ${JSON.stringify(new URL("./RetentionClassification.ts", import.meta.url).href)};
      import { RetentionClassification } from ${JSON.stringify(new URL("../Services/RetentionClassification.ts", import.meta.url).href)};
      import { DecisionEngine } from ${JSON.stringify(new URL("../../decisionEngine/Services/DecisionEngine.ts", import.meta.url).href)};
      let calls = 0;
      const first = process.argv[2] === "first";
      await Effect.runPromise(Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        if (first) {
          yield* sql\x60INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
            VALUES ('p','Fixture','/work/p','[]',${JSON.stringify(time)},${JSON.stringify(time)})\x60;
          yield* sql\x60INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
            VALUES ('a','p','Fixture',${JSON.stringify(time)},${JSON.stringify(time)})\x60;
          for (const [index, [type, payload]] of [
            ['thread.message-sent', {threadId:'a',messageId:'large',role:'assistant',text:'x'.repeat(8001),turnId:'turn',streaming:false}],
            ['thread.activity-appended', {threadId:'a',activity:{id:'terminal',kind:'turn.completed',turnId:'turn',payload:{state:'completed'}}}]
          ].entries()) {
            yield* sql\x60INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
              VALUES (\${'event-'+index},'thread','a',\${index+1},\${type},${JSON.stringify(time)},'provider',\${JSON.stringify(payload)},'{}')\x60;
          }
        }
        const entered = yield* Deferred.make();
        const decide = () => Effect.gen(function* () {
          calls++;
          if (first && calls === 2) { yield* Deferred.succeed(entered, undefined); yield* Effect.never; }
          return {status:'fallback',reason:'unavailable',retainInformation:true};
        });
        const service = RetentionClassificationLive.pipe(Layer.provide(SummaryStoreRepositoryLive), Layer.provide(Layer.succeed(DecisionEngine,{decide})));
        const drain = Effect.gen(function* () { yield* (yield* RetentionClassification).drain; }).pipe(Effect.provide(service));
        if (first) {
          const fiber = yield* Effect.forkChild(drain);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
        } else { yield* drain; }
        const rows = yield* sql\x60SELECT COUNT(*) AS count FROM summary_candidates\x60;
        if (rows[0].count !== (first ? 2 : 6)) throw new Error('Candidate count after restart');
        if (!first && calls !== 2) throw new Error('Committed section was replayed or a range was skipped');
      }).pipe(Effect.provide(BunSqlite.layer({filename:process.argv[1]}))));
    `;
    try {
      for (const phase of ["first", "restart"])
        await runProcess("bun", ["--eval", script, join(directory, "state.sqlite"), phase], {
          timeoutMs: 30_000,
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("classifies successful coding turns once, leaves failed/interrupted and streaming-only sources untouched", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* message("streaming", "not settled", "turn-1", "a", true);
        yield* message("settled", "Architecture fact");
        yield* drain();
        expect(yield* candidates).toEqual([]);
        yield* terminal();
        yield* terminal("duplicate");
        yield* message("failed-output", "partial", "failed");
        yield* terminal("failure", "failed", "failed");
        yield* message("interrupted-output", "partial", "interrupted");
        yield* terminal("interruption", "cancelled", "interrupted");
        const seen: unknown[] = [];
        yield* drain((state) =>
          Effect.sync(() => {
            seen.push(state);
            return advice("retain");
          }),
        );
        expect(seen).toEqual([{ source: JSON.stringify("Architecture fact") }]);
        const saved = yield* candidates;
        expect(saved.map((c) => c.scope.kind).toSorted()).toEqual(["chat", "project"]);
        expect(
          saved.every(
            (c) =>
              c.decision === "retain" && c.category === "architecture" && c.state === "pending",
          ),
        ).toBe(true);
        expect(
          saved.every((c) => c.sources[0]?.kind === "event" && c.sources[0].eventId === "settled"),
        ).toBe(true);
        yield* drain(() => Effect.die("completed sources must not be classified again"));
      }),
    );
  });

  it("covers bounded Unicode sections without changing the source, including discard and uncertain decisions", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const text = "😀".repeat(4_001) + "end";
        yield* message("large", text);
        yield* terminal();
        const sections: string[] = [];
        yield* drain((state) =>
          Effect.sync(() => {
            sections.push((state as { source: string }).source);
            return sections.length === 1
              ? advice("discard", "other")
              : advice("uncertain", "unresolved");
          }),
        );
        expect(sections.map((s) => Array.from(s).length)).toEqual([4_000, 6]);
        expect(JSON.parse(sections.join(""))).toBe(text);
        const saved = yield* candidates;
        expect(saved.filter((c) => c.state === "discarded")).toHaveLength(2);
        expect(
          saved.filter((c) => c.decision === "uncertain" && c.state === "pending"),
        ).toHaveLength(2);
        const sql = yield* SqlClient.SqlClient;
        const raw = yield* sql<{
          text: string;
        }>`SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_events WHERE event_id = 'large'`;
        expect(raw[0]?.text).toBe(text);
        const ranges = yield* sql<{
          start: number;
          end: number;
        }>`SELECT start_offset AS start, end_offset AS end FROM retention_sections ORDER BY start_offset`;
        expect(ranges).toEqual([
          { start: 0, end: 4_000 },
          { start: 0, end: 4_000 },
          { start: 4_000, end: 4_006 },
          { start: 4_000, end: 4_006 },
        ]);
      }),
    );
  });

  it("includes text after an embedded NUL in a provider message", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* message("nul", "before\u0000tail");
        yield* terminal();
        const seen: string[] = [];
        yield* drain((state) =>
          Effect.sync(() => {
            seen.push((state as { source: string }).source);
            return fallback;
          }),
        );
        expect(seen.join("")).toContain("tail");
      }),
    );
  });

  it("retains pending candidates on an outage and resumes only uncommitted sections after interruption", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* message("large", "a".repeat(8_001));
        yield* terminal();
        const entered = yield* Deferred.make<void>();
        let calls = 0;
        const fiber = yield* Effect.forkChild(
          drain(() =>
            Effect.gen(function* () {
              calls++;
              if (calls === 2) {
                yield* Deferred.succeed(entered, undefined);
                yield* Effect.never;
              }
              return fallback;
            }),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(yield* candidates).toHaveLength(2);
        const resumed: string[] = [];
        // Rebuild the service/lock against the same durable database, as on restart.
        yield* drain((state) =>
          Effect.sync(() => {
            resumed.push((state as { source: string }).source);
            return fallback;
          }),
        );
        expect(resumed.map((s) => s.length)).toEqual([4_000, 3]);
        const saved = yield* candidates;
        expect(saved).toHaveLength(6);
        expect(
          saved.every(
            (c) =>
              c.state === "pending" &&
              c.decision === "uncertain" &&
              c.classifier.name === "conservative-fallback",
          ),
        ).toBe(true);
      }),
    );
  });

  it("rolls back both scope candidates and the source position when a database write fails", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* message("fact", "A retained fact");
        yield* terminal();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_chat_candidate BEFORE INSERT ON summary_candidates
        WHEN json_extract(NEW.record_json, '$.scope.kind') = 'chat' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`;
        const failed = yield* Effect.result(drain());
        expect(failed._tag).toBe("Failure");
        expect(yield* candidates).toEqual([]);
        const jobs = yield* sql<{
          sequence: number;
          offset: number;
        }>`SELECT source_sequence AS sequence, source_offset AS offset FROM retention_jobs`;
        expect(jobs).toEqual([{ sequence: 0, offset: 0 }]);
        yield* sql`DROP TRIGGER fail_chat_candidate`;
        yield* drain();
        expect(yield* candidates).toHaveLength(2);
      }),
    );
  });

  it("always retains explicit objective/status changes for the chat without consulting Clef", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* append("objective", "thread.meta-updated", {
          threadId: "a",
          goal: "Ship parser",
          updatedAt: time,
        });
        yield* append("status", "thread.meta-updated", {
          threadId: "a",
          goalPausedAt: time,
          updatedAt: time,
        });
        yield* append("unrelated", "thread.meta-updated", {
          threadId: "a",
          title: "Renamed",
          updatedAt: time,
        });
        yield* drain(() => Effect.die("explicit changes cannot be discarded by a model"));
        const saved = yield* candidates;
        expect(saved.map((c) => c.reason).toSorted()).toEqual([
          "objective-change",
          "status-change",
        ]);
        expect(
          saved.every(
            (c) => c.decision === "retain" && c.state === "pending" && c.scope.kind === "chat",
          ),
        ).toBe(true);
      }),
    );
  });

  it("retains completed tool output and goal removal, without spawning maintenance turns", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* append("tool", "thread.activity-appended", {
          threadId: "a",
          activity: {
            id: "tool",
            kind: "tool.completed",
            summary: "Tests",
            tone: "tool",
            turnId: "turn-1",
            createdAt: time,
            payload: { output: "Tests passed", status: "completed" },
          },
        });
        yield* terminal();
        yield* append("clear-goal", "thread.meta-updated", {
          threadId: "a",
          goal: "",
          goalPausedAt: null,
          updatedAt: time,
        });
        yield* drain();
        expect(yield* candidates).toHaveLength(3);
        const sql = yield* SqlClient.SqlClient;
        const receipts = yield* sql<{
          field: string;
        }>`SELECT field FROM retention_sections ORDER BY field`;
        expect(receipts.map((r) => r.field)).toEqual([
          "explicit-change",
          "tool-payload",
          "tool-payload",
        ]);
        const events = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events`;
        expect(events[0]?.count).toBe(3);
      }),
    );
  });

  it.each(["rollback", "relocation", "deletion"])(
    "fences in-flight results after %s",
    async (change) => {
      await run(
        Effect.gen(function* () {
          yield* seed;
          yield* message("fact", "Prior workspace fact");
          yield* terminal();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            drain(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return advice("retain");
              }),
            ),
          );
          yield* Deferred.await(entered);
          const sql = yield* SqlClient.SqlClient;
          if (change === "rollback")
            yield* append("rollback", "thread.conversation-rolled-back", {
              threadId: "a",
              messageId: "fact",
              numTurns: 1,
            });
          else if (change === "relocation")
            yield* sql`UPDATE projection_projects SET workspace_root = '/work/moved' WHERE project_id = 'p'`;
          else yield* sql`UPDATE projection_threads SET deleted_at = ${time} WHERE thread_id = 'a'`;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          expect(yield* candidates).toEqual([]);
        }),
      );
    },
  );

  it("picks up late settled sources without reclassifying the completed range or another chat", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* message("first", "first");
        yield* terminal();
        yield* drain();
        yield* message("late", "late");
        yield* message("other-chat", "private other chat", "turn-1", "b");
        const seen: unknown[] = [];
        yield* drain((state) =>
          Effect.sync(() => {
            seen.push(state);
            return fallback;
          }),
        );
        expect(seen).toEqual([{ source: JSON.stringify("late") }]);
        expect(yield* candidates).toHaveLength(4);
        const sql = yield* SqlClient.SqlClient;
        yield* purgeThreadNativeArchive(sql, "a");
        expect(yield* candidates).toEqual([]);
        expect(yield* sql`SELECT * FROM retention_jobs`).toEqual([]);
        expect(yield* sql`SELECT * FROM retention_sections`).toEqual([]);
      }),
    );
  });

  it("backfills old boundaries idempotently and rejects pre-rollback work", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER retention_completed_turn`;
        yield* sql`DROP TRIGGER retention_explicit_change`;
        yield* message("old", "old");
        yield* terminal();
        yield* terminal("duplicate");
        yield* append("rollback", "thread.conversation-rolled-back", {
          threadId: "a",
          messageId: "old",
          numTurns: 1,
        });
        yield* message("new", "new", "turn-2");
        yield* terminal("new-terminal", "completed", "turn-2");
        yield* append("goal", "thread.meta-updated", {
          threadId: "a",
          goal: "New objective",
          updatedAt: time,
        });
        yield* Migration147;
        yield* Migration147;
        const seen: unknown[] = [];
        yield* drain((state) =>
          Effect.sync(() => {
            seen.push(state);
            return fallback;
          }),
        );
        expect(seen).toEqual([{ source: JSON.stringify("new") }]);
        expect(yield* candidates).toHaveLength(3);
        yield* Migration147;
        yield* drain(() => Effect.die("migration replay must preserve the checkpoint"));
      }),
    );
  });
});
