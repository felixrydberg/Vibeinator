import type { DecisionQuestions, DecisionResult } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface DecisionEngineShape {
  /** Advisory labels only: never execution, approval, argument generation or completion authority. */
  readonly decide: (
    state: unknown,
    questions: DecisionQuestions,
    options?: { readonly signal?: AbortSignal },
  ) => Effect.Effect<DecisionResult>;
}
export class DecisionEngine extends ServiceMap.Service<DecisionEngine, DecisionEngineShape>()(
  "vibeinator/DecisionEngine",
) {}
