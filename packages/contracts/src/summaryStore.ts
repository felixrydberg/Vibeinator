import { Schema } from "effect";
import { NonNegativeInt, PositiveInt } from "./baseSchemas";
import {
  DurableRetentionCandidate,
  DurableSummaryRevision,
  InformationScope,
  InformationSource,
  InformationWatermark,
  RetentionCandidateId,
  SummaryRevisionId,
  DURABLE_SUMMARY_MAX_CHARS,
} from "./durableInformation";

export const SummarySnapshot = Schema.Struct({
  scope: InformationScope,
  epoch: PositiveInt,
  invalidatedAtSequence: NonNegativeInt,
  current: Schema.NullOr(DurableSummaryRevision),
});
export type SummarySnapshot = typeof SummarySnapshot.Type;
export const AppendSummaryCandidateInput = Schema.Struct({
  expectedEpoch: PositiveInt,
  candidate: DurableRetentionCandidate,
});
export type AppendSummaryCandidateInput = typeof AppendSummaryCandidateInput.Type;
export const CommitSummaryInput = Schema.Struct({
  scope: InformationScope,
  expectedEpoch: PositiveInt,
  expectedPreviousRevisionId: Schema.NullOr(SummaryRevisionId),
  text: Schema.String.check(Schema.isMaxLength(DURABLE_SUMMARY_MAX_CHARS)),
  sources: Schema.Array(InformationSource).check(Schema.isMaxLength(1000)),
  processedThrough: InformationWatermark,
  candidateIds: Schema.Array(RetentionCandidateId).check(Schema.isMaxLength(100)),
  generation: DurableSummaryRevision.fields.generation,
}).check(
  Schema.makeFilter(
    (value) =>
      (value.text.length === 0 || value.sources.length > 0) &&
      (value.candidateIds.length === 0 || value.text.length > 0),
  ),
);
export type CommitSummaryInput = typeof CommitSummaryInput.Type;
export const SummaryRevisionPageInput = Schema.Struct({
  scope: InformationScope,
  beforeSequence: Schema.optional(NonNegativeInt),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(50)),
});
export type SummaryRevisionPageInput = typeof SummaryRevisionPageInput.Type;
export const StoredSummaryRevision = Schema.Struct({
  sequence: PositiveInt,
  epoch: PositiveInt,
  revision: DurableSummaryRevision,
});
export type StoredSummaryRevision = typeof StoredSummaryRevision.Type;
export const StoredSummaryCandidate = Schema.Struct({
  epoch: PositiveInt,
  candidate: DurableRetentionCandidate,
});
export type StoredSummaryCandidate = typeof StoredSummaryCandidate.Type;
export const SummaryRevisionPage = Schema.Struct({
  entries: Schema.Array(StoredSummaryRevision),
  nextBeforeSequence: Schema.NullOr(PositiveInt),
});
export type SummaryRevisionPage = typeof SummaryRevisionPage.Type;
