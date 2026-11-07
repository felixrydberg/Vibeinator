import { Effect } from "effect";
import type { NativeCaptureId } from "@synara/contracts";
import { isSensitiveKey, redactSensitiveJsonFields } from "../sensitiveKeys.ts";
import { makeNativeCapture, type NativeCaptureOwner } from "./nativeCapture.ts";

const environment = (key: string, value: unknown) =>
  /^(?:env|environment)$/iu.test(key) &&
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).length > 0;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const credential = (key: string, value: unknown) =>
  key === "tokens" && typeof value === "number" ? false : isSensitiveKey(key);

function exclusion(
  method: string,
  payload: unknown,
  strict = false,
): "authentication-exchange" | "credential-material" | undefined {
  if (method === "query/options") return "credential-material";
  const object = record(payload);
  if (
    object?.type === "auth_status" &&
    ((Array.isArray(object.output) && object.output.length > 0) || object.error)
  )
    return "authentication-exchange";
  if (/^claude\/(?:login|oauth|token-exchange)(?:\/|$)/u.test(method))
    return "authentication-exchange";
  const pending = [payload];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (strict && !Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new Error("Non-JSON SDK object");
    if (strict && Array.isArray(value)) {
      for (let index = 0; index < value.length; index++)
        if (!(index in value) || value[index] === undefined) throw new Error("Non-JSON SDK array");
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        strict &&
        (typeof child === "function" || typeof child === "symbol" || typeof child === "bigint")
      )
        throw new Error("Non-JSON SDK field");
      if (credential(key, child) || environment(key, child)) return "credential-material";
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return undefined;
}

/** Redact publication only; permission handling continues to use the SDK input. */
export function claudePublishedPayload<A>(method: string, payload: A): A {
  const reason = exclusion(method, payload);
  if (!reason) return payload;
  if (reason === "authentication-exchange") {
    const object = record(payload);
    return {
      type: "auth_status",
      isAuthenticating: object?.isAuthenticating === true,
      output: [],
    } as A;
  }
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) =>
      environment(key, value)
        ? "[redacted]"
        : credential(key, value)
          ? redactSensitiveJsonFields(key, value)
          : value,
    ),
  ) as A;
}

export interface ClaudeCaptureFrame {
  readonly method: string;
  readonly payload: unknown;
  readonly direction: "incoming" | "outgoing";
  readonly nativeSessionId?: string | undefined;
  readonly nativeEventId?: string | undefined;
  readonly nativeTurnId?: string | undefined;
  readonly nativeItemId?: string | undefined;
}
export interface ClaudeNativeCaptureLane {
  readonly record: (frame: ClaudeCaptureFrame) => Promise<NativeCaptureId>;
  readonly drain: () => Promise<void>;
}
export type ClaudeNativeCaptureFactory = (
  owner: Omit<NativeCaptureOwner, "provider">,
) => ClaudeNativeCaptureLane;

export const makeClaudeNativeCapture = Effect.gen(function* () {
  const makeLane = yield* makeNativeCapture;
  return ((owner) => {
    const lane = makeLane({ ...owner, provider: "claudeAgent" });
    let failed = false;
    return {
      drain: lane.drain,
      record: (frame) => {
        try {
          if (failed) throw new Error("Claude native capture failed; recording stopped.");
          const reason = exclusion(frame.method, frame.payload, true);
          // The SDK provides decoded objects, not original transport whitespace.
          const text =
            frame.method === "query/options"
              ? undefined
              : JSON.stringify(frame.payload, (_key, value: unknown) => {
                  if (
                    typeof value === "function" ||
                    typeof value === "symbol" ||
                    typeof value === "bigint" ||
                    (typeof value === "number" && !Number.isFinite(value))
                  )
                    throw new Error("Non-JSON SDK value");
                  return value;
                });
          if (!reason && text === undefined) throw new Error("Missing SDK JSON value");
          return lane
            .record(
              {
                schemaVersion: 1,
                capturePolicyVersion: 1,
                direction: frame.direction,
                payloadType: `${frame.direction}:${reason ? "excluded" : /^[\w/.-]{1,160}$/u.test(frame.method) ? frame.method : "unmapped"}`,
                nativeSessionId: reason ? null : (frame.nativeSessionId ?? null),
                nativeEventId: reason ? null : (frame.nativeEventId ?? null),
                nativeTurnId: reason ? null : (frame.nativeTurnId ?? null),
                nativeItemId: reason ? null : (frame.nativeItemId ?? null),
                ...(reason
                  ? { disposition: "excluded", reason }
                  : { disposition: "retained", content: { encoding: "utf8-json", text: text! } }),
              },
              text === undefined ? 0 : Buffer.byteLength(text, "utf8"),
            )
            .catch(() => {
              failed = true;
              throw new Error("Claude native capture failed; recording stopped.");
            });
        } catch {
          failed = true;
          return Promise.reject(new Error("Claude native capture failed; recording stopped."));
        }
      },
    };
  }) satisfies ClaudeNativeCaptureFactory;
});
