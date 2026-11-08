import { createHash, randomUUID } from "node:crypto";
import { stableJsonStringify } from "@synara/shared/canonicalJson";
import {
  AppendSummaryCandidateInput,
  CommitSummaryInput,
  DurableRetentionCandidate,
  DurableSummaryRevision,
  InformationScope,
  InformationWatermark,
  SummaryRevisionId,
  SummaryRevisionPageInput,
  type InformationSource,
} from "@synara/contracts";
import { Cause, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError } from "../Errors.ts";
import {
  SummaryStoreError,
  SummaryStoreRepository,
  type SummaryStoreRepositoryShape,
} from "../Services/SummaryStore.ts";

const failure = (reason: SummaryStoreError["reason"]) => new SummaryStoreError({ reason });
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof SummaryStoreError
          ? error
          : new PersistenceSqlError({
              operation: "SummaryStore",
              detail: "Summary database operation failed.",
            }),
      );
    }),
  );
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
  reason: SummaryStoreError["reason"] = "invalid-input",
) => Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => failure(reason)));
const parse = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) => decode(Schema.fromJsonString(schema), text, "integrity");
const scopeKey = (scope: InformationScope) =>
  createHash("sha256")
    .update(JSON.stringify([scope.projectId, scope.kind === "chat" ? scope.threadId : null]))
    .digest("hex");
const sourceKey = (source: InformationSource) => stableJsonStringify(source);
const covers = (
  through: { orchestrationSequence: number; captureSequence: number },
  lower: { orchestrationSequence: number; captureSequence: number },
) =>
  through.orchestrationSequence >= lower.orchestrationSequence &&
  through.captureSequence >= lower.captureSequence;
interface ScopeRow {
  key: string;
  epoch: number;
  headId: string | null;
  invalidatedAt: number;
}

export const makeSummaryStoreRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ensureScope = (scope: InformationScope) =>
    Effect.gen(function* () {
      const owners = yield* sql<{
        root: string;
      }>`SELECT workspace_root AS root FROM projection_projects
      WHERE project_id = ${scope.projectId} AND deleted_at IS NULL`;
      if (!owners[0]) return yield* Effect.fail(failure("ownership"));
      if (scope.kind === "chat") {
        const threads =
          yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = ${scope.threadId}
        AND project_id = ${scope.projectId} AND deleted_at IS NULL`;
        if (!threads.length) return yield* Effect.fail(failure("ownership"));
      }
      const key = scopeKey(scope);
      yield* sql`INSERT OR IGNORE INTO summary_scopes(scope_key, project_id, thread_id, workspace_root)
      VALUES (${key}, ${scope.projectId}, ${scope.kind === "chat" ? scope.threadId : null}, ${owners[0].root})`;
      // Also fence direct imports/relocations that do not pass through the command event stream.
      yield* sql`UPDATE summary_scopes SET epoch = epoch + 1, head_revision_id = NULL, workspace_root = ${owners[0].root}
      WHERE project_id = ${scope.projectId} AND workspace_root <> ${owners[0].root}`;
      const rows =
        yield* sql<ScopeRow>`SELECT scope_key AS key, epoch, head_revision_id AS "headId", last_invalidation_sequence AS "invalidatedAt"
      FROM summary_scopes WHERE scope_key = ${key}`;
      if (!rows[0]) return yield* Effect.fail(failure("integrity"));
      return rows[0];
    });
  const validateWatermark = (watermark: typeof InformationWatermark.Type) =>
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(watermark.orchestrationSequence) ||
        !Number.isSafeInteger(watermark.captureSequence)
      )
        return yield* Effect.fail(failure("watermark"));
      const fences = yield* sql<{ orchestrationSequence: number; captureSequence: number }>`SELECT
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'), 0) AS "orchestrationSequence",
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'native_captures'), 0) AS "captureSequence"`;
      if (!covers(fences[0]!, watermark)) return yield* Effect.fail(failure("watermark"));
    });
  const validateSources = (
    scope: InformationScope,
    sources: ReadonlyArray<InformationSource>,
    watermark: typeof InformationWatermark.Type,
  ) =>
    Effect.gen(function* () {
      if (sources.length > 1000 || new Set(sources.map(sourceKey)).size !== sources.length)
        return yield* Effect.fail(failure("invalid-input"));
      const refs: Array<{
        key: string;
        threadId: string | null;
        captureId: string | null;
        eventId: string | null;
      }> = [];
      for (const source of sources) {
        if (source.kind === "capture") {
          const rows = yield* sql<{
            threadId: string;
            sequence: number;
            length: number;
          }>`SELECT capture.thread_id AS "threadId",
          capture.capture_sequence AS sequence, payload.byte_length AS length
          FROM native_captures AS capture JOIN durable_payloads AS payload ON payload.payload_id = capture.payload_id
          JOIN projection_threads AS thread ON thread.thread_id = capture.thread_id AND thread.project_id = capture.project_id
          WHERE capture.capture_id = ${source.captureId} AND capture.project_id = ${scope.projectId}
            AND thread.deleted_at IS NULL AND (${scope.kind === "chat" ? scope.threadId : null} IS NULL OR capture.thread_id = ${scope.kind === "chat" ? scope.threadId : null})`;
          const row = rows[0];
          if (
            !row ||
            row.sequence > watermark.captureSequence ||
            (source.byteRange !== null && source.byteRange.end > row.length)
          )
            return yield* Effect.fail(failure("source-unavailable"));
          refs.push({
            key: sourceKey(source),
            threadId: row.threadId,
            captureId: source.captureId,
            eventId: null,
          });
        } else if (source.kind === "event") {
          const rows = yield* sql<{
            threadId: string | null;
          }>`SELECT CASE WHEN event.aggregate_kind = 'thread' THEN event.stream_id ELSE NULL END AS "threadId"
          FROM orchestration_events AS event LEFT JOIN projection_threads AS thread ON event.aggregate_kind = 'thread' AND thread.thread_id = event.stream_id
          WHERE event.event_id = ${source.eventId} AND event.sequence = ${source.sequence} AND event.sequence <= ${watermark.orchestrationSequence}
            AND ((event.aggregate_kind = 'thread' AND thread.project_id = ${scope.projectId} AND thread.deleted_at IS NULL
              AND (${scope.kind === "chat" ? scope.threadId : null} IS NULL OR event.stream_id = ${scope.kind === "chat" ? scope.threadId : null}))
              OR (event.aggregate_kind = 'project' AND event.stream_id = ${scope.projectId} AND ${scope.kind === "project"}))`;
          if (!rows.length) return yield* Effect.fail(failure("source-unavailable"));
          refs.push({
            key: sourceKey(source),
            threadId: rows[0]!.threadId,
            captureId: null,
            eventId: source.eventId,
          });
        } else {
          // Goal revision storage is not present yet. Never fabricate an objective citation.
          return yield* Effect.fail(failure("source-unavailable"));
        }
      }
      return refs;
    });
  const storeRefs = (
    kind: "revision" | "candidate",
    id: string,
    refs: Effect.Success<ReturnType<typeof validateSources>>,
  ) =>
    Effect.forEach(
      refs,
      (ref) =>
        sql`INSERT INTO summary_source_refs(owner_kind, owner_id, source_key, source_thread_id, capture_id, event_id)
      VALUES (${kind}, ${id}, ${ref.key}, ${ref.threadId}, ${ref.captureId}, ${ref.eventId})`,
      { discard: true },
    );
  const readHead = (state: ScopeRow) =>
    Effect.gen(function* () {
      if (state.headId === null) return null;
      const rows = yield* sql<{ json: string }>`SELECT record_json AS json FROM summary_revisions
      WHERE scope_key = ${state.key} AND epoch = ${state.epoch} AND revision_id = ${state.headId}`;
      if (!rows[0]) return yield* Effect.fail(failure("integrity"));
      return yield* parse(DurableSummaryRevision, rows[0].json);
    });
  const get: SummaryStoreRepositoryShape["get"] = (raw) =>
    protect(
      sql.withTransaction(
        Effect.gen(function* () {
          const scope = yield* decode(InformationScope, raw);
          const state = yield* ensureScope(scope);
          return {
            scope,
            epoch: state.epoch,
            invalidatedAtSequence: state.invalidatedAt,
            current: yield* readHead(state),
          };
        }),
      ),
    );
  const appendCandidate: SummaryStoreRepositoryShape["appendCandidate"] = (raw) =>
    protect(
      sql.withTransaction(
        Effect.gen(function* () {
          const input = yield* decode(AppendSummaryCandidateInput, raw);
          const { candidate } = input;
          const state = yield* ensureScope(candidate.scope);
          if (state.epoch !== input.expectedEpoch) return yield* Effect.fail(failure("conflict"));
          if (candidate.state === "consumed" || candidate.consumedByRevisionId !== null)
            return yield* Effect.fail(failure("invalid-input"));
          yield* validateWatermark(candidate.sourceWatermark);
          if (candidate.sourceWatermark.orchestrationSequence < state.invalidatedAt)
            return yield* Effect.fail(failure("watermark"));
          const json = JSON.stringify(candidate);
          const fingerprint = createHash("sha256")
            .update(stableJsonStringify(candidate))
            .digest("hex");
          const old = yield* sql<{
            key: string;
            epoch: number;
            json: string;
            fingerprint: string;
          }>`SELECT scope_key AS key, epoch, record_json AS json, input_fingerprint AS fingerprint FROM summary_candidates WHERE candidate_id = ${candidate.candidateId}`;
          if (old[0]) {
            if (
              old[0].key !== state.key ||
              old[0].epoch !== state.epoch ||
              old[0].fingerprint !== fingerprint
            )
              return yield* Effect.fail(failure("conflict"));
            return yield* parse(DurableRetentionCandidate, old[0].json);
          }
          const refs = yield* validateSources(
            candidate.scope,
            candidate.sources,
            candidate.sourceWatermark,
          );
          yield* sql`INSERT INTO summary_candidates(candidate_id, scope_key, epoch, state, input_fingerprint, record_json)
      VALUES (${candidate.candidateId}, ${state.key}, ${state.epoch}, ${candidate.state}, ${fingerprint}, ${json})`;
          yield* storeRefs("candidate", candidate.candidateId, refs);
          return candidate;
        }),
      ),
    );
  const getCandidate: SummaryStoreRepositoryShape["getCandidate"] = (raw, candidateId) =>
    protect(
      sql.withTransaction(
        Effect.gen(function* () {
          const scope = yield* decode(InformationScope, raw);
          const state = yield* ensureScope(scope);
          const rows = yield* sql<{
            epoch: number;
            json: string;
          }>`SELECT epoch, record_json AS json FROM summary_candidates WHERE scope_key = ${state.key} AND candidate_id = ${candidateId}`;
          return rows[0]
            ? {
                epoch: rows[0].epoch,
                candidate: yield* parse(DurableRetentionCandidate, rows[0].json),
              }
            : null;
        }),
      ),
    );
  const listPending: SummaryStoreRepositoryShape["listPending"] = (raw, limit) =>
    protect(
      sql.withTransaction(
        Effect.gen(function* () {
          const scope = yield* decode(InformationScope, raw);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            return yield* Effect.fail(failure("invalid-input"));
          const state = yield* ensureScope(scope);
          const rows = yield* sql<{
            json: string;
          }>`SELECT record_json AS json FROM summary_candidates
      WHERE scope_key = ${state.key} AND epoch = ${state.epoch} AND state = 'pending' ORDER BY candidate_id LIMIT ${limit}`;
          return yield* Effect.forEach(rows, (row) => parse(DurableRetentionCandidate, row.json));
        }),
      ),
    );
  const commit: SummaryStoreRepositoryShape["commit"] = (raw) =>
    protect(
      sql.withTransaction(
        Effect.gen(function* () {
          const input = yield* decode(CommitSummaryInput, raw);
          const state = yield* ensureScope(input.scope);
          if (
            state.epoch !== input.expectedEpoch ||
            state.headId !== input.expectedPreviousRevisionId
          )
            return yield* Effect.fail(failure("conflict"));
          const previous = yield* readHead(state);
          yield* validateWatermark(input.processedThrough);
          if (
            (previous && !covers(input.processedThrough, previous.processedThrough)) ||
            input.processedThrough.orchestrationSequence < state.invalidatedAt
          )
            return yield* Effect.fail(failure("watermark"));
          const refs = yield* validateSources(input.scope, input.sources, input.processedThrough);
          if (new Set(input.candidateIds).size !== input.candidateIds.length)
            return yield* Effect.fail(failure("invalid-input"));
          const cited = new Set(input.sources.map(sourceKey));
          for (const id of input.candidateIds) {
            const rows = yield* sql<{
              json: string;
            }>`SELECT record_json AS json FROM summary_candidates
        WHERE candidate_id = ${id} AND scope_key = ${state.key} AND epoch = ${state.epoch} AND state = 'pending'`;
            if (!rows[0]) return yield* Effect.fail(failure("conflict"));
            const candidate = yield* parse(DurableRetentionCandidate, rows[0].json);
            if (
              !covers(input.processedThrough, candidate.sourceWatermark) ||
              candidate.sources.some((source) => !cited.has(sourceKey(source)))
            )
              return yield* Effect.fail(failure("source-unavailable"));
          }
          const revision = yield* decode(DurableSummaryRevision, {
            schemaVersion: 1,
            revisionId: SummaryRevisionId.makeUnsafe(randomUUID()),
            scope: input.scope,
            revision: (previous?.revision ?? 0) + 1,
            previousRevisionId: state.headId,
            text: input.text,
            sources: input.sources,
            processedThrough: input.processedThrough,
            generation: input.generation,
            createdAt: new Date().toISOString(),
          });
          yield* sql`INSERT INTO summary_revisions(revision_id, scope_key, epoch, revision, record_json)
      VALUES (${revision.revisionId}, ${state.key}, ${state.epoch}, ${revision.revision}, ${JSON.stringify(revision)})`;
          yield* storeRefs("revision", revision.revisionId, refs);
          for (const id of input.candidateIds)
            yield* sql`UPDATE summary_candidates SET state = 'consumed',
      record_json = json_set(record_json, '$.state', 'consumed', '$.consumedByRevisionId', ${revision.revisionId}) WHERE candidate_id = ${id}`;
          const updated =
            yield* sql`UPDATE summary_scopes SET head_revision_id = ${revision.revisionId}
      WHERE scope_key = ${state.key} AND epoch = ${input.expectedEpoch} AND head_revision_id IS ${input.expectedPreviousRevisionId} RETURNING scope_key`;
          if (updated.length !== 1) return yield* Effect.fail(failure("conflict"));
          return revision;
        }),
      ),
    );
  const listRevisions: SummaryStoreRepositoryShape["listRevisions"] = (raw) =>
    protect(
      sql.withTransaction(
        Effect.gen(function* () {
          const input = yield* decode(SummaryRevisionPageInput, raw);
          const state = yield* ensureScope(input.scope);
          const rows = yield* sql<{
            sequence: number;
            epoch: number;
            json: string;
          }>`SELECT sequence, epoch, record_json AS json FROM summary_revisions
      WHERE scope_key = ${state.key} AND (${input.beforeSequence ?? null} IS NULL OR sequence < ${input.beforeSequence ?? null}) ORDER BY sequence DESC LIMIT ${input.limit + 1}`;
          const entries = yield* Effect.forEach(rows.slice(0, input.limit), (row) =>
            parse(DurableSummaryRevision, row.json).pipe(
              Effect.map((revision) => ({ sequence: row.sequence, epoch: row.epoch, revision })),
            ),
          );
          return {
            entries,
            nextBeforeSequence: rows.length > input.limit ? entries.at(-1)!.sequence : null,
          };
        }),
      ),
    );
  const getRevision: SummaryStoreRepositoryShape["getRevision"] = (raw, revisionId) =>
    protect(
      sql.withTransaction(
        Effect.gen(function* () {
          const scope = yield* decode(InformationScope, raw);
          const state = yield* ensureScope(scope);
          const rows = yield* sql<{
            sequence: number;
            epoch: number;
            json: string;
          }>`SELECT sequence, epoch, record_json AS json FROM summary_revisions WHERE scope_key = ${state.key} AND revision_id = ${revisionId}`;
          return rows[0]
            ? {
                sequence: rows[0].sequence,
                epoch: rows[0].epoch,
                revision: yield* parse(DurableSummaryRevision, rows[0].json),
              }
            : null;
        }),
      ),
    );
  return {
    get,
    appendCandidate,
    getCandidate,
    getRevision,
    listPending,
    commit,
    listRevisions,
  } satisfies SummaryStoreRepositoryShape;
});
export const SummaryStoreRepositoryLive = Layer.effect(
  SummaryStoreRepository,
  makeSummaryStoreRepository,
);
