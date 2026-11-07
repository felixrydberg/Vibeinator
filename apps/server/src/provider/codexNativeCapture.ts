import { NativeCaptureId, ProjectId, RuntimeSessionId, type ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  NativeArchiveRepository,
  type AppendNativeCapture,
} from "../persistence/Services/NativeArchive.ts";

const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_FRAMES = 256;
const CAPTURE_TIMEOUT_MS = 5_000;
const AUTH_METHOD =
  /^(?:account\/(?:read$|login\/start$|logout$|chatgptAuthTokens\/)|mcpServer\/oauth\/|rpc\/unmatchedResponse$)/u;
const SETUP_METHOD = /^(?:initialize$|initialized$|config\/)/u;
const CREDENTIAL_KEY =
  /^(?:authorization|proxyauthorization|cookie|setcookie|password|clientsecret|credentials?)$|(?:apikey|accesstoken|refreshtoken|idtoken|sessiontoken|bearertoken)$/u;
const credentialKey = (key: string) => CREDENTIAL_KEY.test(key.replace(/[-_]/gu, "").toLowerCase());
const environmentKey = (key: string, value: unknown) =>
  /^(?:env|environment)$/iu.test(key) &&
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).length > 0;

export function codexCaptureExclusion(
  method: string,
  envelope: unknown,
): "authentication-exchange" | "credential-material" | undefined {
  if (AUTH_METHOD.test(method)) return "authentication-exchange";
  if (SETUP_METHOD.test(method)) return "credential-material";
  const pending = [envelope];
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (credentialKey(key) || environmentKey(key, child)) return "credential-material";
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return undefined;
}

/** Protocol handling uses the original object; diagnostic/UI events never carry known credentials. */
export function codexPublishedPayload(method: string, payload: unknown): unknown {
  const exclusion = codexCaptureExclusion(method, payload);
  if (!exclusion) return payload;
  if (exclusion === "authentication-exchange" || SETUP_METHOD.test(method))
    return { captureExcluded: exclusion };
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) =>
      credentialKey(key) || environmentKey(key, value) ? "[redacted]" : value,
    ),
  );
}

export interface CodexNativeCaptureOwner {
  readonly threadId: ThreadId;
  readonly providerInstanceId: string;
  readonly runtimeSessionId: string;
  readonly lifecycleGeneration: string;
}
export interface CodexNativeCaptureFrame {
  readonly direction: "incoming" | "outgoing";
  readonly method: string;
  readonly rawJson: string;
  readonly envelope: Record<string, unknown>;
  readonly nativeSessionId?: string | undefined;
  readonly sensitiveResponse?: boolean | undefined;
}
export interface CodexNativeCaptureLane {
  readonly record: (frame: CodexNativeCaptureFrame) => Promise<NativeCaptureId>;
  readonly drain: () => Promise<void>;
  readonly pending: () => number;
}
export type CodexNativeCaptureFactory = (owner: CodexNativeCaptureOwner) => CodexNativeCaptureLane;

const captureError = () => new Error("Codex native capture failed; recording stopped.");
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | null =>
  typeof value === "string" && value.length !== 0 ? value : null;

/** Production factory captures at owned stdio ingress, before the manager/adapter shape payloads. */
export const makeCodexNativeCapture = Effect.gen(function* () {
  const archive = yield* NativeArchiveRepository;
  const sql = yield* SqlClient.SqlClient;
  return ((owner) => {
    let ordinal = 0;
    let pendingCount = 0;
    let pendingBytes = 0;
    let failed = false;
    let tail = Promise.resolve();
    let projectId: ProjectId | undefined;
    return {
      pending: () => pendingCount,
      drain: () => tail,
      record: (frame) => {
        const bytes = Buffer.byteLength(frame.rawJson, "utf8");
        if (
          failed ||
          pendingCount >= MAX_PENDING_FRAMES ||
          pendingBytes + bytes > MAX_PENDING_BYTES
        ) {
          failed = true;
          return Promise.reject(captureError());
        }
        const ingressOrdinal = ++ordinal;
        const observedAtMs = Date.now();
        const observedAt = new Date(observedAtMs).toISOString();
        const exclusion = frame.sensitiveResponse
          ? "credential-material"
          : codexCaptureExclusion(frame.method, frame.envelope);
        const params = object(frame.envelope.params) ?? object(frame.envelope.result);
        const nativeId = frame.envelope.id;
        const metadata = {
          schemaVersion: 1 as const,
          nativeSessionId: exclusion
            ? null
            : (string(params?.threadId) ??
              string(object(params?.thread)?.id) ??
              frame.nativeSessionId ??
              null),
          nativeEventId:
            exclusion || (typeof nativeId !== "number" && typeof nativeId !== "string")
              ? null
              : JSON.stringify(nativeId),
          nativeTurnId: exclusion
            ? null
            : (string(params?.turnId) ?? string(object(params?.turn)?.id)),
          nativeItemId: exclusion
            ? null
            : (string(params?.itemId) ?? string(object(params?.item)?.id)),
          payloadType: `${frame.direction}:${exclusion ? "excluded" : /^[\w/.-]{1,160}$/u.test(frame.method) ? frame.method : "unmapped"}`,
          direction: frame.direction,
          observedAt,
          capturePolicyVersion: 1,
        };
        // Excluded frames retain no raw content in the storage queue.
        const content = exclusion
          ? undefined
          : { encoding: "utf8-json" as const, text: frame.rawJson };
        pendingCount++;
        pendingBytes += bytes;
        const operation = tail
          .then(async () => {
            const remainingMs = CAPTURE_TIMEOUT_MS - (Date.now() - observedAtMs);
            if (failed || remainingMs <= 0) {
              failed = true;
              throw captureError();
            }
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const write = Effect.gen(function* () {
                if (projectId === undefined) {
                  const rows = yield* sql<{
                    projectId: string;
                  }>`SELECT thread.project_id AS "projectId" FROM projection_threads AS thread
                  JOIN projection_projects AS project ON project.project_id = thread.project_id
                  WHERE thread.thread_id = ${owner.threadId} AND thread.deleted_at IS NULL AND project.deleted_at IS NULL`;
                  if (!rows[0]) return yield* Effect.fail(captureError());
                  projectId = ProjectId.makeUnsafe(rows[0].projectId);
                }
                const input: AppendNativeCapture = {
                  ...metadata,
                  identity: {
                    projectId,
                    threadId: owner.threadId,
                    ingressOrdinal,
                    session: {
                      provider: "codex",
                      providerInstanceId: owner.providerInstanceId,
                      runtimeSessionId: RuntimeSessionId.makeUnsafe(owner.runtimeSessionId),
                      lifecycleGeneration: owner.lifecycleGeneration,
                    },
                  },
                  ...(content
                    ? { disposition: "retained", content }
                    : { disposition: "excluded", reason: exclusion! }),
                };
                return yield* archive.appendCapture(input);
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
              throw captureError();
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          })
          .finally(() => {
            pendingCount--;
            pendingBytes -= bytes;
          });
        // The next frame gets a bounded admission decision even after an earlier failure.
        tail = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
    };
  }) satisfies CodexNativeCaptureFactory;
});
