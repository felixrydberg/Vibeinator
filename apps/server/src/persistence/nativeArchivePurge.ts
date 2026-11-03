import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Compose only inside the existing explicit thread-purge transaction. Operational retention never calls this.
export const purgeThreadNativeArchive = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM native_normalization_links WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_legacy_sources WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_capture_coverage WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_attachment_references WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM native_captures WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM durable_payloads WHERE thread_id = ${threadId}`;
  });
