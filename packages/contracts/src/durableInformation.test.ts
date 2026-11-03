import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  DurableAttachmentReference,
  DurableCaptureCoverage,
  DurableHandoffOutcome,
  DurableHandoffPacket,
  DurableObjectiveRevision,
  DurablePayloadDescriptor,
  DurableRetentionCandidate,
  DurableSummaryRevision,
  InformationSource,
  NativeCapture,
  NativeCaptureIdentity,
  NativeNormalizationLink,
} from "./durableInformation";

const timestamp = "2026-11-03T00:00:00.000Z";
const payload = {
  payloadId: "payload-1",
  encoding: "utf8-text",
  byteLength: 200_000,
  chunkCount: 4,
  sha256: "a".repeat(64),
};
const session = {
  provider: "codex",
  providerInstanceId: "codex_work",
  runtimeSessionId: "runtime-1",
  lifecycleGeneration: "generation-1",
};
const identity = { projectId: "project-1", threadId: "thread-1", session, ingressOrdinal: 1 };
const watermark = { orchestrationSequence: 40, captureSequence: 51 };
const scope = { kind: "chat", projectId: "project-1", threadId: "thread-1" };
const source = { kind: "capture", captureId: "capture-1", byteRange: null };
const capture = {
  schemaVersion: 1,
  captureId: "capture-1",
  captureSequence: 51,
  identity,
  nativeSessionId: "reused-id",
  nativeEventId: "reused-id",
  nativeItemId: null,
  nativeTurnId: null,
  payloadType: "future.provider.event.v7",
  direction: "incoming",
  observedAt: timestamp,
  committedAt: timestamp,
  capturePolicyVersion: 1,
  disposition: "retained",
  payload,
};
const summary = {
  schemaVersion: 1,
  revisionId: "summary-1",
  scope,
  revision: 1,
  previousRevisionId: null,
  text: "",
  sources: [source],
  processedThrough: watermark,
  generation: null,
  createdAt: timestamp,
};
const candidate = {
  schemaVersion: 1,
  candidateId: "candidate-1",
  scope,
  sources: [source],
  sourceWatermark: watermark,
  category: "architecture",
  reason: "coding-turn",
  decision: "uncertain",
  classifier: { name: "clef", version: "1" },
  state: "pending",
  attemptCount: 0,
  nextAttemptAt: null,
  consumedByRevisionId: null,
  createdAt: timestamp,
};
const packet = {
  schemaVersion: 1,
  packetId: "packet-1",
  projectId: "project-1",
  threadId: "thread-1",
  target: session,
  targetModel: "provider-selected-model",
  sourceWatermark: watermark,
  projectSummaryRevisionId: null,
  chatSummaryRevisionId: "summary-1",
  objectiveRevisionId: null,
  recentMessages: [{ threadId: "thread-1", messageId: "message-1" }],
  limits: {
    recentMessages: 12,
    recentChars: 24_000,
    summaryChars: 8_000,
    dispatchChars: 48_000,
    reservedChars: 8_000,
  },
  omissions: { messageCount: 10, unsummarizedSources: 2, summaryRefresh: "failed" },
  assembledContext: payload,
  dispatchInput: { ...payload, encoding: "utf8-json" },
  createdAt: timestamp,
};

describe("durable information contracts", () => {
  it("retains unknown provider payload types without coupling them to normalized event schemas", () => {
    expect(Schema.decodeUnknownSync(NativeCapture)(capture)).toEqual(capture);
    expect(Schema.is(NativeCapture)({ ...capture, schemaVersion: 2 })).toBe(false);
  });

  it("distinguishes repeated native IDs by provider, account, runtime, generation and ordinal", () => {
    const variants = [
      identity,
      { ...identity, session: { ...session, provider: "claudeAgent" } },
      { ...identity, session: { ...session, providerInstanceId: "codex_personal" } },
      { ...identity, session: { ...session, runtimeSessionId: "runtime-2" } },
      { ...identity, session: { ...session, lifecycleGeneration: "generation-2" } },
      { ...identity, ingressOrdinal: 2 },
      { ...identity, threadId: "thread-2" },
    ].map((value) => Schema.decodeUnknownSync(NativeCaptureIdentity)(value));
    expect(new Set(variants.map((value) => JSON.stringify(value))).size).toBe(variants.length);
    expect(Schema.is(NativeCaptureIdentity)({ ...identity, ingressOrdinal: 0 })).toBe(false);
  });

  it("uses an exclusion envelope without retained payload fields", () => {
    const { payload: _payload, ...metadata } = capture;
    const excluded = { ...metadata, disposition: "excluded", reason: "authentication-exchange" };
    expect(Schema.decodeUnknownSync(NativeCapture)(excluded)).toEqual(excluded);
    expect(Schema.is(NativeCapture)({ ...excluded, payload })).toBe(false);
    expect(Schema.is(NativeCapture)({ ...excluded, reason: "free-form secret" })).toBe(false);
  });

  it("links many captures to a durable event rather than a runtime buffer row", () => {
    const link = {
      captureId: "capture-1",
      eventId: "event-1",
      eventSequence: 40,
      threadId: "thread-1",
      turnId: null,
      messageId: "message-1",
    };
    expect(Schema.decodeUnknownSync(NativeNormalizationLink)(link)).toEqual(link);
    expect(
      Schema.decodeUnknownSync(NativeNormalizationLink)({ ...link, captureId: "capture-2" })
        .eventId,
    ).toBe(link.eventId);
  });

  it("accepts uncapped full objective descriptors and rejects a broken revision chain", () => {
    const objective = {
      schemaVersion: 1,
      revisionId: "objective-1",
      projectId: "project-1",
      threadId: "thread-1",
      revision: 1,
      previousRevisionId: null,
      objective: payload,
      status: "paused",
      sources: [source],
      createdAt: timestamp,
    };
    expect(Schema.decodeUnknownSync(DurableObjectiveRevision)(objective)).toEqual(objective);
    expect(Schema.is(DurableObjectiveRevision)({ ...objective, revision: 2 })).toBe(false);
    expect(
      Schema.is(DurableObjectiveRevision)({
        ...objective,
        objective: { ...payload, encoding: "utf16" },
      }),
    ).toBe(false);
  });

  it("validates byte ranges and integrity descriptors", () => {
    expect(Schema.is(InformationSource)({ ...source, byteRange: { start: 4, end: 4 } })).toBe(
      false,
    );
    expect(Schema.is(InformationSource)({ ...source, byteRange: { start: 4, end: 8 } })).toBe(true);
    expect(Schema.is(DurablePayloadDescriptor)({ ...payload, byteLength: -1 })).toBe(false);
    expect(Schema.is(DurablePayloadDescriptor)({ ...payload, chunkCount: 0 })).toBe(false);
    expect(Schema.is(DurablePayloadDescriptor)({ ...payload, sha256: "preview" })).toBe(false);
  });

  it("allows empty independent summaries and bounds only summary text", () => {
    expect(Schema.decodeUnknownSync(DurableSummaryRevision)(summary)).toEqual(summary);
    expect(
      Schema.is(DurableSummaryRevision)({
        ...summary,
        scope: { kind: "project", projectId: "project-1" },
        text: "a".repeat(8_000),
      }),
    ).toBe(true);
    expect(Schema.is(DurableSummaryRevision)({ ...summary, text: "a".repeat(8_001) })).toBe(false);
    expect(Schema.is(DurableSummaryRevision)({ ...summary, revision: 2 })).toBe(false);
  });

  it("retains uncertain candidates and cannot discard explicit objective/status changes", () => {
    expect(Schema.decodeUnknownSync(DurableRetentionCandidate)(candidate)).toEqual(candidate);
    for (const reason of ["objective-change", "status-change"]) {
      expect(
        Schema.is(DurableRetentionCandidate)({
          ...candidate,
          reason,
          decision: "discard",
          state: "discarded",
        }),
      ).toBe(false);
      expect(
        Schema.is(DurableRetentionCandidate)({ ...candidate, reason, decision: "retain" }),
      ).toBe(true);
    }
    expect(Schema.is(DurableRetentionCandidate)({ ...candidate, sources: [] })).toBe(false);
    expect(Schema.is(DurableRetentionCandidate)({ ...candidate, state: "consumed" })).toBe(false);
    expect(
      Schema.is(DurableRetentionCandidate)({ ...candidate, consumedByRevisionId: "summary-1" }),
    ).toBe(false);
  });

  it("keeps exact handoff descriptors and acceptance outcomes separate", () => {
    expect(Schema.decodeUnknownSync(DurableHandoffPacket)(packet)).toEqual(packet);
    expect(
      Schema.is(DurableHandoffPacket)({
        ...packet,
        recentMessages: [{ threadId: "other-thread", messageId: "message-1" }],
      }),
    ).toBe(false);
    expect(
      Schema.is(DurableHandoffPacket)({
        ...packet,
        recentMessages: [...packet.recentMessages, ...packet.recentMessages],
      }),
    ).toBe(false);
    expect(
      Schema.is(DurableHandoffPacket)({
        ...packet,
        limits: { ...packet.limits, reservedChars: 48_000 },
      }),
    ).toBe(false);
    expect(Schema.is(DurableHandoffPacket)({ ...packet, dispatchInput: payload })).toBe(false);
    for (const outcome of ["accepted", "failed", "uncertain"]) {
      expect(
        Schema.is(DurableHandoffOutcome)({
          packetId: "packet-1",
          commandId: "command-1",
          attempt: 1,
          outcome,
          nativeSessionId: null,
          occurredAt: timestamp,
        }),
      ).toBe(true);
    }
  });

  it("retains unavailable attachment metadata without claiming its bytes remain in SQLite", () => {
    const attachment = {
      schemaVersion: 1,
      attachmentId: "attachment-1",
      projectId: "project-1",
      threadId: "thread-1",
      messageId: "message-1",
      storage: "managed-file",
      originalName: "design.png",
      mimeType: "image/png",
      byteLength: null,
      sha256: null,
      availability: "expired",
      createdAt: timestamp,
    };
    expect(Schema.decodeUnknownSync(DurableAttachmentReference)(attachment)).toEqual(attachment);
    expect(Schema.is(DurableAttachmentReference)({ ...attachment, storage: "sqlite" })).toBe(false);
  });

  it("marks historical coverage explicitly without reversing a source range", () => {
    const coverage = {
      schemaVersion: 1,
      projectId: "project-1",
      threadId: "thread-1",
      coverage: "normalized-only",
      from: { orchestrationSequence: 0, captureSequence: 0 },
      through: watermark,
      recordedAt: timestamp,
    };
    expect(Schema.decodeUnknownSync(DurableCaptureCoverage)(coverage)).toEqual(coverage);
    expect(
      Schema.is(DurableCaptureCoverage)({
        ...coverage,
        from: { ...watermark, captureSequence: 52 },
      }),
    ).toBe(false);
  });
});
