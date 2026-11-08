import { StringDecoder } from "node:string_decoder";
import { Effect, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DurablePayloadId, ProjectId, ThreadId } from "@synara/contracts";
import { NativeArchiveRepository, type ArchiveScope } from "./Services/NativeArchive.ts";

// Index bounded decoded pieces. Overlap covers a complete supported query across chunk boundaries.
export const makeHistoryPayloadWriter = (
  sql: SqlClient.SqlClient,
  scope: ArchiveScope,
  payloadId: string,
) => {
  let part = 0;
  let byteOffset = 0;
  let tail = "";
  return (text: string) =>
    Effect.gen(function* () {
      const body = tail + text;
      yield* sql`INSERT INTO history_documents(project_id, thread_id, source_kind, source_id, part, byte_offset, body)
      VALUES (${scope.projectId}, ${scope.threadId}, 'payload', ${payloadId}, ${part++},
        ${byteOffset - Buffer.byteLength(tail)}, ${body.replaceAll("\0", " ")})`;
      byteOffset += Buffer.byteLength(text);
      let start = Math.max(0, body.length - 512);
      if (start > 0 && /[\uDC00-\uDFFF]/u.test(body[start]!)) start++;
      tail = body.slice(start);
    });
};

// Runs after archive migration/backfill, before providers start. A payload's verified stream and
// completion marker commit together; interruption retries only that payload after restart.
export const backfillHistoryPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const archive = yield* NativeArchiveRepository;
  while (true) {
    const rows = yield* sql<{ payloadId: string; projectId: string; threadId: string }>`
      SELECT payload.payload_id AS "payloadId", payload.project_id AS "projectId", payload.thread_id AS "threadId"
      FROM durable_payloads AS payload
      JOIN projection_threads AS thread ON thread.thread_id = payload.thread_id AND thread.project_id = payload.project_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.deleted_at IS NULL AND project.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM history_indexed_payloads AS done WHERE done.payload_id = payload.payload_id)
      ORDER BY payload.rowid LIMIT 20`;
    if (rows.length === 0) break;
    for (const row of rows) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const done =
            yield* sql`SELECT 1 FROM history_indexed_payloads WHERE payload_id = ${row.payloadId}`;
          if (done.length) return;
          const scope = {
            projectId: ProjectId.makeUnsafe(row.projectId),
            threadId: ThreadId.makeUnsafe(row.threadId),
          };
          const write = makeHistoryPayloadWriter(sql, scope, row.payloadId);
          const decoder = new StringDecoder("utf8");
          yield* Stream.runForEach(
            archive.streamPayload({
              ...scope,
              payloadId: DurablePayloadId.makeUnsafe(row.payloadId),
            }),
            (bytes) => write(decoder.write(Buffer.from(bytes))),
          );
          const suffix = decoder.end();
          if (suffix) yield* write(suffix);
          yield* sql`INSERT INTO history_indexed_payloads VALUES (${row.payloadId})`;
        }),
      );
      yield* Effect.yieldNow;
    }
  }
});
