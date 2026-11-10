import { DecisionEngineCredential } from "@synara/contracts";
import { Schema } from "effect";

export const DECISION_ENGINE_CREDENTIAL_SECRET = "decision-engine-credential";
export function encodeDecisionCredential(endpoint: string, credential: string | null): Uint8Array {
  const token = Schema.decodeUnknownSync(DecisionEngineCredential)(credential ?? "").trim();
  return new TextEncoder().encode(
    token ? JSON.stringify({ origin: new URL(endpoint).origin, token }) : "",
  );
}
export function readDecisionCredential(endpoint: string, bytes: Uint8Array | null): string | null {
  if (!bytes?.byteLength) return null;
  try {
    const stored: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      typeof stored !== "object" ||
      stored === null ||
      !("origin" in stored) ||
      !("token" in stored) ||
      stored.origin !== new URL(endpoint).origin
    )
      return null;
    return Schema.decodeUnknownSync(DecisionEngineCredential)(stored.token).trim() || null;
  } catch {
    return null;
  }
}
