import type {
  DurableAttachmentReference,
  DurableCaptureCoverage,
  DurablePayloadChunk,
  DurablePayloadDescriptor,
  NativeCapture,
  NativeCaptureId,
  NativeNormalizationLink,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export const NATIVE_ARCHIVE_CHUNK_BYTES = 64 * 1024;
export const NATIVE_ARCHIVE_MAX_CHUNKS_PER_PAGE = 16;
export const NATIVE_ARCHIVE_MAX_RECORDS_PER_PAGE = 100;

// Keep error messages free of source content, credentials and SQL parameter values.
export class NativeArchiveError extends Schema.TaggedErrorClass<NativeArchiveError>()(
  "NativeArchiveError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["invalid-input", "identity-conflict", "integrity", "ownership"]),
  },
) {}
export type NativeArchiveRepositoryError = NativeArchiveError | PersistenceSqlError;

export interface ArchiveScope {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}
export interface ArchiveContent {
  readonly encoding: DurablePayloadDescriptor["encoding"];
  /** Already serialized JSON or exact well-formed text. Serialization happens once at ingress. */
  readonly text: string;
}

/** Trusted ingestion context, carried separately from user-authored commands. */
export class NativeNormalizationOrigin extends ServiceMap.Service<
  NativeNormalizationOrigin,
  {
    readonly captureIds: ReadonlyArray<NativeCaptureId>;
    readonly ownerThreadId: ThreadId;
  }
>()("vibeinator/NativeNormalizationOrigin") {}
type CaptureMetadata = Omit<
  NativeCapture,
  "captureId" | "captureSequence" | "committedAt" | "payload" | "reason" | "disposition"
>;
export type AppendNativeCapture = CaptureMetadata &
  (
    | { readonly disposition: "retained"; readonly content: ArchiveContent }
    | {
        readonly disposition: "excluded";
        readonly reason: "authentication-exchange" | "credential-material";
      }
  );
export interface LegacyArchiveSource extends ArchiveScope {
  readonly sourceKind: "event" | "message" | "goal";
  readonly sourceId: string;
  readonly coverage: "normalized-only" | "unavailable";
  readonly payload: DurablePayloadDescriptor | null;
  readonly eventId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface NativeArchiveRepositoryShape {
  /** All writes compose with a caller-owned SQL transaction. No method dispatches provider work. */
  readonly appendCapture: (
    input: AppendNativeCapture,
  ) => Effect.Effect<NativeCapture, NativeArchiveRepositoryError>;
  readonly appendPayload: (
    input: ArchiveScope & { readonly payloadKey: string; readonly content: ArchiveContent },
  ) => Effect.Effect<DurablePayloadDescriptor, NativeArchiveRepositoryError>;
  readonly linkNormalization: (
    input: ArchiveScope & { readonly link: NativeNormalizationLink },
  ) => Effect.Effect<void, NativeArchiveRepositoryError>;
  readonly listCaptures: (
    input: ArchiveScope & {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly limit: number;
    },
  ) => Effect.Effect<ReadonlyArray<NativeCapture>, NativeArchiveRepositoryError>;
  readonly getHighWaterSequence: (
    scope: ArchiveScope,
  ) => Effect.Effect<number, NativeArchiveRepositoryError>;
  readonly readPayloadPage: (
    input: ArchiveScope & {
      readonly payloadId: DurablePayloadDescriptor["payloadId"];
      readonly fromChunkIndex: number;
      readonly limit: number;
    },
  ) => Effect.Effect<
    {
      readonly descriptor: DurablePayloadDescriptor;
      readonly chunks: ReadonlyArray<DurablePayloadChunk & { readonly bytes: Uint8Array }>;
      readonly nextChunkIndex: number | null;
    } | null,
    NativeArchiveRepositoryError
  >;
  /** Verifies every chunk and the complete hash/length at stream completion. */
  readonly streamPayload: (
    input: ArchiveScope & { readonly payloadId: DurablePayloadDescriptor["payloadId"] },
  ) => Stream.Stream<Uint8Array, NativeArchiveRepositoryError>;
  readonly listNormalizationLinks: (
    input: ArchiveScope & {
      readonly captureId: NativeCapture["captureId"];
      readonly afterEventSequence: number;
      readonly limit: number;
    },
  ) => Effect.Effect<ReadonlyArray<NativeNormalizationLink>, NativeArchiveRepositoryError>;
  readonly getCoverage: (
    scope: ArchiveScope,
  ) => Effect.Effect<DurableCaptureCoverage | null, NativeArchiveRepositoryError>;
  readonly listLegacySources: (
    input: ArchiveScope & {
      readonly sourceKind: LegacyArchiveSource["sourceKind"];
      readonly afterSourceId: string;
      readonly limit: number;
    },
  ) => Effect.Effect<ReadonlyArray<LegacyArchiveSource>, NativeArchiveRepositoryError>;
  readonly listAttachmentReferences: (
    input: ArchiveScope & { readonly afterAttachmentId: string; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<DurableAttachmentReference>, NativeArchiveRepositoryError>;
}

export class NativeArchiveRepository extends ServiceMap.Service<
  NativeArchiveRepository,
  NativeArchiveRepositoryShape
>()("vibeinator/persistence/NativeArchiveRepository") {}
