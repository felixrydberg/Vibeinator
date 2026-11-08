import { createHash, randomUUID } from "node:crypto";
import {
  DurableHandoffOutcome,
  DurableHandoffPacket,
  HandoffPacketId,
  PreparedHandoffPacket,
  ProviderSendTurnInput,
} from "@synara/contracts";
import { stableJsonStringify } from "@synara/shared/canonicalJson";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  NativeArchiveRepository,
  NativeArchiveError,
  type ArchiveScope,
} from "../Services/NativeArchive.ts";
import { NativeArchiveRepositoryLive, protectArchive } from "./NativeArchive.ts";
import { HandoffStore, type HandoffStoreShape } from "../Services/HandoffStore.ts";

const invalid = () =>
  new NativeArchiveError({ operation: "HandoffStore", reason: "invalid-input" });
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));

export const makeHandoffStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const archive = yield* NativeArchiveRepository;
  const owner = (scope: ArchiveScope) =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT 1 FROM projection_threads AS thread JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.thread_id = ${scope.threadId} AND thread.project_id = ${scope.projectId}
        AND thread.deleted_at IS NULL AND project.deleted_at IS NULL`;
      if (!rows.length)
        return yield* new NativeArchiveError({ operation: "HandoffStore", reason: "ownership" });
    });
  const outcome = (packetId: HandoffPacketId, value: "accepted" | "failed") =>
    sql`INSERT OR IGNORE INTO handoff_outcomes(packet_id, outcome, occurred_at) VALUES (${packetId}, ${value}, ${new Date().toISOString()})`.pipe(
      Effect.asVoid,
    );
  const prepare: HandoffStoreShape["prepare"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const prepared = yield* decode(PreparedHandoffPacket, input.prepared);
          const dispatch = yield* decode(ProviderSendTurnInput, input.dispatchInput);
          const { sha256, ...content } = prepared;
          if (
            prepared.status !== "ready" ||
            dispatch.threadId !== prepared.threadId ||
            !dispatch.modelSelection ||
            dispatch.modelSelection.provider !== input.provider ||
            (input.dispatchInput.modelSelection?.instanceId !== undefined &&
              input.dispatchInput.modelSelection.instanceId !== input.providerInstanceId) ||
            !input.lifecycleGeneration ||
            !Number.isSafeInteger(input.eventSequence) ||
            input.eventSequence <= 0 ||
            createHash("sha256").update(stableJsonStringify(content)).digest("hex") !== sha256
          )
            return yield* invalid();
          yield* owner(prepared);
          const events = yield* sql<{
            commandId: string | null;
            attempt: number;
          }>`SELECT event.command_id AS "commandId",
      COALESCE(delivery.attempt_count, 1) AS attempt FROM orchestration_events AS event
      LEFT JOIN orchestration_event_deliveries AS delivery ON delivery.event_sequence = event.sequence
        AND delivery.consumer_name = 'provider-command-reactor.v1'
      WHERE event.sequence = ${input.eventSequence} AND event.aggregate_kind = 'thread' AND event.stream_id = ${prepared.threadId}`;
          if (!events[0]) return yield* invalid();
          const packetId = HandoffPacketId.makeUnsafe(randomUUID());
          const assembledContext = yield* archive.appendPayload({
            ...prepared,
            payloadKey: `handoff:${packetId}:context`,
            content: { encoding: "utf8-text", text: prepared.contextText },
          });
          const dispatchInput = yield* archive.appendPayload({
            ...prepared,
            payloadKey: `handoff:${packetId}:dispatch`,
            content: { encoding: "utf8-json", text: stableJsonStringify(input.dispatchInput) },
          });
          const packet = yield* decode(DurableHandoffPacket, {
            schemaVersion: 1,
            packetId,
            projectId: prepared.projectId,
            threadId: prepared.threadId,
            target: {
              provider: input.provider,
              providerInstanceId: input.providerInstanceId,
              // This identifies the service-owned logical runtime, independent of adapter-native session/capture IDs.
              runtimeSessionId: `service:${input.lifecycleGeneration}`,
              lifecycleGeneration: input.lifecycleGeneration,
            },
            targetModel: dispatch.modelSelection.model,
            sourceWatermark: prepared.sourceWatermark,
            projectSummaryRevisionId: prepared.projectSummary.revisionId,
            chatSummaryRevisionId: prepared.chatSummary.revisionId,
            objectiveRevisionId: prepared.objective?.revisionId ?? null,
            recentMessages: prepared.recentMessages.map(({ threadId, messageId }) => ({
              threadId,
              messageId,
            })),
            limits: {
              recentMessages: prepared.limits.recentMessages,
              recentChars: prepared.limits.recentChars,
              summaryChars: prepared.limits.summaryChars,
              dispatchChars: prepared.limits.maxInputChars,
              reservedChars: prepared.limits.reservedChars,
            },
            omissions: {
              messageCount: prepared.omissions.messageCount,
              unsummarizedSources: prepared.omissions.unsummarizedSources,
              summaryRefresh: [
                prepared.projectSummary.refresh,
                prepared.chatSummary.refresh,
              ].includes("failed")
                ? "failed"
                : [prepared.projectSummary.refresh, prepared.chatSummary.refresh].every(
                      (state) => state === "current" || state === "empty",
                    )
                  ? "current"
                  : "unavailable",
            },
            assembledContext,
            dispatchInput,
            createdAt: new Date().toISOString(),
          });
          const commandId = events[0].commandId ?? `server:handoff-event:${input.eventSequence}`;
          yield* sql`INSERT INTO handoff_packets(packet_id, project_id, thread_id, event_sequence, command_id, attempt, provider,
      provider_instance_id, lifecycle_generation, reason, record_json, prepared_json)
      VALUES (${packetId}, ${prepared.projectId}, ${prepared.threadId}, ${input.eventSequence}, ${commandId}, ${events[0].attempt},
        ${input.provider}, ${input.providerInstanceId}, ${input.lifecycleGeneration}, ${input.reason}, ${stableJsonStringify(packet)}, ${stableJsonStringify(prepared)})`;
          // Commit uncertainty BEFORE entering the adapter; a crash cannot manufacture a safe retry.
          yield* sql`INSERT INTO handoff_outcomes(packet_id, outcome, occurred_at) VALUES (${packetId}, 'uncertain', ${packet.createdAt})`;
          return packetId;
        }),
      )
      .pipe(protectArchive("HandoffStore.prepare"));
  const recordTurn: HandoffStoreShape["recordTurn"] = (packetId, turnId, acknowledged) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO handoff_dispatch_receipts(packet_id, turn_id, recorded_at)
      VALUES (${packetId}, ${turnId}, ${new Date().toISOString()}) ON CONFLICT(packet_id) DO NOTHING`;
          const rows = yield* sql<{
            turnId: string;
          }>`SELECT turn_id AS "turnId" FROM handoff_dispatch_receipts WHERE packet_id = ${packetId}`;
          if (rows[0]?.turnId !== turnId) return yield* invalid();
          if (acknowledged) yield* outcome(packetId, "accepted");
        }),
      )
      .pipe(protectArchive("HandoffStore.recordTurn"));
  const get: HandoffStoreShape["get"] = (scope, packetId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* owner(scope);
          const rows = yield* sql<{
            record: string;
            prepared: string;
            eventSequence: number;
            reason: "handoff" | "recovery";
            commandId: string;
            attempt: number;
          }>`
      SELECT record_json AS record, prepared_json AS prepared, event_sequence AS "eventSequence", reason, command_id AS "commandId", attempt
      FROM handoff_packets WHERE packet_id = ${packetId} AND project_id = ${scope.projectId} AND thread_id = ${scope.threadId}`;
          if (!rows[0]) return null;
          const row = rows[0];
          const packet = yield* decode(Schema.fromJsonString(DurableHandoffPacket), row.record);
          const prepared = yield* decode(
            Schema.fromJsonString(PreparedHandoffPacket),
            row.prepared,
          );
          const { sha256, ...content } = prepared;
          if (
            packet.packetId !== packetId ||
            packet.projectId !== scope.projectId ||
            packet.threadId !== scope.threadId ||
            prepared.projectId !== scope.projectId ||
            prepared.threadId !== scope.threadId ||
            createHash("sha256").update(stableJsonStringify(content)).digest("hex") !== sha256
          )
            return yield* new NativeArchiveError({
              operation: "HandoffStore.get",
              reason: "integrity",
            });
          const receipts = yield* sql<{
            outcome: "accepted" | "failed" | "uncertain";
            occurredAt: string;
          }>`SELECT outcome, occurred_at AS "occurredAt"
      FROM handoff_outcomes WHERE packet_id = ${packetId} ORDER BY sequence`;
          return {
            packet,
            prepared,
            eventSequence: row.eventSequence,
            reason: row.reason,
            outcomes: yield* Effect.forEach(receipts, (receipt) =>
              decode(DurableHandoffOutcome, {
                ...receipt,
                packetId,
                commandId: row.commandId,
                attempt: row.attempt,
                nativeSessionId: null,
              }),
            ),
          };
        }),
      )
      .pipe(protectArchive("HandoffStore.get"));
  const prepareStart: HandoffStoreShape["prepareStart"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            projectId: string;
          }>`SELECT thread.project_id AS "projectId" FROM projection_threads AS thread JOIN projection_projects AS project ON project.project_id = thread.project_id
            JOIN orchestration_events AS event ON event.stream_id = thread.thread_id AND event.aggregate_kind = 'thread'
            WHERE thread.thread_id = ${input.threadId} AND event.sequence = ${input.eventSequence}
              AND thread.deleted_at IS NULL AND project.deleted_at IS NULL`;
          if (!rows[0]) return yield* invalid();
          const id = randomUUID();
          const createdAt = new Date().toISOString();
          yield* sql`INSERT INTO handoff_start_attempts VALUES (${id}, ${rows[0].projectId}, ${input.threadId}, ${input.eventSequence}, ${stableJsonStringify(input.source)}, ${stableJsonStringify(input.target)}, ${createdAt})`;
          yield* sql`INSERT INTO handoff_start_outcomes VALUES (${id}, 'uncertain', ${createdAt})`;
          return id;
        }),
      )
      .pipe(protectArchive("HandoffStore.prepareStart"));
  return {
    prepare,
    recordTurn,
    get,
    prepareStart,
    recordFailure: (packetId) =>
      outcome(packetId, "failed").pipe(protectArchive("HandoffStore.failure")),
    finishStart: (id, value) =>
      sql`INSERT OR IGNORE INTO handoff_start_outcomes VALUES (${id}, ${value}, ${new Date().toISOString()})`.pipe(
        Effect.asVoid,
        protectArchive("HandoffStore.finishStart"),
      ),
  } satisfies HandoffStoreShape;
});
export const HandoffStoreLive = Layer.effect(HandoffStore, makeHandoffStore).pipe(
  Layer.provide(NativeArchiveRepositoryLive),
);
