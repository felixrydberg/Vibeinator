import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Called only by explicit archive purge, inside its existing transaction.
export const purgeThreadSummarySources = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const scopes = yield* sql<{ key: string }>`SELECT scope_key AS key FROM summary_scopes
    WHERE thread_id = ${threadId} OR scope_key IN (
      SELECT revision.scope_key FROM summary_revisions AS revision JOIN summary_source_refs AS ref
        ON ref.owner_kind = 'revision' AND ref.owner_id = revision.revision_id WHERE ref.source_thread_id = ${threadId})
      OR scope_key IN (SELECT candidate.scope_key FROM summary_candidates AS candidate JOIN summary_source_refs AS ref
        ON ref.owner_kind = 'candidate' AND ref.owner_id = candidate.candidate_id WHERE ref.source_thread_id = ${threadId})`;
    for (const scope of scopes) {
      yield* sql`UPDATE summary_scopes SET epoch = epoch + 1, head_revision_id = NULL WHERE scope_key = ${scope.key}`;
      // Derived text may carry a purged fact through later revisions even when its citation was dropped.
      yield* sql`DELETE FROM summary_source_refs WHERE
        (owner_kind = 'revision' AND owner_id IN (SELECT revision_id FROM summary_revisions WHERE scope_key = ${scope.key}))
        OR (owner_kind = 'candidate' AND owner_id IN (SELECT candidate_id FROM summary_candidates WHERE scope_key = ${scope.key}))`;
      yield* sql`DELETE FROM summary_candidates WHERE scope_key = ${scope.key}`;
      yield* sql`DELETE FROM summary_revisions WHERE scope_key = ${scope.key}`;
    }
  });
