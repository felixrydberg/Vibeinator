import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { EventId, ProjectId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { buildHandoffPacket } from "../../orchestration/handoffPacket.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import Migration146 from "../Migrations/146_DurableHandoffDispatch.ts";
import { HandoffStore } from "../Services/HandoffStore.ts";
import { NativeArchiveRepository } from "../Services/NativeArchive.ts";
import { ProviderRuntimeEventRepository } from "../Services/ProviderRuntimeEvents.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../Services/OrchestrationEventDeliveries.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "./OrchestrationEventDeliveries.ts";
import { HandoffStoreLive } from "./HandoffStore.ts";
import { NativeArchiveRepositoryLive } from "./NativeArchive.ts";
import { ProviderRuntimeEventRepositoryLive } from "./ProviderRuntimeEvents.ts";
import { purgeThreadNativeArchive } from "../nativeArchivePurge.ts";

const time = "2026-11-08T12:00:00.000Z";
const scope = { projectId: ProjectId.makeUnsafe("p"), threadId: ThreadId.makeUnsafe("a") };
const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('p', 'Fixture', '/work/p', '[]', ${time}, ${time})`;
  for (const id of ["a", "b"])
    yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
    VALUES (${id}, 'p', 'Fixture', ${time}, ${time})`;
  yield* sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json)
    VALUES ('request', 'thread', 'a', 1, 'thread.turn-start-requested', ${time}, 'command-a', 'user', '{}', '{}')`;
});
const preparation = () =>
  buildHandoffPacket({
    ...scope,
    sourceWatermark: { orchestrationSequence: 1, captureSequence: 0 },
    projectSummary: { revision: null, refresh: "unavailable" },
    chatSummary: { revision: null, refresh: "unavailable" },
    objective: null,
    recentMessages: [],
    earlierMessageCount: 0,
    currentRequest: "Continue 🦊 exactly.\n",
    maxInputChars: 120_000,
    reservedChars: 2000,
    unsummarizedSources: 1,
  });
const dispatch = (prepared = preparation()) => ({
  threadId: scope.threadId,
  input: `project preamble\n${prepared.dispatchText}\n<skill>exact injected instruction</skill>`,
  modelSelection: { provider: "claudeAgent" as const, model: "fixture-model" },
});
const prepare = (generation = "generation-1") =>
  Effect.gen(function* () {
    const store = yield* HandoffStore;
    return yield* store.prepare({
      prepared: preparation(),
      eventSequence: 1,
      reason: "handoff",
      provider: "claudeAgent",
      providerInstanceId: "claude-instance",
      lifecycleGeneration: generation,
      dispatchInput: dispatch(),
    });
  });
const terminal = (
  id: string,
  overrides: Partial<ProviderRuntimeEvent> = {},
): ProviderRuntimeEvent =>
  ({
    type: "turn.completed",
    eventId: EventId.makeUnsafe(id),
    provider: "claudeAgent",
    providerInstanceId: "claude-instance",
    lifecycleGeneration: "generation-1",
    threadId: scope.threadId,
    turnId: TurnId.makeUnsafe("turn-1"),
    payload: { state: "completed" },
    createdAt: time,
    ...overrides,
  }) as ProviderRuntimeEvent;
type Services =
  | SqlClient.SqlClient
  | HandoffStore
  | NativeArchiveRepository
  | ProviderRuntimeEventRepository
  | OrchestrationEventDeliveryRepository;
const run = <A, E>(program: Effect.Effect<A, E, Services>, filename?: string) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(HandoffStoreLive),
      Effect.provide(NativeArchiveRepositoryLive),
      Effect.provide(ProviderRuntimeEventRepositoryLive),
      Effect.provide(OrchestrationEventDeliveryRepositoryLive),
      Effect.provide(
        filename ? NodeSqliteClient.layer({ filename }) : NodeSqliteClient.layerMemory(),
      ),
    ),
  );

describe("durable handoff dispatch", () => {
  it("attaches explicit delivery reconciliation to the latest dispatch attempt without rewriting earlier failed packets", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const deliveries = yield* OrchestrationEventDeliveryRepository;
        const store = yield* HandoffStore;
        const key = {
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: 1,
          threadId: scope.threadId,
        };
        yield* deliveries.claim({
          ...key,
          claimOwner: "worker",
          claimedAt: time,
          claimExpiresAt: "2026-11-08T12:01:00.000Z",
        });
        const first = yield* prepare();
        yield* store.recordFailure(first);
        const last = yield* prepare("generation-2");
        yield* deliveries.markTerminalFailure({
          ...key,
          expectedClaimOwner: "worker",
          state: "uncertain",
          error: "lost acknowledgement",
          updatedAt: time,
        });
        yield* deliveries.reconcile({
          ...key,
          reconciliationId: "reconciliation",
          expectedState: "uncertain",
          outcome: "accepted",
          reconciledBy: "operator",
          reconciledAt: time,
        });
        expect(
          (yield* store.get(scope, first))?.outcomes.map((entry) => entry.outcome).toSorted(),
        ).toEqual(["failed", "uncertain"]);
        expect(
          (yield* store.get(scope, last))?.outcomes.map((entry) => entry.outcome).toSorted(),
        ).toEqual(["accepted", "uncertain"]);
      }),
    );
  });
  it("retains exact final bytes and uncertainty across reopen, then accepts an early terminal and survives journal pruning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-handoff-"));
    const filename = join(directory, "state.sqlite");
    try {
      const packetId = await run(
        Effect.gen(function* () {
          yield* seed;
          const packetId = yield* prepare();
          const events = yield* ProviderRuntimeEventRepository;
          yield* events.append(terminal("early-terminal"));
          return packetId;
        }),
        filename,
      );
      await run(
        Effect.gen(function* () {
          const store = yield* HandoffStore;
          const archive = yield* NativeArchiveRepository;
          const saved = yield* store.get(scope, packetId);
          expect(saved?.outcomes.map((entry) => entry.outcome)).toEqual(["uncertain"]);
          const chunks = yield* archive
            .streamPayload({ ...scope, payloadId: saved!.packet.dispatchInput.payloadId })
            .pipe(Stream.runCollect);
          const bytes = Buffer.concat([...chunks].map((chunk) => Buffer.from(chunk)));
          expect(JSON.parse(bytes.toString("utf8"))).toEqual(dispatch());
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            saved!.packet.dispatchInput.sha256,
          );
          expect(saved?.packet.target).toMatchObject({
            provider: "claudeAgent",
            providerInstanceId: "claude-instance",
            lifecycleGeneration: "generation-1",
          });
          yield* store.recordTurn(packetId, TurnId.makeUnsafe("turn-1"), false);
          const accepted = yield* store.get(scope, packetId);
          // Provider timestamps can precede preparation; evidence order follows durable append order.
          expect(accepted?.outcomes.map((entry) => entry.outcome)).toEqual([
            "uncertain",
            "accepted",
          ]);
          expect(
            accepted?.outcomes.every(
              (entry) => entry.commandId === "command-a" && entry.attempt === 1,
            ),
          ).toBe(true);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM provider_runtime_events`;
          yield* Migration146;
          expect(yield* store.get(scope, packetId)).toEqual(accepted);
          expect((yield* store.get(scope, packetId))?.packet).toEqual(saved?.packet);
        }),
        filename,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("only matching successful terminals accept an enqueued input, including terminals arriving after its receipt", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* HandoffStore;
        const events = yield* ProviderRuntimeEventRepository;
        const packetId = yield* prepare();
        yield* store.recordTurn(packetId, TurnId.makeUnsafe("turn-1"), false);
        const mismatches = [
          { lifecycleGeneration: "later-generation" },
          { providerInstanceId: "another-instance" },
          { provider: "codex" as const },
          { turnId: TurnId.makeUnsafe("other-turn") },
          { threadId: ThreadId.makeUnsafe("b") },
          { payload: { state: "failed" as const } },
          { providerInstanceId: undefined },
        ];
        for (const [index, override] of mismatches.entries())
          yield* events.append(terminal(`foreign-${index}`, override));
        expect((yield* store.get(scope, packetId))?.outcomes.map((entry) => entry.outcome)).toEqual(
          ["uncertain"],
        );
        yield* events.append(terminal("matching"));
        yield* events.append(terminal("matching"));
        expect(
          (yield* store.get(scope, packetId))?.outcomes.filter(
            (entry) => entry.outcome === "accepted",
          ),
        ).toHaveLength(1);
        expect(
          yield* store.get({ ...scope, threadId: ThreadId.makeUnsafe("b") }, packetId),
        ).toBeNull();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET deleted_at = ${time} WHERE thread_id = 'a'`;
        expect((yield* store.get(scope, packetId).pipe(Effect.result))._tag).toBe("Failure");
      }),
    );
  });

  it("rolls preparation back atomically, rejects mismatched content, and purges derived copies with their search entries", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* HandoffStore;
        const input = {
          prepared: preparation(),
          eventSequence: 1,
          reason: "handoff" as const,
          provider: "claudeAgent" as const,
          providerInstanceId: "claude-instance",
          lifecycleGeneration: "generation-1",
          dispatchInput: dispatch(),
        };
        expect(
          (yield* store
            .prepare({ ...input, prepared: { ...input.prepared, currentRequest: "tampered" } })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* sql`CREATE TRIGGER reject_handoff BEFORE INSERT ON handoff_packets BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
        expect((yield* store.prepare(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM durable_payloads`)[0]?.count,
        ).toBe(0);
        yield* sql`DROP TRIGGER reject_handoff`;
        const packetId = yield* store.prepare(input);
        yield* store.recordFailure(packetId);
        expect(
          (yield* store.get(scope, packetId))?.outcomes.map((entry) => entry.outcome).toSorted(),
        ).toEqual(["failed", "uncertain"]);
        yield* sql.withTransaction(purgeThreadNativeArchive(sql, "b"));
        expect(yield* store.get(scope, packetId)).toBeNull();
        expect(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM durable_payloads`)[0]?.count,
        ).toBe(0);
        expect(
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM history_documents WHERE source_kind = 'payload'`)[0]
            ?.count,
        ).toBe(0);
      }),
    );
  });
});
