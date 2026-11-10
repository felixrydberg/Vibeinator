import { Schema } from "effect";

export const DECISION_ENGINE_MAX_REQUEST_BYTES = 262_144;
export const DECISION_ENGINE_MAX_RESPONSE_BYTES = 131_072;
// Concentration threshold for an advisory answer, never a probability of correctness.
export const DECISION_ENGINE_MIN_CONFIDENCE = 0.5;
const Name = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_.-]{1,100}$/),
  Schema.makeFilter((name) => !["__proto__", "constructor", "prototype"].includes(name)),
);
export const DecisionChoiceQuestion = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  criteria: Schema.Record(Name, Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000)))).check(
    Schema.makeFilter(
      (criteria) => Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 26,
    ),
  ),
});
export const DecisionQuestions = Schema.Record(Name, DecisionChoiceQuestion).check(
  Schema.makeFilter(
    (questions) => Object.keys(questions).length >= 1 && Object.keys(questions).length <= 64,
  ),
);
export type DecisionQuestions = typeof DecisionQuestions.Type;
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const DecisionChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Name,
  probabilities: Schema.Record(Name, Probability),
  confidence: Probability,
});
const Answers = Schema.Record(Name, DecisionChoiceAnswer).check(
  Schema.makeFilter(
    (answers) => Object.keys(answers).length >= 1 && Object.keys(answers).length <= 64,
  ),
);
export const DecisionResponse = Schema.Struct({
  answers: Answers,
});
export const DecisionFallbackReason = Schema.Literals([
  "disabled",
  "invalid-request",
  "configuration",
  "credentials",
  "unavailable",
  "unauthorized",
  "timeout",
  "cancelled",
  "invalid-response",
  "uncertain",
]);
export type DecisionFallbackReason = typeof DecisionFallbackReason.Type;
export const DecisionResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("decided"), answers: Answers }),
  Schema.Struct({
    status: Schema.Literal("fallback"),
    reason: DecisionFallbackReason,
    retainInformation: Schema.Literal(true),
  }),
]);
export type DecisionResult = typeof DecisionResult.Type;

export const DecisionEngineEndpoint = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }),
);
export const DecisionEngineModel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^\S+$/),
);
export const DecisionEngineTimeout = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 100, maximum: 120_000 }),
);
export const DecisionEngineCredential = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[ -~]*$/),
);
export const DecisionEngineSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  endpoint: DecisionEngineEndpoint.pipe(
    Schema.withDecodingDefault(() => "http://localhost:11434/v1/systemone"),
  ),
  model: DecisionEngineModel.pipe(Schema.withDecodingDefault(() => "clef")),
  timeoutMs: DecisionEngineTimeout.pipe(Schema.withDecodingDefault(() => 5000)),
  credentialConfigured: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
