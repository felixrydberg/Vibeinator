import {
  ProjectId,
  RuntimeSessionId,
  type NativeCaptureId,
  type ProviderDriverKind,
  type ThreadId,
} from "@synara/contracts";
import { Effect, Option, ServiceMap } from "effect";
import { NativeCaptureState } from "./nativeCaptureState.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  NativeArchiveRepository,
  type AppendNativeCapture,
} from "../persistence/Services/NativeArchive.ts";

export interface NativeCaptureOwner {
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerInstanceId: string;
  readonly runtimeSessionId: string;
  readonly lifecycleGeneration: string;
}
export type NativeCaptureFrame =
  | Omit<Extract<AppendNativeCapture, { disposition: "retained" }>, "identity" | "observedAt">
  | Omit<Extract<AppendNativeCapture, { disposition: "excluded" }>, "identity" | "observedAt">;
export interface NativeCaptureLane {
  readonly close: () => Promise<void>;
  readonly record: (frame: NativeCaptureFrame, observedBytes?: number) => Promise<NativeCaptureId>;
  readonly drain: () => Promise<void>;
  readonly pending: () => number;
}
export type NativeCaptureFactory = (owner: NativeCaptureOwner) => NativeCaptureLane;

/** Fiber-local provenance: concurrent SDK callbacks cannot relabel another message. */
export class NativeCaptureOrigin extends ServiceMap.Service<NativeCaptureOrigin, NativeCaptureId>()(
  "vibeinator/NativeCaptureOrigin",
) {}

/** Session-owned storage only; providers retain protocol policy and execution ownership. */
export const makeNativeCapture = Effect.gen(function* () {
  const archive = yield* NativeArchiveRepository;
  const sql = yield* SqlClient.SqlClient;
  const state = Option.getOrUndefined(yield* Effect.serviceOption(NativeCaptureState));
  return ((owner) => {
    let ordinal = 0;
    let pendingCount = 0;
    let pendingBytes = 0;
    let failed = false;
    let closed = false;
    let observed = false;
    let tail = Promise.resolve();
    let projectId: ProjectId | undefined;
    const captureError = () =>
      new Error(
        `${owner.provider === "codex" ? "Codex" : owner.provider === "claudeAgent" ? "Claude" : owner.provider} native capture failed; recording stopped.`,
      );
    const noteFailure = () =>
      state?.fail({
        threadId: owner.threadId,
        generation: owner.lifecycleGeneration,
        provider: owner.provider,
        instanceId: owner.providerInstanceId,
        reason: "capture",
      });
    return {
      pending: () => pendingCount,
      drain: () => tail,
      close: async () => {
        closed = true;
        await tail;
        if (state) await Effect.runPromise(state.close(owner.threadId, owner.lifecycleGeneration));
      },
      record: (frame: NativeCaptureFrame, observedBytes?: number) => {
        const bytes =
          observedBytes ??
          (frame.disposition === "retained" ? Buffer.byteLength(frame.content.text, "utf8") : 0);
        if (
          failed ||
          closed ||
          (state && !state.canRecord(owner.threadId, owner.lifecycleGeneration)) ||
          pendingCount >= 256 ||
          pendingBytes + bytes > 32 * 1024 * 1024
        ) {
          failed = true;
          if (!closed) noteFailure();
          return Promise.reject(captureError());
        }
        const ingressOrdinal = ++ordinal;
        const observedAtMs = Date.now();
        const observedAt = new Date(observedAtMs).toISOString();
        pendingCount++;
        pendingBytes += bytes;
        const operation = tail
          .then(async () => {
            const remainingMs = 5_000 - (Date.now() - observedAtMs);
            if (failed || remainingMs <= 0) {
              failed = true;
              noteFailure();
              throw captureError();
            }
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const write = Effect.gen(function* () {
                if (state && !observed) {
                  yield* state.observe(owner);
                  observed = true;
                }
                if (state && !state.canRecord(owner.threadId, owner.lifecycleGeneration))
                  return yield* Effect.fail(captureError());
                if (projectId === undefined) {
                  const rows = yield* sql<{
                    projectId: string;
                  }>`SELECT thread.project_id AS "projectId" FROM projection_threads AS thread
                  JOIN projection_projects AS project ON project.project_id = thread.project_id
                  WHERE thread.thread_id = ${owner.threadId} AND thread.deleted_at IS NULL AND project.deleted_at IS NULL`;
                  if (!rows[0]) return yield* Effect.fail(captureError());
                  projectId = ProjectId.makeUnsafe(rows[0].projectId);
                }
                return yield* archive.appendCapture({
                  ...frame,
                  observedAt,
                  identity: {
                    projectId,
                    threadId: owner.threadId,
                    ingressOrdinal,
                    session: {
                      provider: owner.provider,
                      providerInstanceId: owner.providerInstanceId,
                      runtimeSessionId: RuntimeSessionId.makeUnsafe(owner.runtimeSessionId),
                      lifecycleGeneration: owner.lifecycleGeneration,
                    },
                  },
                });
              });
              const result = await Promise.race([
                Effect.runPromise(write, { signal: controller.signal }),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => {
                    controller.abort();
                    reject(captureError());
                  }, remainingMs);
                  timer.unref?.();
                }),
              ]);
              return result.captureId;
            } catch {
              failed = true;
              noteFailure();
              throw captureError();
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          })
          .finally(() => {
            pendingCount--;
            pendingBytes -= bytes;
          });
        tail = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
    };
  }) satisfies NativeCaptureFactory;
});
