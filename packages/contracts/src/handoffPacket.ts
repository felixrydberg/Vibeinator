import { Schema } from "effect";
import { MessageId, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas";
import {
  DurableSha256,
  DurableSummaryRevision,
  InformationWatermark,
  ObjectiveRevisionId,
  SummaryRevisionId,
} from "./durableInformation";

const CharCount = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const HandoffSummaryRefresh = Schema.Literals([
  "current",
  "stale",
  "failed",
  "unavailable",
  "not-requested",
]);
const SummaryInput = Schema.Struct({
  revision: Schema.NullOr(DurableSummaryRevision),
  refresh: HandoffSummaryRefresh,
});
export const HandoffPacketMessage = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});
export const BuildHandoffPacketInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  sourceWatermark: InformationWatermark,
  projectSummary: SummaryInput,
  chatSummary: SummaryInput,
  objective: Schema.NullOr(
    Schema.Struct({
      revisionId: Schema.NullOr(ObjectiveRevisionId),
      text: Schema.String,
      status: Schema.NullOr(Schema.Literals(["active", "paused", "blocked", "completed"])),
    }),
  ),
  /** Settled prior messages in authoritative chronological order; excludes the current request. */
  recentMessages: Schema.Array(HandoffPacketMessage),
  /** Earlier messages excluded by the snapshot loader, before this candidate window. */
  earlierMessageCount: CharCount,
  currentRequest: Schema.String,
  maxInputChars: CharCount,
  /** Actual provider prompts, other send-time additions and safety margin, outside this packet. */
  reservedChars: CharCount,
  unsummarizedSources: CharCount,
});
export type BuildHandoffPacketInput = typeof BuildHandoffPacketInput.Type;

const FragmentFields = { text: Schema.String, retainedChars: CharCount, originalChars: CharCount };
const SummaryFragment = Schema.Struct({
  ...FragmentFields,
  revisionId: Schema.NullOr(SummaryRevisionId),
  refresh: Schema.Literals(["current", "empty", "stale", "failed", "unavailable", "not-requested"]),
  processedThrough: Schema.NullOr(InformationWatermark),
});
export const PreparedHandoffPacket = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectId: ProjectId,
  threadId: ThreadId,
  sourceWatermark: InformationWatermark,
  currentRequest: Schema.String,
  status: Schema.Literals(["ready", "insufficient-budget"]),
  reason: Schema.NullOr(Schema.Literals(["request-budget", "metadata-budget"])),
  contextText: Schema.String,
  dispatchText: Schema.NullOr(Schema.String),
  sha256: DurableSha256,
  limits: Schema.Struct({
    recentMessages: CharCount,
    recentChars: CharCount,
    summaryChars: CharCount,
    objectiveChars: CharCount,
    maxInputChars: CharCount,
    reservedChars: CharCount,
  }),
  projectSummary: SummaryFragment,
  chatSummary: SummaryFragment,
  objective: Schema.NullOr(
    Schema.Struct({
      ...FragmentFields,
      revisionId: Schema.NullOr(ObjectiveRevisionId),
      status: Schema.NullOr(Schema.Literals(["active", "paused", "blocked", "completed"])),
    }),
  ),
  recentMessages: Schema.Array(
    Schema.Struct({
      ...HandoffPacketMessage.fields,
      retainedChars: CharCount,
      originalChars: CharCount,
    }),
  ),
  omissions: Schema.Struct({
    messageCount: CharCount,
    shortenedMessages: CharCount,
    unsummarizedSources: CharCount,
    summaryChars: CharCount,
    objectiveChars: CharCount,
  }),
}).check(
  Schema.makeFilter(
    (packet) =>
      (packet.status === "ready"
        ? packet.reason === null &&
          packet.dispatchText !== null &&
          packet.dispatchText.length + packet.limits.reservedChars <= packet.limits.maxInputChars
        : packet.reason !== null &&
          packet.dispatchText === null &&
          packet.contextText.length === 0) &&
      packet.recentMessages.length <= packet.limits.recentMessages &&
      packet.recentMessages.reduce((total, message) => total + message.text.length, 0) <=
        packet.limits.recentChars &&
      packet.recentMessages.every(
        (message) =>
          message.threadId === packet.threadId && message.retainedChars <= message.originalChars,
      ) &&
      new Set(packet.recentMessages.map((message) => message.messageId)).size ===
        packet.recentMessages.length &&
      packet.projectSummary.text.length <= packet.limits.summaryChars &&
      packet.chatSummary.text.length <= packet.limits.summaryChars &&
      (packet.objective === null || packet.objective.text.length <= packet.limits.objectiveChars),
  ),
);
export type PreparedHandoffPacket = typeof PreparedHandoffPacket.Type;
