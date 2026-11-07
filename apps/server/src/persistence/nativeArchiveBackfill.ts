import { ChatAttachment, DurableCaptureCoverage, ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { protectArchive, NativeArchiveRepositoryLive } from "./Layers/NativeArchive.ts";
import { NativeArchiveRepository, NativeArchiveError } from "./Services/NativeArchive.ts";
import { joinMessageTextChunks, selectMessageTextChunks } from "./messageTextChunks.ts";

const PAGE_SIZE = 50;
const parseJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      () => new NativeArchiveError({ operation: "NativeArchive.backfill", reason: "integrity" }),
    ),
  );

// Finite migration fences and the page cursor commit with each page's retained sources.
// This runs during database setup, before projections/recovery/providers can mutate the inputs.
export const backfillNativeArchive = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const archive = yield* NativeArchiveRepository;
  const checkpoints = yield* sql<{
    kind: "event" | "message" | "goal" | "attachment";
    cursor: number;
    through: number;
  }>`
    SELECT source_kind AS kind, cursor, through_row AS through FROM durable_archive_backfill
    WHERE completed = 0 ORDER BY CASE source_kind WHEN 'event' THEN 0 WHEN 'message' THEN 1 WHEN 'goal' THEN 2 ELSE 3 END`;
  for (const checkpoint of checkpoints) {
    let cursor = checkpoint.cursor;
    let completed = false;
    while (!completed) {
      const page = yield* sql.withTransaction(
        Effect.gen(function* () {
          const retainSource = (
            row: { projectId: string; threadId: string },
            kind: "event" | "message" | "goal",
            sourceId: string,
            payloadId: string | null,
            eventId: string | null,
            coverage: "normalized-only" | "unavailable",
            metadata: unknown,
          ) =>
            sql`INSERT OR IGNORE INTO durable_legacy_sources
            (project_id, thread_id, source_kind, source_id, payload_id, event_id, coverage, metadata_json)
            VALUES (${row.projectId}, ${row.threadId}, ${kind}, ${sourceId}, ${payloadId}, ${eventId}, ${coverage}, ${JSON.stringify(metadata)})`;
          let last = cursor;
          let count = 0;
          if (checkpoint.kind === "event") {
            const rows = yield* sql<{
              rowId: number;
              projectId: string;
              threadId: string;
              eventId: string;
              type: string;
              occurredAt: string;
            }>`
            SELECT event.sequence AS "rowId", thread.project_id AS "projectId", thread.thread_id AS "threadId",
              event.event_id AS "eventId", event.event_type AS type, event.occurred_at AS "occurredAt"
            FROM orchestration_events AS event JOIN projection_threads AS thread ON event.stream_id = thread.thread_id
              JOIN projection_projects AS project ON project.project_id = thread.project_id
            WHERE event.aggregate_kind = 'thread' AND event.sequence > ${cursor} AND event.sequence <= ${checkpoint.through}
              AND thread.deleted_at IS NULL AND project.deleted_at IS NULL ORDER BY event.sequence LIMIT ${PAGE_SIZE}`;
            for (const row of rows) {
              // Keep the authoritative event in place and prevent pruning; don't copy a second transcript.
              yield* retainSource(row, "event", row.eventId, null, row.eventId, "normalized-only", {
                sequence: row.rowId,
                type: row.type,
                occurredAt: row.occurredAt,
              });
            }
            last = rows.at(-1)?.rowId ?? cursor;
            count = rows.length;
          } else if (checkpoint.kind === "message") {
            const keys = yield* sql<{
              rowId: number;
              projectId: string;
              threadId: string;
              messageId: string;
            }>`
              SELECT message.rowid AS "rowId", thread.project_id AS "projectId", thread.thread_id AS "threadId", message.message_id AS "messageId"
              FROM projection_thread_messages AS message JOIN projection_threads AS thread ON thread.thread_id = message.thread_id
                JOIN projection_projects AS project ON project.project_id = thread.project_id
              WHERE message.rowid > ${cursor} AND message.rowid <= ${checkpoint.through}
                AND thread.deleted_at IS NULL AND project.deleted_at IS NULL ORDER BY message.rowid LIMIT ${PAGE_SIZE}`;
            // Hold one potentially large body at a time, rather than 50 full bodies/chunk arrays.
            for (const key of keys) {
              const bodies = yield* sql<{
                rowId: number;
                projectId: string;
                threadId: string;
                message_id: string;
                text: string;
                textBytes: Uint8Array;
                text_json: string | null;
                textChunks: string;
                attachments_json: string | null;
                created_at: string;
                [key: string]: unknown;
              }>`SELECT message.rowid AS "rowId", ${key.projectId} AS "projectId", ${key.threadId} AS "threadId", message.*,
              CAST(message.text AS BLOB) AS "textBytes",
              ${selectMessageTextChunks(sql, "message")}
              FROM projection_thread_messages AS message WHERE message.rowid = ${key.rowId}`;
              const row = bodies[0]!;
              const {
                rowId: _rowId,
                projectId,
                threadId,
                text: _text,
                textBytes,
                text_json,
                textChunks,
                ...metadata
              } = row;
              const encodedText =
                text_json === null ? null : yield* parseJson(Schema.String, text_json);
              const chunks = yield* parseJson(Schema.Array(Schema.String), textChunks);
              // Node 24 truncates legacy TEXT reads at NUL; BLOB reads preserve the surviving suffix.
              const body = joinMessageTextChunks({
                text: Buffer.from(textBytes).toString("utf8"),
                encodedText,
                textChunks: chunks,
              });
              const payload = yield* archive.appendPayload({
                projectId: ProjectId.makeUnsafe(projectId),
                threadId: ThreadId.makeUnsafe(threadId),
                payloadKey: `legacy:message:${row.message_id}`,
                content: {
                  encoding: "utf8-json",
                  text: JSON.stringify({ ...metadata, text: body }),
                },
              });
              yield* retainSource(
                row,
                "message",
                row.message_id,
                payload.payloadId,
                null,
                "normalized-only",
                { messageId: row.message_id, updatedAt: row.updated_at, sequence: row.sequence },
              );
              // Unmanaged/missing legacy files still get durable metadata, never a fabricated available blob.
              if (row.attachments_json !== null) {
                const attachments: unknown = yield* parseJson(Schema.Unknown, row.attachments_json);
                if (Array.isArray(attachments))
                  for (const value of attachments) {
                    if (
                      !Schema.is(ChatAttachment)(value) ||
                      (value.type !== "file" && value.type !== "image")
                    )
                      continue;
                    yield* sql`INSERT OR IGNORE INTO durable_attachment_references
                  (project_id, thread_id, attachment_id, message_id, original_name, mime_type, byte_length, sha256, availability, created_at)
                  VALUES (${projectId}, ${threadId}, ${value.id}, ${row.message_id}, ${value.name}, ${value.mimeType},
                    ${value.sizeBytes}, NULL, 'missing', ${row.created_at})`;
                  }
              }
            }
            last = keys.at(-1)?.rowId ?? cursor;
            count = keys.length;
          } else if (checkpoint.kind === "goal") {
            const rows = yield* sql<{
              rowId: number;
              projectId: string;
              threadId: string;
              goal: string | null;
              updatedAt: string;
            }>`
            SELECT thread.rowid AS "rowId", thread.project_id AS "projectId", thread.thread_id AS "threadId", thread.goal,
              thread.updated_at AS "updatedAt" FROM projection_threads AS thread
              JOIN projection_projects AS project ON project.project_id = thread.project_id
            WHERE thread.rowid > ${cursor} AND thread.rowid <= ${checkpoint.through}
              AND thread.deleted_at IS NULL AND project.deleted_at IS NULL ORDER BY thread.rowid LIMIT ${PAGE_SIZE}`;
            const fences = yield* sql<{
              through: number;
            }>`SELECT through_row AS through FROM durable_archive_backfill WHERE source_kind = 'event'`;
            for (const row of rows) {
              if (row.goal !== null && row.goal.length !== 0) {
                // A persisted path is untrusted. Do not follow arbitrary/symlinked files during migration.
                const fileReference = row.goal.startsWith("Read this file: ");
                const payload = fileReference
                  ? null
                  : yield* archive.appendPayload({
                      projectId: ProjectId.makeUnsafe(row.projectId),
                      threadId: ThreadId.makeUnsafe(row.threadId),
                      payloadKey: "legacy:goal:current",
                      content: { encoding: "utf8-json", text: JSON.stringify(row.goal) },
                    });
                yield* retainSource(
                  row,
                  "goal",
                  "current",
                  payload?.payloadId ?? null,
                  null,
                  fileReference ? "unavailable" : "normalized-only",
                  {
                    updatedAt: row.updatedAt,
                    ...(fileReference
                      ? {
                          materializedReference: row.goal,
                          reason: "external-objective-not-imported",
                        }
                      : {}),
                  },
                );
              }
              const sources =
                yield* sql`SELECT 1 FROM durable_legacy_sources WHERE project_id = ${row.projectId}
              AND thread_id = ${row.threadId} AND coverage = 'normalized-only' LIMIT 1`;
              const coverage = Schema.decodeUnknownSync(DurableCaptureCoverage)({
                schemaVersion: 1,
                projectId: row.projectId,
                threadId: row.threadId,
                coverage: sources.length ? "normalized-only" : "unavailable",
                from: { orchestrationSequence: 0, captureSequence: 0 },
                through: { orchestrationSequence: fences[0]!.through, captureSequence: 0 },
                recordedAt: new Date().toISOString(),
              });
              yield* sql`INSERT OR IGNORE INTO durable_capture_coverage(project_id, thread_id, coverage_json)
              VALUES (${row.projectId}, ${row.threadId}, ${JSON.stringify(coverage)})`;
            }
            last = rows.at(-1)?.rowId ?? cursor;
            count = rows.length;
          } else {
            const rows = yield* sql<{
              rowId: number;
            }>`SELECT rowid AS "rowId" FROM managed_attachment_blobs
            WHERE rowid > ${cursor} AND rowid <= ${checkpoint.through} ORDER BY rowid LIMIT ${PAGE_SIZE}`;
            last = rows.at(-1)?.rowId ?? cursor;
            count = rows.length;
            yield* sql`INSERT INTO durable_attachment_references
            (project_id, thread_id, attachment_id, message_id, original_name, mime_type, byte_length, sha256, availability, created_at)
            SELECT thread.project_id, blob.owner_thread_id, blob.attachment_id, blob.claim_message_id, blob.original_name, blob.mime_type,
              blob.size_bytes, blob.sha256, CASE WHEN blob.state IN ('deleting', 'deleted') THEN
                CASE WHEN blob.delete_reason = 'staging-expired' THEN 'expired' ELSE 'deleted' END
                WHEN blob.state IN ('staged', 'claimed') THEN 'available' ELSE 'missing' END, blob.created_at
            FROM managed_attachment_blobs AS blob JOIN projection_threads AS thread ON thread.thread_id = blob.owner_thread_id
            WHERE blob.rowid > ${cursor} AND blob.rowid <= ${last}
            ON CONFLICT(project_id, thread_id, attachment_id) DO UPDATE SET
              message_id = COALESCE(excluded.message_id, durable_attachment_references.message_id),
              byte_length = COALESCE(excluded.byte_length, durable_attachment_references.byte_length),
              sha256 = COALESCE(excluded.sha256, durable_attachment_references.sha256), availability = excluded.availability`;
          }
          const done = count < PAGE_SIZE;
          yield* sql`UPDATE durable_archive_backfill SET cursor = ${done ? checkpoint.through : last}, completed = ${done ? 1 : 0}
          WHERE source_kind = ${checkpoint.kind}`;
          return { cursor: last, completed: done };
        }),
      );
      cursor = page.cursor;
      completed = page.completed;
      yield* Effect.yieldNow;
    }
  }
}).pipe(protectArchive("NativeArchive.backfill"));

export const runNativeArchiveBackfill = backfillNativeArchive.pipe(
  Effect.provide(NativeArchiveRepositoryLive),
);
