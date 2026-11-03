import { Schema } from "effect";

import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance";

// Version the stored envelope independently from the provider's open-ended payload type.
export const DURABLE_INFORMATION_VERSION = 1;
export const DURABLE_SUMMARY_MAX_CHARS = 8_000;
const Version = Schema.Literal(DURABLE_INFORMATION_VERSION);
const Id = Schema.String.check(Schema.isNonEmpty());
export const NativeCaptureId = Id.pipe(Schema.brand("NativeCaptureId"));
export type NativeCaptureId = typeof NativeCaptureId.Type;
export const DurablePayloadId = Id.pipe(Schema.brand("DurablePayloadId"));
export type DurablePayloadId = typeof DurablePayloadId.Type;
export const ObjectiveRevisionId = Id.pipe(Schema.brand("ObjectiveRevisionId"));
export type ObjectiveRevisionId = typeof ObjectiveRevisionId.Type;
export const SummaryRevisionId = Id.pipe(Schema.brand("SummaryRevisionId"));
export type SummaryRevisionId = typeof SummaryRevisionId.Type;
export const RetentionCandidateId = Id.pipe(Schema.brand("RetentionCandidateId"));
export type RetentionCandidateId = typeof RetentionCandidateId.Type;
export const HandoffPacketId = Id.pipe(Schema.brand("HandoffPacketId"));
export type HandoffPacketId = typeof HandoffPacketId.Type;
export const DurableSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const DurablePayloadDescriptor = Schema.Struct({
  payloadId: DurablePayloadId,
  encoding: Schema.Literals(["utf8-text", "utf8-json"]),
  byteLength: NonNegativeInt,
  chunkCount: PositiveInt,
  sha256: DurableSha256,
});
export type DurablePayloadDescriptor = typeof DurablePayloadDescriptor.Type;

// Bytes live in SQLite BLOBs. Offsets/hashes describe bytes, never JS string indices.
export const DurablePayloadChunk = Schema.Struct({
  payloadId: DurablePayloadId,
  index: NonNegativeInt,
  byteOffset: NonNegativeInt,
  byteLength: NonNegativeInt,
  sha256: DurableSha256,
});
export type DurablePayloadChunk = typeof DurablePayloadChunk.Type;

export const DurableProviderIdentity = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  runtimeSessionId: RuntimeSessionId,
  lifecycleGeneration: Id,
});
export type DurableProviderIdentity = typeof DurableProviderIdentity.Type;

export const NativeCaptureIdentity = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  session: DurableProviderIdentity,
  ingressOrdinal: PositiveInt,
});
export type NativeCaptureIdentity = typeof NativeCaptureIdentity.Type;

const CaptureFields = {
  schemaVersion: Version,
  captureId: NativeCaptureId,
  // Global archive sequence is independent of the prunable runtime journal sequence.
  captureSequence: PositiveInt,
  identity: NativeCaptureIdentity,
  nativeSessionId: Schema.NullOr(Id),
  nativeEventId: Schema.NullOr(Id),
  nativeItemId: Schema.NullOr(Id),
  nativeTurnId: Schema.NullOr(Id),
  payloadType: Id,
  direction: Schema.Literals(["incoming", "outgoing"]),
  observedAt: IsoDateTime,
  committedAt: IsoDateTime,
  capturePolicyVersion: PositiveInt,
};

export const NativeCapture = Schema.Union([
  Schema.Struct({
    ...CaptureFields,
    disposition: Schema.Literal("retained"),
    payload: DurablePayloadDescriptor,
  }),
  // Exclusions contain no payload, payload hash, secret field names, or free-form reason.
  Schema.Struct({
    ...CaptureFields,
    disposition: Schema.Literal("excluded"),
    reason: Schema.Literals(["authentication-exchange", "credential-material"]),
    payload: Schema.optional(Schema.Never),
  }),
]);
export type NativeCapture = typeof NativeCapture.Type;

export const NativeNormalizationLink = Schema.Struct({
  captureId: NativeCaptureId,
  eventId: EventId,
  eventSequence: PositiveInt,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  messageId: Schema.NullOr(MessageId),
});
export type NativeNormalizationLink = typeof NativeNormalizationLink.Type;

export const InformationScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("chat"), projectId: ProjectId, threadId: ThreadId }),
]);
export type InformationScope = typeof InformationScope.Type;

export const InformationWatermark = Schema.Struct({
  orchestrationSequence: NonNegativeInt,
  captureSequence: NonNegativeInt,
});
export type InformationWatermark = typeof InformationWatermark.Type;

export const DurableCaptureCoverage = Schema.Struct({
  schemaVersion: Version,
  projectId: ProjectId,
  threadId: ThreadId,
  coverage: Schema.Literals(["native-complete", "normalized-only", "unavailable"]),
  from: InformationWatermark,
  through: InformationWatermark,
  recordedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (value) =>
      value.through.orchestrationSequence >= value.from.orchestrationSequence &&
      value.through.captureSequence >= value.from.captureSequence,
  ),
);
export type DurableCaptureCoverage = typeof DurableCaptureCoverage.Type;

export const InformationSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("capture"),
    captureId: NativeCaptureId,
    byteRange: Schema.NullOr(
      Schema.Struct({ start: NonNegativeInt, end: PositiveInt }).check(
        Schema.makeFilter((range) => range.end > range.start),
      ),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("event"), eventId: EventId, sequence: PositiveInt }),
  Schema.Struct({ kind: Schema.Literal("objective"), revisionId: ObjectiveRevisionId }),
]);
export type InformationSource = typeof InformationSource.Type;

export const DurableObjectiveRevision = Schema.Struct({
  schemaVersion: Version,
  revisionId: ObjectiveRevisionId,
  projectId: ProjectId,
  threadId: ThreadId,
  revision: PositiveInt,
  previousRevisionId: Schema.NullOr(ObjectiveRevisionId),
  objective: DurablePayloadDescriptor,
  status: Schema.Literals(["active", "paused", "blocked", "completed"]),
  sources: Schema.Array(InformationSource),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (value) =>
      (value.revision === 1) === (value.previousRevisionId === null) &&
      value.previousRevisionId !== value.revisionId,
  ),
);
export type DurableObjectiveRevision = typeof DurableObjectiveRevision.Type;

export const DurableAttachmentReference = Schema.Struct({
  schemaVersion: Version,
  attachmentId: Id,
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: Schema.NullOr(MessageId),
  storage: Schema.Literal("managed-file"),
  originalName: Schema.String,
  mimeType: Schema.String,
  // Legacy attachments may lack integrity metadata; never invent a hash or byte count.
  byteLength: Schema.NullOr(NonNegativeInt),
  sha256: Schema.NullOr(DurableSha256),
  availability: Schema.Literals(["available", "missing", "expired", "deleted"]),
  createdAt: IsoDateTime,
});
export type DurableAttachmentReference = typeof DurableAttachmentReference.Type;

export const DurableRetentionCandidate = Schema.Struct({
  schemaVersion: Version,
  candidateId: RetentionCandidateId,
  scope: InformationScope,
  sources: Schema.Array(InformationSource).check(Schema.isNonEmpty()),
  sourceWatermark: InformationWatermark,
  category: TrimmedNonEmptyString,
  reason: Schema.Literals(["coding-turn", "objective-change", "status-change"]),
  decision: Schema.Literals(["retain", "uncertain", "discard"]),
  classifier: Schema.Struct({ name: Id, version: Id }),
  state: Schema.Literals(["pending", "consumed", "discarded"]),
  attemptCount: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  consumedByRevisionId: Schema.NullOr(SummaryRevisionId),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (value) =>
      (value.reason === "coding-turn" || value.decision === "retain") &&
      (value.state === "consumed") === (value.consumedByRevisionId !== null) &&
      (value.state !== "discarded" || value.decision === "discard") &&
      (value.decision !== "discard" || value.state === "discarded"),
  ),
);
export type DurableRetentionCandidate = typeof DurableRetentionCandidate.Type;

export const DurableSummaryRevision = Schema.Struct({
  schemaVersion: Version,
  revisionId: SummaryRevisionId,
  scope: InformationScope,
  revision: PositiveInt,
  previousRevisionId: Schema.NullOr(SummaryRevisionId),
  text: Schema.String.check(Schema.isMaxLength(DURABLE_SUMMARY_MAX_CHARS)),
  sources: Schema.Array(InformationSource),
  processedThrough: InformationWatermark,
  generation: Schema.NullOr(
    Schema.Struct({
      provider: ProviderDriverKind,
      providerInstanceId: ProviderInstanceId,
      model: Id,
    }),
  ),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (value) =>
      (value.revision === 1) === (value.previousRevisionId === null) &&
      value.previousRevisionId !== value.revisionId,
  ),
);
export type DurableSummaryRevision = typeof DurableSummaryRevision.Type;

export const DurableRecentMessage = Schema.Struct({ threadId: ThreadId, messageId: MessageId });

export const DurableHandoffPacket = Schema.Struct({
  schemaVersion: Version,
  packetId: HandoffPacketId,
  projectId: ProjectId,
  threadId: ThreadId,
  target: DurableProviderIdentity,
  targetModel: Id,
  sourceWatermark: InformationWatermark,
  projectSummaryRevisionId: Schema.NullOr(SummaryRevisionId),
  chatSummaryRevisionId: Schema.NullOr(SummaryRevisionId),
  objectiveRevisionId: Schema.NullOr(ObjectiveRevisionId),
  recentMessages: Schema.Array(DurableRecentMessage),
  limits: Schema.Struct({
    recentMessages: NonNegativeInt,
    recentChars: NonNegativeInt,
    summaryChars: NonNegativeInt,
    dispatchChars: PositiveInt,
    reservedChars: NonNegativeInt,
  }),
  omissions: Schema.Struct({
    messageCount: NonNegativeInt,
    unsummarizedSources: NonNegativeInt,
    summaryRefresh: Schema.Literals(["current", "failed", "unavailable", "not-requested"]),
  }),
  assembledContext: DurablePayloadDescriptor.check(
    Schema.makeFilter((value) => value.encoding === "utf8-text"),
  ),
  dispatchInput: DurablePayloadDescriptor.check(
    Schema.makeFilter((value) => value.encoding === "utf8-json"),
  ),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (value) =>
      value.recentMessages.length <= value.limits.recentMessages &&
      value.recentMessages.every((message) => message.threadId === value.threadId) &&
      new Set(value.recentMessages.map((message) => message.messageId)).size ===
        value.recentMessages.length &&
      value.limits.reservedChars < value.limits.dispatchChars,
  ),
);
export type DurableHandoffPacket = typeof DurableHandoffPacket.Type;

// Append outcomes separately: acceptance uncertainty must never rewrite a prepared packet.
export const DurableHandoffOutcome = Schema.Struct({
  packetId: HandoffPacketId,
  commandId: CommandId,
  attempt: PositiveInt,
  outcome: Schema.Literals(["accepted", "failed", "uncertain"]),
  nativeSessionId: Schema.NullOr(Id),
  occurredAt: IsoDateTime,
});
export type DurableHandoffOutcome = typeof DurableHandoffOutcome.Type;
