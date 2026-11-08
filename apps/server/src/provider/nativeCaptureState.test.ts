import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { NativeArchiveRepositoryLive } from "../persistence/Layers/NativeArchive.ts";
import {
  NativeCaptureState,
  NativeCaptureStateLive,
  NATIVE_RECORDING_FAILURE_MESSAGE,
} from "./nativeCaptureState.ts";
import { makeNativeCapture } from "./nativeCapture.ts";

const threadId = ThreadId.makeUnsafe("recording-thread");
const owner = {
  threadId,
  provider: "codex",
  providerInstanceId: "codex",
  lifecycleGeneration: "generation-1",
  runtimeSessionId: "runtime-1",
};
const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('recording-project', 'Synthetic', '/synthetic', '[]', '2026-11-07', '2026-11-07')`;
  yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, 'recording-project', 'Synthetic', '2026-11-07', '2026-11-07')`;
});
const frame = (text: string) => ({
  schemaVersion: 1 as const,
  nativeSessionId: null,
  nativeEventId: null,
  nativeItemId: null,
  nativeTurnId: null,
  payloadType: "synthetic",
  direction: "incoming" as const,
  capturePolicyVersion: 1,
  disposition: "retained" as const,
  content: { encoding: "utf8-json" as const, text },
});
const withState = <A, E>(
  program: Effect.Effect<
    A,
    E,
    | NativeCaptureState
    | SqlClient.SqlClient
    | import("../persistence/Services/NativeArchive.ts").NativeArchiveRepository
  >,
) =>
  program.pipe(Effect.provide(NativeCaptureStateLive), Effect.provide(NativeArchiveRepositoryLive));

describe("native recording readiness", () => {
  it("closes readiness and notifies live owners once when the bounded failure registry is full", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE failures(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM failures WHERE n < 1024)
        INSERT INTO native_recording_sessions(thread_id, lifecycle_generation, provider, provider_instance_id, phase, failure_reason, failed_at, created_at, updated_at)
        SELECT 'historical-' || n, 'old', 'codex', 'codex', 'failed', 'restart', '2026-11-07', '2026-11-07', '2026-11-07' FROM failures`;
        yield* withState(
          Effect.gen(function* () {
            const state = yield* NativeCaptureState;
            yield* state.prepare(owner);
            const notifications: string[] = [];
            const unsubscribe = state.subscribe((failure) =>
              notifications.push(`${failure.threadId}:${failure.reason}`),
            );
            notifications.length = 0;
            for (let attempt = 0; attempt < 3; attempt++)
              state.fail({
                threadId,
                generation: owner.lifecycleGeneration,
                provider: "codex",
                instanceId: "codex",
                reason: "journal",
              });
            expect(notifications).toEqual([`${threadId}:overflow`]);
            expect(state.canRecord(threadId, owner.lifecycleGeneration)).toBe(false);
            expect((yield* Effect.flip(state.assertReady(threadId))).message).toBe(
              NATIVE_RECORDING_FAILURE_MESSAGE,
            );
            yield* state.close(threadId, owner.lifecycleGeneration);
            expect(
              yield* sql`SELECT phase FROM native_recording_sessions WHERE thread_id = ${threadId}`,
            ).toEqual([{ phase: "starting" }]);
            unsubscribe();
          }),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped),
    );
  });

  it.each(["disk-full", "read-only", "malformed"] as const)(
    "latches %s capture failure, retains committed data and requires a new runtime generation",
    async (mode) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* seed;
          yield* withState(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const state = yield* NativeCaptureState;
              const lane = (yield* makeNativeCapture)(owner);
              const failures: string[] = [];
              const unsubscribe = state.subscribe((failure) => failures.push(failure.reason));
              yield* state.prepare(owner);
              yield* Effect.promise(() => lane.record(frame('{"text":"committed"}')));
              const before = yield* sql`SELECT capture_id, payload_id FROM native_captures`;
              yield* sql`CREATE TRIGGER reject_failure_marker BEFORE UPDATE ON native_recording_sessions
                WHEN NEW.phase = 'failed' BEGIN SELECT RAISE(ABORT, 'failure metadata unavailable'); END`;
              if (mode === "disk-full") {
                const pages = yield* sql<{ page_count: number }>`PRAGMA page_count`;
                yield* sql`PRAGMA max_page_count = ${sql.literal(String(pages[0]!.page_count + 2))}`;
              } else if (mode === "read-only") yield* sql`PRAGMA query_only = ON`;
              const text =
                mode === "malformed"
                  ? "{broken"
                  : JSON.stringify({ text: "overflow".repeat(500_000) });
              yield* Effect.promise(async () => {
                await expect(lane.record(frame(text))).rejects.toThrow("recording stopped");
              });
              expect(yield* sql`SELECT capture_id, payload_id FROM native_captures`).toEqual(
                before,
              );
              if (mode === "disk-full") yield* sql`PRAGMA max_page_count = 2147483646`;
              else if (mode === "read-only") yield* sql`PRAGMA query_only = OFF`;
              expect((yield* Effect.flip(state.assertReady(threadId))).message).toBe(
                NATIVE_RECORDING_FAILURE_MESSAGE,
              );
              yield* Effect.promise(async () => {
                await expect(
                  lane.record(frame('{"text":"must not retry execution"}')),
                ).rejects.toThrow();
              });
              expect(failures).toEqual(["capture"]);
              yield* state.close(threadId, owner.lifecycleGeneration);
              expect(yield* sql`SELECT phase FROM native_recording_sessions`).toEqual([
                { phase: "recording" },
              ]);
              yield* sql`DROP TRIGGER reject_failure_marker`;
              expect((yield* Effect.flip(state.assertReady(threadId))).message).toBe(
                NATIVE_RECORDING_FAILURE_MESSAGE,
              );
              const next = {
                ...owner,
                lifecycleGeneration: "generation-2",
                runtimeSessionId: "runtime-2",
              };
              yield* state.prepare(next);
              yield* state.assertReady(threadId);
              expect((yield* Effect.result(state.observe(owner)))._tag).toBe("Failure");
              yield* state.assertReady(threadId);
              // A late callback from the retired process cannot poison the replacement runtime.
              state.fail({
                threadId,
                generation: owner.lifecycleGeneration,
                provider: "codex",
                instanceId: "codex",
                reason: "journal",
              });
              yield* state.assertReady(threadId);
              const replacement = (yield* makeNativeCapture)(next);
              yield* Effect.promise(() => replacement.record(frame('{"text":"recovered"}')));
              expect(yield* sql`SELECT COUNT(*) AS count FROM native_captures`).toEqual([
                { count: 2 },
              ]);
              yield* Effect.promise(() => replacement.close());
              unsubscribe();
            }),
          );
        }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped),
      );
    },
  );

  it("recovers dirty startup intent across database reopen, persists one stable failure and leaves clean stops ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeinator-recording-restart-"));
    const filename = join(directory, "state.sqlite");
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.runPromise(
        effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename })), Effect.scoped),
      );
    try {
      await run(
        Effect.gen(function* () {
          yield* seed;
          yield* withState(
            Effect.gen(function* () {
              const state = yield* NativeCaptureState;
              yield* state.prepare(owner);
            }),
          );
        }),
      );
      let firstFailureAt: string | undefined;
      for (let restart = 0; restart < 2; restart++)
        await run(
          withState(
            Effect.gen(function* () {
              const state = yield* NativeCaptureState;
              expect((yield* Effect.flip(state.assertReady(threadId))).message).toBe(
                NATIVE_RECORDING_FAILURE_MESSAGE,
              );
              const failures: Array<{ createdAt: string; reason: string }> = [];
              const unsubscribe = state.subscribe((failure) => failures.push(failure));
              expect(failures).toHaveLength(1);
              expect(failures[0]?.reason).toBe("restart");
              firstFailureAt ??= failures[0]!.createdAt;
              expect(failures[0]?.createdAt).toBe(firstFailureAt);
              unsubscribe();
            }),
          ),
        );
      await run(
        withState(
          Effect.gen(function* () {
            const state = yield* NativeCaptureState;
            yield* state.prepare({ ...owner, lifecycleGeneration: "generation-clean" });
            yield* state.close(threadId, "generation-clean");
          }),
        ),
      );
      await run(
        withState(
          Effect.gen(function* () {
            const state = yield* NativeCaptureState;
            yield* state.assertReady(threadId);
            const failures: unknown[] = [];
            state.subscribe((failure) => failures.push(failure))();
            expect(failures).toEqual([]);
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
