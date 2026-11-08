import type {
  AppendSummaryCandidateInput,
  CommitSummaryInput,
  DurableRetentionCandidate,
  DurableSummaryRevision,
  InformationScope,
  RetentionCandidateId,
  SummaryRevisionPageInput,
  SummaryRevisionPage,
  SummarySnapshot,
  SummaryRevisionId,
  StoredSummaryRevision,
  StoredSummaryCandidate,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { PersistenceSqlError } from "../Errors.ts";

export class SummaryStoreError extends Schema.TaggedErrorClass<SummaryStoreError>()(
  "SummaryStoreError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "ownership",
      "conflict",
      "source-unavailable",
      "watermark",
      "integrity",
    ]),
  },
) {}
export type SummaryStoreRepositoryError = SummaryStoreError | PersistenceSqlError;
export interface SummaryStoreRepositoryShape {
  readonly get: (
    scope: InformationScope,
  ) => Effect.Effect<SummarySnapshot, SummaryStoreRepositoryError>;
  readonly appendCandidate: (
    input: AppendSummaryCandidateInput,
  ) => Effect.Effect<DurableRetentionCandidate, SummaryStoreRepositoryError>;
  readonly getCandidate: (
    scope: InformationScope,
    candidateId: RetentionCandidateId,
  ) => Effect.Effect<StoredSummaryCandidate | null, SummaryStoreRepositoryError>;
  readonly getRevision: (
    scope: InformationScope,
    revisionId: SummaryRevisionId,
  ) => Effect.Effect<StoredSummaryRevision | null, SummaryStoreRepositoryError>;
  readonly listPending: (
    scope: InformationScope,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<DurableRetentionCandidate>, SummaryStoreRepositoryError>;
  readonly commit: (
    input: CommitSummaryInput,
  ) => Effect.Effect<DurableSummaryRevision, SummaryStoreRepositoryError>;
  readonly listRevisions: (
    input: SummaryRevisionPageInput,
  ) => Effect.Effect<SummaryRevisionPage, SummaryStoreRepositoryError>;
}
export class SummaryStoreRepository extends ServiceMap.Service<
  SummaryStoreRepository,
  SummaryStoreRepositoryShape
>()("vibeinator/persistence/SummaryStore") {}
