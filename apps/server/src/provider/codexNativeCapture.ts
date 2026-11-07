import type { NativeCaptureId, ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import { makeNativeCapture } from "./nativeCapture.ts";

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

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | null =>
  typeof value === "string" && value.length !== 0 ? value : null;

/** Production factory captures at owned stdio ingress, before the manager/adapter shape payloads. */
export const makeCodexNativeCapture = Effect.gen(function* () {
  const makeLane = yield* makeNativeCapture;
  return ((owner) => {
    const lane = makeLane({ ...owner, provider: "codex" });
    return {
      pending: lane.pending,
      drain: lane.drain,
      record: (frame) => {
        const exclusion = frame.sensitiveResponse
          ? "credential-material"
          : codexCaptureExclusion(frame.method, frame.envelope);
        const params = object(frame.envelope.params) ?? object(frame.envelope.result);
        const nativeId = frame.envelope.id;
        return lane.record(
          {
            schemaVersion: 1,
            capturePolicyVersion: 1,
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
            ...(exclusion
              ? { disposition: "excluded", reason: exclusion }
              : {
                  disposition: "retained",
                  content: { encoding: "utf8-json", text: frame.rawJson },
                }),
          },
          Buffer.byteLength(frame.rawJson, "utf8"),
        );
      },
    };
  }) satisfies CodexNativeCaptureFactory;
});
