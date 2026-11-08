import type { OrchestrationThread, PreparedHandoffPacket } from "@synara/contracts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SummaryStoreRepository } from "../persistence/Services/SummaryStore.ts";
import { protectArchive } from "../persistence/Layers/NativeArchive.ts";
import { buildHandoffPacket } from "./handoffPacket.ts";
import { listPriorTranscriptMessages } from "./handoff.ts";

/** Capture services once: dispatch fibers do not inherit the layer-construction environment. */
export const makeHandoffContextLoader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const summaries = yield* SummaryStoreRepository;
  return (input: {
    readonly thread: Omit<OrchestrationThread, "activities">;
    readonly boundaryMessageId: string | undefined;
    readonly currentRequest: string;
    readonly reservedChars: number;
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const { thread } = input;
          const projectSummary = yield* summaries.get({
            kind: "project",
            projectId: thread.projectId,
          });
          const chatSummary = yield* summaries.get({
            kind: "chat",
            projectId: thread.projectId,
            threadId: thread.id,
          });
          const watermarks = yield* sql<{
            orchestrationSequence: number;
            captureSequence: number;
          }>`SELECT
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'), 0) AS "orchestrationSequence",
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'native_captures'), 0) AS "captureSequence"`;
          const through = chatSummary.current?.processedThrough;
          // Count real uncovered chat sources, never gaps in globally allocated sequence numbers.
          const counts = yield* sql<{ count: number }>`SELECT
      (SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${thread.id}
        AND sequence > ${through?.orchestrationSequence ?? 0}) +
      (SELECT COUNT(*) FROM native_captures WHERE project_id = ${thread.projectId} AND thread_id = ${thread.id}
        AND capture_sequence > ${through?.captureSequence ?? 0}) AS count`;
          const messages = listPriorTranscriptMessages(thread, input.boundaryMessageId);
          const packet: PreparedHandoffPacket = yield* Effect.try({
            try: () =>
              buildHandoffPacket({
                projectId: thread.projectId,
                threadId: thread.id,
                sourceWatermark: watermarks[0]!,
                projectSummary: {
                  revision: projectSummary.current,
                  refresh: projectSummary.current ? "stale" : "unavailable",
                },
                chatSummary: {
                  revision: chatSummary.current,
                  refresh: chatSummary.current ? "stale" : "unavailable",
                },
                objective: thread.goal?.trim()
                  ? {
                      revisionId: null,
                      text: thread.goal,
                      status: thread.goalPausedAt ? "paused" : "active",
                    }
                  : null,
                recentMessages: messages.slice(-12).map((message) => ({
                  threadId: thread.id,
                  messageId: message.id,
                  role: message.role === "assistant" ? "assistant" : "user",
                  text: message.text,
                })),
                earlierMessageCount: Math.max(0, messages.length - 12),
                currentRequest: input.currentRequest,
                maxInputChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
                reservedChars: input.reservedChars,
                unsummarizedSources: counts[0]!.count,
              }),
            catch: () => new Error("Invalid handoff context input."),
          });
          return packet;
        }),
      )
      .pipe(protectArchive("HandoffContext.load"));
});
