import type { ProviderDriverKind, ThreadId } from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { NativeCaptureOwner } from "./nativeCapture.ts";

export const NATIVE_RECORDING_FAILURE_MESSAGE =
  "Conversation recording failed. Restore database access or free disk space, stop the runtime, then resume. The last committed history is preserved.";
export type NativeRecordingFailureReason =
  | "capture"
  | "journal"
  | "projection"
  | "restart"
  | "overflow";
export interface NativeRecordingFailure {
  readonly threadId: ThreadId;
  readonly generation: string;
  readonly provider: ProviderDriverKind;
  readonly instanceId: string;
  readonly reason: NativeRecordingFailureReason;
  readonly createdAt: string;
}
type Owner = {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: string;
  readonly lifecycleGeneration: string;
};
interface NativeCaptureStateShape {
  readonly prepare: (owner: Owner) => Effect.Effect<void, Error>;
  readonly observe: (owner: NativeCaptureOwner) => Effect.Effect<void, Error>;
  readonly close: (threadId: ThreadId, generation: string) => Effect.Effect<void>;
  readonly assertReady: (threadId: ThreadId) => Effect.Effect<void, Error>;
  readonly canRecord: (threadId: ThreadId, generation: string) => boolean;
  readonly fail: (failure: Omit<NativeRecordingFailure, "createdAt">) => void;
  readonly subscribe: (listener: (failure: NativeRecordingFailure) => void) => () => void;
}
export class NativeCaptureState extends ServiceMap.Service<
  NativeCaptureState,
  NativeCaptureStateShape
>()("vibeinator/NativeCaptureState") {}

export const NativeCaptureStateLive = Layer.effect(
  NativeCaptureState,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Effect.scope;
    const active = new Map<ThreadId, Owner>();
    const failures = new Map<ThreadId, NativeRecordingFailure>();
    const listeners = new Set<(failure: NativeRecordingFailure) => void>();
    let overflow = false;
    const error = () => new Error(NATIVE_RECORDING_FAILURE_MESSAGE);
    const now = new Date().toISOString();
    yield* sql`UPDATE native_recording_sessions
    SET phase = 'failed', failure_reason = 'restart', failed_at = COALESCE(failed_at, ${now}), updated_at = ${now}
    WHERE phase IN ('starting', 'recording')`;
    const interrupted =
      yield* sql<NativeRecordingFailure>`SELECT thread_id AS "threadId", lifecycle_generation AS generation, provider,
    provider_instance_id AS "instanceId", failure_reason AS reason, COALESCE(failed_at, updated_at) AS "createdAt"
    FROM native_recording_sessions AS session WHERE phase = 'failed'
      AND sequence = (SELECT MAX(sequence) FROM native_recording_sessions WHERE thread_id = session.thread_id)
    ORDER BY sequence DESC LIMIT 1024`;
    for (const failure of interrupted) failures.set(failure.threadId, failure);
    const persistFailure = (
      failure: NativeRecordingFailure,
    ) => sql`INSERT INTO native_recording_sessions (
    thread_id, lifecycle_generation, provider, provider_instance_id, phase, failure_reason, failed_at, created_at, updated_at)
    SELECT ${failure.threadId}, ${failure.generation}, ${failure.provider}, ${failure.instanceId}, 'failed', ${failure.reason}, ${failure.createdAt}, ${failure.createdAt}, ${failure.createdAt}
    WHERE NOT EXISTS (SELECT 1 FROM native_recording_sessions WHERE thread_id = ${failure.threadId})
      OR EXISTS (SELECT 1 FROM native_recording_sessions WHERE thread_id = ${failure.threadId} AND lifecycle_generation = ${failure.generation})
    ON CONFLICT(thread_id, lifecycle_generation) DO UPDATE SET phase = 'failed',
      failure_reason = COALESCE(native_recording_sessions.failure_reason, excluded.failure_reason),
      failed_at = COALESCE(native_recording_sessions.failed_at, excluded.failed_at), updated_at = excluded.updated_at`;
    const fail: NativeCaptureStateShape["fail"] = (input) => {
      if (overflow) return;
      const current = active.get(input.threadId)?.lifecycleGeneration;
      if (current !== undefined && current !== input.generation) return;
      const failure = { ...input, createdAt: new Date().toISOString() };
      if (current === undefined || current === input.generation) {
        const existing = failures.get(input.threadId);
        if (existing?.generation === input.generation) return;
        if (failures.size >= 1024 && !existing) {
          overflow = true;
          // One notification per live owner closes work when the global fuse
          // trips. Retain their dirty intent instead of allocating more failures.
          for (const owner of active.values())
            for (const listener of listeners)
              listener({
                threadId: owner.threadId,
                generation: owner.lifecycleGeneration,
                provider: owner.provider,
                instanceId: owner.providerInstanceId,
                reason: "overflow",
                createdAt: failure.createdAt,
              });
          return;
        }
        failures.set(input.threadId, failure);
        for (const listener of listeners) listener(failure);
      }
      // One bounded metadata write per failed generation; the pre-launch intent survives if it cannot be saved.
      Effect.runFork(
        persistFailure(failure).pipe(
          Effect.timeout("1 second"),
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(scope),
        ),
      );
    };
    const canRecord = (threadId: ThreadId, generation: string) =>
      !overflow &&
      failures.get(threadId)?.generation !== generation &&
      (active.get(threadId) === undefined ||
        active.get(threadId)?.lifecycleGeneration === generation);
    const prepare = (owner: Owner, runtimeSessionId?: string) =>
      Effect.gen(function* () {
        // Explicit lifecycle preparation may claim a replacement generation;
        // an observed frame may only join its current owner, including after SQL yields.
        const ownsCapture = () =>
          runtimeSessionId === undefined || canRecord(owner.threadId, owner.lifecycleGeneration);
        if (
          overflow ||
          failures.get(owner.threadId)?.generation === owner.lifecycleGeneration ||
          !ownsCapture()
        )
          return yield* Effect.fail(error());
        const timestamp = new Date().toISOString();
        const owners =
          yield* sql`SELECT 1 FROM projection_threads AS thread JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.thread_id = ${owner.threadId} AND thread.deleted_at IS NULL AND project.deleted_at IS NULL`;
        if (!owners.length) return yield* Effect.fail(error());
        yield* sql`INSERT INTO native_recording_sessions (thread_id, lifecycle_generation, provider, provider_instance_id, runtime_session_id, phase, created_at, updated_at)
      VALUES (${owner.threadId}, ${owner.lifecycleGeneration}, ${owner.provider}, ${owner.providerInstanceId}, ${runtimeSessionId ?? null}, ${runtimeSessionId ? "recording" : "starting"}, ${timestamp}, ${timestamp})
      ON CONFLICT(thread_id, lifecycle_generation) DO UPDATE SET runtime_session_id = COALESCE(excluded.runtime_session_id, native_recording_sessions.runtime_session_id),
        phase = excluded.phase, updated_at = excluded.updated_at WHERE native_recording_sessions.phase != 'failed'`;
        const rows = yield* sql<{
          phase: string;
        }>`SELECT phase FROM native_recording_sessions WHERE thread_id = ${owner.threadId} AND lifecycle_generation = ${owner.lifecycleGeneration}`;
        if (
          rows[0]?.phase === "failed" ||
          overflow ||
          failures.get(owner.threadId)?.generation === owner.lifecycleGeneration ||
          !ownsCapture()
        )
          return yield* Effect.fail(error());
        active.set(owner.threadId, owner);
        failures.delete(owner.threadId);
      }).pipe(Effect.timeout("5 seconds"), Effect.mapError(error));
    const assertReady = (threadId: ThreadId) =>
      Effect.gen(function* () {
        if (overflow) return yield* Effect.fail(error());
        const rows = yield* sql<{
          generation: string;
          phase: string;
        }>`SELECT lifecycle_generation AS generation, phase
      FROM native_recording_sessions WHERE thread_id = ${threadId} ORDER BY sequence DESC LIMIT 1`;
        const row = rows[0];
        const failure = failures.get(threadId);
        if (failure && (!row || failure.generation === row.generation))
          return yield* Effect.fail(error());
        if (
          row &&
          (row.phase === "failed" ||
            (row.phase !== "stopped" &&
              active.get(threadId)?.lifecycleGeneration !== row.generation))
        )
          return yield* Effect.fail(error());
      }).pipe(Effect.timeout("5 seconds"), Effect.mapError(error));
    return {
      prepare: (owner) => prepare(owner),
      observe: (owner) => prepare(owner, owner.runtimeSessionId),
      assertReady,
      canRecord,
      fail,
      close: (threadId, generation) =>
        Effect.suspend(() => {
          const failure = failures.get(threadId);
          // A failed metadata write must leave dirty intent behind. Successful
          // process teardown cannot turn an unrecorded interval into a clean stop.
          if (failure?.generation === generation)
            return persistFailure(failure).pipe(Effect.asVoid);
          if (overflow) return Effect.void;
          return sql`UPDATE native_recording_sessions SET phase = 'stopped', updated_at = ${new Date().toISOString()}
            WHERE thread_id = ${threadId} AND lifecycle_generation = ${generation} AND phase != 'failed'`.pipe(
            Effect.asVoid,
          );
        }).pipe(
          Effect.timeout("1 second"),
          Effect.catchCause(() => Effect.void),
          Effect.tap(() =>
            Effect.sync(() => {
              if (active.get(threadId)?.lifecycleGeneration === generation) active.delete(threadId);
            }),
          ),
          Effect.asVoid,
        ),
      subscribe: (listener) => {
        listeners.add(listener);
        for (const failure of failures.values()) listener(failure);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies NativeCaptureStateShape;
  }),
).pipe(Layer.orDie);
