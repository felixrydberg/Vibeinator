import {
  DECISION_ENGINE_MAX_REQUEST_BYTES,
  DECISION_ENGINE_MAX_RESPONSE_BYTES,
  DECISION_ENGINE_MIN_CONFIDENCE,
  DecisionEngineSettings,
  DecisionQuestions,
  DecisionResponse,
  type DecisionFallbackReason,
  type DecisionResult,
} from "@synara/contracts";
import { canonicalizeJson } from "@synara/shared/canonicalJson";
import { outboundHttp, decodeOutboundJson, OutboundHttpError } from "@synara/shared/outboundHttp";
import { assertJsonWithinLimits } from "@synara/shared/outboundHttpPolicy";
import { Effect, Layer, Schema } from "effect";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { DECISION_ENGINE_CREDENTIAL_SECRET, readDecisionCredential } from "../credentials.ts";
import { DecisionEngine, type DecisionEngineShape } from "../Services/DecisionEngine.ts";

const fallback = (reason: DecisionFallbackReason): DecisionResult => ({
  status: "fallback",
  reason,
  retainInformation: true,
});
const invalidResponse = () => new Error("Invalid decision response.");
export const makeDecisionEngine = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const secrets = yield* ServerSecretStore;
  const decide: DecisionEngineShape["decide"] = (state, questions, options) =>
    Effect.gen(function* () {
      if (options?.signal?.aborted) return fallback("cancelled");
      const config = yield* settings.getSettings.pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(DecisionEngineSettings)(value.decisionEngine),
        ),
        Effect.result,
      );
      if (config._tag === "Failure") return fallback("configuration");
      if (!config.success.enabled) return fallback("disabled");
      const prepared = yield* Effect.try({
        try: () => {
          assertJsonWithinLimits({ state, questions }, { maxDepth: 16, maxNodes: 10_000 });
          // Reject non-JSON values/prototypes/cycles without invoking user-defined serialization.
          const checkedState = canonicalizeJson(state);
          const checked = Schema.decodeUnknownSync(DecisionQuestions)(questions);
          let textChars = 0;
          const body = JSON.stringify(
            { model: config.success.model, state: checkedState, questions: checked },
            (key, value: unknown) => {
              textChars += key.length + (typeof value === "string" ? value.length : 0);
              if (textChars > DECISION_ENGINE_MAX_REQUEST_BYTES) throw new Error();
              return value;
            },
          );
          if (Buffer.byteLength(body, "utf8") > DECISION_ENGINE_MAX_REQUEST_BYTES)
            throw new Error();
          return { body, questions: checked };
        },
        catch: () => "invalid-request" as const,
      }).pipe(Effect.result);
      if (prepared._tag === "Failure") return fallback("invalid-request");
      const secret = yield* secrets.get(DECISION_ENGINE_CREDENTIAL_SECRET).pipe(Effect.result);
      if (secret._tag === "Failure") return fallback("credentials");
      const credential = readDecisionCredential(config.success.endpoint, secret.success);
      if (config.success.credentialConfigured && !credential) return fallback("credentials");
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          outboundHttp.request({
            url: config.success.endpoint,
            method: "POST",
            body: prepared.success.body,
            headers: {
              "Content-Type": "application/json",
              ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
            },
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
            policy: {
              service: "decision-engine",
              allowedOrigins: [new URL(config.success.endpoint).origin],
              timeoutMs: config.success.timeoutMs,
              maxRequestBytes: DECISION_ENGINE_MAX_REQUEST_BYTES,
              maxResponseBytes: DECISION_ENGINE_MAX_RESPONSE_BYTES,
              maxRedirects: 0,
              maxConcurrent: 1,
              maxQueued: 4,
              allowLoopbackHttp: true,
              requirePublicAddress: true,
            },
          }),
        catch: (error): DecisionFallbackReason => {
          if (options?.signal?.aborted) return "cancelled";
          if (error instanceof OutboundHttpError) {
            if (error.code === "timeout") return "timeout";
            if (error.code === "response-too-large" || error.code === "compressed-response")
              return "invalid-response";
          }
          return "unavailable";
        },
      }).pipe(Effect.result);
      if (response._tag === "Failure") return fallback(response.failure);
      if (options?.signal?.aborted) return fallback("cancelled");
      if (response.success.status === 401 || response.success.status === 403)
        return fallback("unauthorized");
      if (response.success.status < 200 || response.success.status >= 300)
        return fallback("unavailable");
      const decoded = yield* Effect.try({
        try: () => {
          const answer = Schema.decodeUnknownSync(DecisionResponse)(
            decodeOutboundJson(response.success, { maxDepth: 8, maxNodes: 5000 }),
          );
          const names = Object.keys(prepared.success.questions);
          if (Object.keys(answer.answers).length !== names.length) throw invalidResponse();
          let uncertain = false;
          for (const name of names) {
            const value = answer.answers[name];
            const choices = Object.keys(prepared.success.questions[name]!.criteria);
            if (
              !value ||
              !choices.includes(value.choice) ||
              Object.keys(value.probabilities).length !== choices.length ||
              choices.some((choice) => !Object.hasOwn(value.probabilities, choice))
            )
              throw invalidResponse();
            const probabilities = choices.map((choice) => value.probabilities[choice]!);
            const maximum = Math.max(...probabilities);
            if (
              Math.abs(probabilities.reduce((sum, probability) => sum + probability, 0) - 1) >
                0.001 ||
              value.probabilities[value.choice] !== maximum
            )
              throw invalidResponse();
            uncertain ||=
              value.confidence < DECISION_ENGINE_MIN_CONFIDENCE ||
              probabilities.filter((probability) => Math.abs(probability - maximum) < 1e-9).length >
                1;
          }
          return uncertain
            ? fallback("uncertain")
            : { status: "decided" as const, answers: answer.answers };
        },
        catch: () => "invalid-response" as const,
      }).pipe(Effect.result);
      return decoded._tag === "Failure" ? fallback("invalid-response") : decoded.success;
    });
  return { decide } satisfies DecisionEngineShape;
});
export const DecisionEngineLive = Layer.effect(DecisionEngine, makeDecisionEngine);
