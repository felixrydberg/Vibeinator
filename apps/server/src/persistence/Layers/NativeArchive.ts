import { createHash, randomUUID } from "node:crypto";

import {
  DurableAttachmentReference,
  DurableCaptureCoverage,
  DurablePayloadDescriptor,
  NativeCapture,
  NativeNormalizationLink,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../Errors.ts";
import { hasUnpairedSurrogate } from "../messageTextChunks.ts";
import {
  NATIVE_ARCHIVE_CHUNK_BYTES,
  NATIVE_ARCHIVE_MAX_CHUNKS_PER_PAGE,
  NATIVE_ARCHIVE_MAX_RECORDS_PER_PAGE,
  NativeArchiveError,
  NativeArchiveRepository,
  type ArchiveContent,
  type ArchiveScope,
  type NativeArchiveRepositoryError,
  type NativeArchiveRepositoryShape,
} from "../Services/NativeArchive.ts";

const ScopeSchema = Schema.Struct({ projectId: ProjectId, threadId: ThreadId });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const failure = (operation: string, reason: NativeArchiveError["reason"]) =>
  new NativeArchiveError({ operation, reason });
const validate = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
): Effect.Effect<S["Type"], NativeArchiveError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () => failure("NativeArchive.validate", "invalid-input"),
  });

// Do not attach driver errors: SQLite errors can contain SQL and source/credential values.
export const archiveError =
  (operation: string) =>
  (error: unknown): NativeArchiveRepositoryError =>
    error instanceof NativeArchiveError || error instanceof PersistenceSqlError
      ? error
      : new PersistenceSqlError({
          operation,
          detail: "Archive database operation failed; stop dispatch and retry storage safely.",
        });

// SQLITE_FULL may auto-rollback; the SQL client's redundant rollback can then die.
// Surface that storage failure to the owning session without exposing SQL/source data.
export const protectArchive =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, NativeArchiveRepositoryError, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(archiveError(operation)(Cause.squash(cause))),
      ),
    );

const prepareContent = (content: ArchiveContent) =>
  Effect.try({
    try: () => {
      if (typeof content.text !== "string" || hasUnpairedSurrogate(content.text)) throw new Error();
      if (content.encoding === "utf8-json") JSON.parse(content.text);
      else if (content.encoding !== "utf8-text") throw new Error();
      const bytes = Buffer.from(content.text, "utf8");
      return {
        bytes,
        encoding: content.encoding,
        byteLength: bytes.byteLength,
        chunkCount: Math.max(1, Math.ceil(bytes.byteLength / NATIVE_ARCHIVE_CHUNK_BYTES)),
        sha256: digest(bytes),
      };
    },
    catch: () => failure("NativeArchive.content", "invalid-input"),
  });

const validCursor = (cursor: number) => Number.isSafeInteger(cursor) && cursor >= 0;
const validLimit = (limit: number, max: number) =>
  Number.isSafeInteger(limit) && limit > 0 && limit <= max;
const validKey = (value: string) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\0") &&
  !hasUnpairedSurrogate(value);

interface PayloadRow {
  payloadId: string;
  encoding: "utf8-text" | "utf8-json";
  byteLength: number;
  chunkCount: number;
  sha256: string;
}
interface CaptureRow {
  captureId: string;
  captureSequence: number;
  metadataJson: string;
  payloadId: string | null;
  committedAt: string;
  fingerprint: string;
}

export const makeNativeArchiveRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ownsThread = (scope: ArchiveScope) =>
    Effect.gen(function* () {
      yield* validate(ScopeSchema, scope);
      if (!validKey(scope.projectId) || !validKey(scope.threadId))
        return yield* Effect.fail(failure("NativeArchive.scope", "invalid-input"));
      const rows = yield* sql`SELECT 1 FROM projection_threads AS thread
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.thread_id = ${scope.threadId} AND thread.project_id = ${scope.projectId}
        AND thread.deleted_at IS NULL AND project.deleted_at IS NULL`;
      return rows.length !== 0;
    });
  const requireOwner = (scope: ArchiveScope) =>
    Effect.gen(function* () {
      if (!(yield* ownsThread(scope)))
        return yield* Effect.fail(failure("NativeArchive.scope", "ownership"));
    });
  const readDescriptor = (scope: ArchiveScope, payloadId: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<PayloadRow>`SELECT payload_id AS "payloadId", encoding, byte_length AS "byteLength",
      chunk_count AS "chunkCount", sha256 FROM durable_payloads
      WHERE project_id = ${scope.projectId} AND thread_id = ${scope.threadId} AND payload_id = ${payloadId}`;
      if (!rows[0]) return null;
      return yield* validate(DurablePayloadDescriptor, rows[0]).pipe(
        Effect.mapError(() => failure("NativeArchive.descriptor", "integrity")),
      );
    });

  const storePayload = (
    scope: ArchiveScope,
    payloadKey: string,
    content: Effect.Success<ReturnType<typeof prepareContent>>,
  ) =>
    Effect.gen(function* () {
      if (!validKey(payloadKey))
        return yield* Effect.fail(failure("NativeArchive.payloadKey", "invalid-input"));
      const existing =
        yield* sql<PayloadRow>`SELECT payload_id AS "payloadId", encoding, byte_length AS "byteLength",
      chunk_count AS "chunkCount", sha256 FROM durable_payloads
      WHERE project_id = ${scope.projectId} AND thread_id = ${scope.threadId} AND payload_key = ${payloadKey}`;
      if (existing[0]) {
        const old = yield* validate(DurablePayloadDescriptor, existing[0]);
        if (
          old.encoding !== content.encoding ||
          old.byteLength !== content.byteLength ||
          old.sha256 !== content.sha256
        )
          return yield* Effect.fail(failure("NativeArchive.appendPayload", "identity-conflict"));
        return old;
      }
      const descriptor = yield* validate(DurablePayloadDescriptor, {
        ...content,
        payloadId: randomUUID(),
      });
      yield* sql`INSERT INTO durable_payloads(payload_id, project_id, thread_id, payload_key, encoding, byte_length, chunk_count, sha256)
      VALUES (${descriptor.payloadId}, ${scope.projectId}, ${scope.threadId}, ${payloadKey}, ${descriptor.encoding},
        ${descriptor.byteLength}, ${descriptor.chunkCount}, ${descriptor.sha256})`;
      for (let index = 0; index < descriptor.chunkCount; index++) {
        const offset = index * NATIVE_ARCHIVE_CHUNK_BYTES;
        const bytes = content.bytes.subarray(offset, offset + NATIVE_ARCHIVE_CHUNK_BYTES);
        yield* sql`INSERT INTO durable_payload_chunks(payload_id, chunk_index, byte_offset, byte_length, sha256, bytes)
        VALUES (${descriptor.payloadId}, ${index}, ${offset}, ${bytes.byteLength}, ${digest(bytes)}, ${bytes})`;
      }
      return descriptor;
    });

  const decodeCapture = (scope: ArchiveScope, row: CaptureRow) =>
    Effect.gen(function* () {
      const metadata = yield* Effect.try({
        try: () => JSON.parse(row.metadataJson),
        catch: () => failure("NativeArchive.capture", "integrity"),
      });
      const payload =
        row.payloadId === null ? undefined : yield* readDescriptor(scope, row.payloadId);
      const capture = yield* validate(NativeCapture, {
        ...metadata,
        captureId: row.captureId,
        captureSequence: row.captureSequence,
        committedAt: row.committedAt,
        ...(row.payloadId !== null ? { payload } : {}),
      }).pipe(Effect.mapError(() => failure("NativeArchive.capture", "integrity")));
      if (
        capture.identity.projectId !== scope.projectId ||
        capture.identity.threadId !== scope.threadId
      )
        return yield* Effect.fail(failure("NativeArchive.capture", "integrity"));
      return capture;
    });

  const appendPayload: NativeArchiveRepositoryShape["appendPayload"] = (input) =>
    Effect.gen(function* () {
      const content = yield* prepareContent(input.content);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* requireOwner(input);
          return yield* storePayload(input, input.payloadKey, content);
        }),
      );
    }).pipe(protectArchive("NativeArchive.appendPayload"));

  const appendCapture: NativeArchiveRepositoryShape["appendCapture"] = (input) =>
    Effect.gen(function* () {
      if (input.disposition === "excluded" && ("content" in input || "payload" in input))
        return yield* Effect.fail(failure("NativeArchive.exclusion", "invalid-input"));
      const content =
        input.disposition === "retained" ? yield* prepareContent(input.content) : null;
      const validated = yield* validate(NativeCapture, {
        ...input,
        captureId: "pending",
        captureSequence: 1,
        committedAt: "pending",
        ...(content === null ? {} : { payload: { ...content, payloadId: "pending" } }),
      });
      const {
        captureId: _id,
        captureSequence: _sequence,
        committedAt: _committed,
        payload: _payload,
        ...metadata
      } = validated as NativeCapture & { payload?: DurablePayloadDescriptor };
      const metadataJson = JSON.stringify(metadata);
      const fingerprint = digest(
        Buffer.from(
          JSON.stringify([
            metadata,
            content === null ? null : [content.encoding, content.byteLength, content.sha256],
          ]),
          "utf8",
        ),
      );
      const scope = input.identity;
      const session = scope.session;
      if (
        ![
          session.provider,
          session.providerInstanceId,
          session.runtimeSessionId,
          session.lifecycleGeneration,
        ].every(validKey)
      )
        return yield* Effect.fail(failure("NativeArchive.identity", "invalid-input"));
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* requireOwner(scope);
          const existing =
            yield* sql<CaptureRow>`SELECT capture_id AS "captureId", capture_sequence AS "captureSequence",
        metadata_json AS "metadataJson", payload_id AS "payloadId", committed_at AS "committedAt", fingerprint
        FROM native_captures WHERE project_id = ${scope.projectId} AND thread_id = ${scope.threadId}
          AND provider = ${session.provider} AND provider_instance_id = ${session.providerInstanceId}
          AND runtime_session_id = ${session.runtimeSessionId} AND lifecycle_generation = ${session.lifecycleGeneration}
          AND ingress_ordinal = ${scope.ingressOrdinal}`;
          if (existing[0]) {
            if (existing[0].fingerprint !== fingerprint)
              return yield* Effect.fail(
                failure("NativeArchive.appendCapture", "identity-conflict"),
              );
            return yield* decodeCapture(scope, existing[0]);
          }
          const captureId = randomUUID();
          const payload =
            content === null ? null : yield* storePayload(scope, `capture:${captureId}`, content);
          const committedAt = new Date().toISOString();
          const rows = yield* sql<{ sequence: number }>`INSERT INTO native_captures
        (capture_id, project_id, thread_id, provider, provider_instance_id, runtime_session_id, lifecycle_generation,
         ingress_ordinal, fingerprint, metadata_json, payload_id, committed_at)
        VALUES (${captureId}, ${scope.projectId}, ${scope.threadId}, ${session.provider}, ${session.providerInstanceId},
          ${session.runtimeSessionId}, ${session.lifecycleGeneration}, ${scope.ingressOrdinal}, ${fingerprint}, ${metadataJson},
          ${payload?.payloadId ?? null}, ${committedAt}) RETURNING capture_sequence AS sequence`;
          return yield* validate(NativeCapture, {
            ...metadata,
            captureId,
            captureSequence: rows[0]!.sequence,
            committedAt,
            ...(payload === null ? {} : { payload }),
          });
        }),
      );
    }).pipe(protectArchive("NativeArchive.appendCapture"));

  const listCaptures: NativeArchiveRepositoryShape["listCaptures"] = (input) =>
    Effect.gen(function* () {
      if (
        !validCursor(input.afterSequence) ||
        !validCursor(input.throughSequence) ||
        !validLimit(input.limit, NATIVE_ARCHIVE_MAX_RECORDS_PER_PAGE)
      )
        return yield* Effect.fail(failure("NativeArchive.listCaptures", "invalid-input"));
      if (!(yield* ownsThread(input))) return [];
      const rows =
        yield* sql<CaptureRow>`SELECT capture_id AS "captureId", capture_sequence AS "captureSequence",
      metadata_json AS "metadataJson", payload_id AS "payloadId", committed_at AS "committedAt", fingerprint
      FROM native_captures WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        AND capture_sequence > ${input.afterSequence} AND capture_sequence <= ${input.throughSequence}
      ORDER BY capture_sequence LIMIT ${input.limit}`;
      return yield* Effect.forEach(rows, (row) => decodeCapture(input, row));
    }).pipe(protectArchive("NativeArchive.listCaptures"));

  const getHighWaterSequence: NativeArchiveRepositoryShape["getHighWaterSequence"] = (scope) =>
    Effect.gen(function* () {
      if (!(yield* ownsThread(scope))) return 0;
      const rows = yield* sql<{
        sequence: number;
      }>`SELECT COALESCE(MAX(capture_sequence), 0) AS sequence FROM native_captures
      WHERE project_id = ${scope.projectId} AND thread_id = ${scope.threadId}`;
      return rows[0]!.sequence;
    }).pipe(protectArchive("NativeArchive.highWater"));

  const readPayloadPage: NativeArchiveRepositoryShape["readPayloadPage"] = (input) =>
    Effect.gen(function* () {
      if (
        !validCursor(input.fromChunkIndex) ||
        !validLimit(input.limit, NATIVE_ARCHIVE_MAX_CHUNKS_PER_PAGE)
      )
        return yield* Effect.fail(failure("NativeArchive.readPayloadPage", "invalid-input"));
      if (!(yield* ownsThread(input))) return null;
      const descriptor = yield* readDescriptor(input, input.payloadId);
      if (descriptor === null) return null;
      if (input.fromChunkIndex >= descriptor.chunkCount)
        return yield* Effect.fail(failure("NativeArchive.readPayloadPage", "invalid-input"));
      const rows = yield* sql<{
        index: number;
        byteOffset: number;
        byteLength: number;
        sha256: string;
        bytes: Uint8Array;
      }>`
      SELECT chunk_index AS "index", byte_offset AS "byteOffset", byte_length AS "byteLength", sha256, bytes
      FROM durable_payload_chunks WHERE payload_id = ${input.payloadId} AND chunk_index >= ${input.fromChunkIndex}
      ORDER BY chunk_index LIMIT ${input.limit}`;
      const count = Math.min(input.limit, descriptor.chunkCount - input.fromChunkIndex);
      if (rows.length !== count)
        return yield* Effect.fail(failure("NativeArchive.readPayloadPage", "integrity"));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const expectedIndex = input.fromChunkIndex + i;
        const expectedOffset = expectedIndex * NATIVE_ARCHIVE_CHUNK_BYTES;
        if (
          !(row.bytes instanceof Uint8Array) ||
          row.index !== expectedIndex ||
          row.byteOffset !== expectedOffset ||
          row.byteLength !==
            Math.min(NATIVE_ARCHIVE_CHUNK_BYTES, descriptor.byteLength - expectedOffset) ||
          row.bytes.byteLength !== row.byteLength ||
          digest(row.bytes) !== row.sha256
        )
          return yield* Effect.fail(failure("NativeArchive.readPayloadPage", "integrity"));
      }
      const next = input.fromChunkIndex + rows.length;
      return {
        descriptor,
        chunks: rows.map((row) => ({
          payloadId: descriptor.payloadId,
          index: row.index,
          byteOffset: row.byteOffset,
          byteLength: row.byteLength,
          sha256: row.sha256,
          bytes: row.bytes,
        })),
        nextChunkIndex: next < descriptor.chunkCount ? next : null,
      };
    }).pipe(protectArchive("NativeArchive.readPayloadPage"));

  const streamPayload: NativeArchiveRepositoryShape["streamPayload"] = (input) =>
    Stream.suspend(() => {
      const hash = createHash("sha256");
      let byteLength = 0;
      let expected: DurablePayloadDescriptor | null = null;
      return Stream.paginate<number, Uint8Array, NativeArchiveRepositoryError>(
        0,
        (fromChunkIndex) =>
          Effect.gen(function* () {
            const page = yield* readPayloadPage({
              ...input,
              fromChunkIndex,
              limit: NATIVE_ARCHIVE_MAX_CHUNKS_PER_PAGE,
            });
            if (page === null)
              return yield* Effect.fail(failure("NativeArchive.streamPayload", "ownership"));
            if (expected !== null && JSON.stringify(expected) !== JSON.stringify(page.descriptor))
              return yield* Effect.fail(failure("NativeArchive.streamPayload", "integrity"));
            expected = page.descriptor;
            for (const chunk of page.chunks) {
              hash.update(chunk.bytes);
              byteLength += chunk.byteLength;
            }
            if (
              page.nextChunkIndex === null &&
              (byteLength !== expected.byteLength || hash.digest("hex") !== expected.sha256)
            )
              return yield* Effect.fail(failure("NativeArchive.streamPayload", "integrity"));
            return [
              page.chunks.map((chunk) => chunk.bytes),
              page.nextChunkIndex === null
                ? Option.none<number>()
                : Option.some(page.nextChunkIndex),
            ] as const;
          }),
      );
    });

  const linkNormalization: NativeArchiveRepositoryShape["linkNormalization"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireOwner(input);
          const link = yield* validate(NativeNormalizationLink, input.link);
          if (link.threadId !== input.threadId)
            return yield* Effect.fail(failure("NativeArchive.link", "ownership"));
          const matches =
            yield* sql`SELECT 1 FROM native_captures AS capture JOIN orchestration_events AS event
      ON event.event_id = ${link.eventId} AND event.sequence = ${link.eventSequence}
      WHERE capture.capture_id = ${link.captureId} AND capture.project_id = ${input.projectId} AND capture.thread_id = ${input.threadId}
        AND event.aggregate_kind = 'thread' AND event.stream_id = ${input.threadId}`;
          if (matches.length === 0)
            return yield* Effect.fail(failure("NativeArchive.link", "ownership"));
          const existing = yield* sql<{
            turnId: string | null;
            messageId: string | null;
          }>`SELECT turn_id AS "turnId", message_id AS "messageId"
      FROM native_normalization_links WHERE capture_id = ${link.captureId} AND event_id = ${link.eventId}`;
          if (
            existing[0] &&
            (existing[0].turnId !== link.turnId || existing[0].messageId !== link.messageId)
          )
            return yield* Effect.fail(failure("NativeArchive.link", "identity-conflict"));
          yield* sql`INSERT OR IGNORE INTO native_normalization_links(capture_id, event_id, event_sequence, thread_id, turn_id, message_id)
      VALUES (${link.captureId}, ${link.eventId}, ${link.eventSequence}, ${link.threadId}, ${link.turnId}, ${link.messageId})`;
        }),
      )
      .pipe(protectArchive("NativeArchive.link"));

  const listNormalizationLinks: NativeArchiveRepositoryShape["listNormalizationLinks"] = (input) =>
    Effect.gen(function* () {
      if (
        !validCursor(input.afterEventSequence) ||
        !validLimit(input.limit, NATIVE_ARCHIVE_MAX_RECORDS_PER_PAGE)
      )
        return yield* Effect.fail(failure("NativeArchive.links", "invalid-input"));
      if (!(yield* ownsThread(input))) return [];
      const rows =
        yield* sql`SELECT link.capture_id AS "captureId", link.event_id AS "eventId", link.event_sequence AS "eventSequence",
      link.thread_id AS "threadId", link.turn_id AS "turnId", link.message_id AS "messageId"
      FROM native_normalization_links AS link JOIN native_captures AS capture ON capture.capture_id = link.capture_id
      WHERE capture.project_id = ${input.projectId} AND capture.thread_id = ${input.threadId}
        AND link.capture_id = ${input.captureId} AND link.event_sequence > ${input.afterEventSequence}
      ORDER BY link.event_sequence LIMIT ${input.limit}`;
      return yield* Effect.forEach(rows, (row) => validate(NativeNormalizationLink, row));
    }).pipe(protectArchive("NativeArchive.links"));

  const getCoverage: NativeArchiveRepositoryShape["getCoverage"] = (scope) =>
    Effect.gen(function* () {
      if (!(yield* ownsThread(scope))) return null;
      const rows = yield* sql<{
        json: string;
      }>`SELECT coverage_json AS json FROM durable_capture_coverage
      WHERE project_id = ${scope.projectId} AND thread_id = ${scope.threadId}`;
      if (!rows[0]) return null;
      const value = yield* Effect.try({
        try: () => JSON.parse(rows[0]!.json),
        catch: () => failure("NativeArchive.coverage", "integrity"),
      });
      return yield* validate(DurableCaptureCoverage, value);
    }).pipe(protectArchive("NativeArchive.coverage"));

  const listLegacySources: NativeArchiveRepositoryShape["listLegacySources"] = (input) =>
    Effect.gen(function* () {
      if (
        !validLimit(input.limit, NATIVE_ARCHIVE_MAX_RECORDS_PER_PAGE) ||
        !["event", "message", "goal"].includes(input.sourceKind)
      )
        return yield* Effect.fail(failure("NativeArchive.legacy", "invalid-input"));
      if (!(yield* ownsThread(input))) return [];
      const rows = yield* sql<{
        sourceId: string;
        coverage: "normalized-only" | "unavailable";
        payloadId: string | null;
        eventId: string | null;
        metadataJson: string;
      }>`
      SELECT source_id AS "sourceId", coverage, payload_id AS "payloadId", event_id AS "eventId", metadata_json AS "metadataJson"
      FROM durable_legacy_sources WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        AND source_kind = ${input.sourceKind} AND source_id > ${input.afterSourceId} ORDER BY source_id LIMIT ${input.limit}`;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const metadata = yield* Effect.try({
            try: () => JSON.parse(row.metadataJson) as Readonly<Record<string, unknown>>,
            catch: () => failure("NativeArchive.legacy", "integrity"),
          });
          const payload =
            row.payloadId === null ? null : yield* readDescriptor(input, row.payloadId);
          if (row.payloadId !== null && payload === null)
            return yield* Effect.fail(failure("NativeArchive.legacy", "integrity"));
          return {
            projectId: input.projectId,
            threadId: input.threadId,
            sourceKind: input.sourceKind,
            sourceId: row.sourceId,
            coverage: row.coverage,
            payload,
            eventId: row.eventId,
            metadata,
          };
        }),
      );
    }).pipe(protectArchive("NativeArchive.legacy"));

  const listAttachmentReferences: NativeArchiveRepositoryShape["listAttachmentReferences"] = (
    input,
  ) =>
    Effect.gen(function* () {
      if (!validLimit(input.limit, NATIVE_ARCHIVE_MAX_RECORDS_PER_PAGE))
        return yield* Effect.fail(failure("NativeArchive.attachments", "invalid-input"));
      if (!(yield* ownsThread(input))) return [];
      const rows =
        yield* sql`SELECT 1 AS "schemaVersion", project_id AS "projectId", thread_id AS "threadId", attachment_id AS "attachmentId",
      message_id AS "messageId", 'managed-file' AS storage, original_name AS "originalName", mime_type AS "mimeType",
      byte_length AS "byteLength", sha256, availability, created_at AS "createdAt" FROM durable_attachment_references
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId} AND attachment_id > ${input.afterAttachmentId}
      ORDER BY attachment_id LIMIT ${input.limit}`;
      return yield* Effect.forEach(rows, (row) => validate(DurableAttachmentReference, row));
    }).pipe(protectArchive("NativeArchive.attachments"));

  return {
    appendCapture,
    appendPayload,
    linkNormalization,
    listCaptures,
    getHighWaterSequence,
    readPayloadPage,
    streamPayload,
    listNormalizationLinks,
    getCoverage,
    listLegacySources,
    listAttachmentReferences,
  } satisfies NativeArchiveRepositoryShape;
});

export const NativeArchiveRepositoryLive = Layer.effect(
  NativeArchiveRepository,
  makeNativeArchiveRepository,
);
