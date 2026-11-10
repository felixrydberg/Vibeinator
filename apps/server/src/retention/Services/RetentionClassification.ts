import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import type { SummaryStoreRepositoryError } from "../../persistence/Services/SummaryStore.ts";

export interface RetentionClassificationShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Process the durable backlog; interruption leaves the last committed section resumable. */
  readonly drain: Effect.Effect<void, PersistenceSqlError | SummaryStoreRepositoryError>;
}
export class RetentionClassification extends ServiceMap.Service<
  RetentionClassification,
  RetentionClassificationShape
>()("vibeinator/retention/RetentionClassification") {}
