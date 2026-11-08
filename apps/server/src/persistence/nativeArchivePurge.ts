import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { purgeThreadSummarySources } from "./summaryStorePurge.ts";

// Compose only inside the existing explicit thread-purge transaction. Operational retention never calls this.
export const purgeThreadNativeArchive = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    // Project summaries can carry this chat's facts into another chat's packet.
    // Explicit purge removes derived dispatch copies throughout that project.
    const projects = yield* sql<{
      projectId: string;
    }>`SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = ${threadId}`;
    if (projects[0]) {
      const projectId = projects[0].projectId;
      yield* sql`DELETE FROM durable_payloads WHERE payload_id IN (
        SELECT json_extract(record_json, '$.assembledContext.payloadId') FROM handoff_packets WHERE project_id = ${projectId}
        UNION SELECT json_extract(record_json, '$.dispatchInput.payloadId') FROM handoff_packets WHERE project_id = ${projectId})`;
      yield* sql`DELETE FROM handoff_packets WHERE project_id = ${projectId}`;
    }
    yield* sql`DELETE FROM handoff_start_attempts WHERE thread_id = ${threadId}`;
    yield* purgeThreadSummarySources(sql, threadId);
    yield* sql`DELETE FROM native_normalization_links WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_legacy_sources WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_capture_coverage WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM native_recording_sessions WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_attachment_references WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM native_captures WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_payloads WHERE thread_id = ${threadId}`;
  });
