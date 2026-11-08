import { Schema } from "effect";
import { ThreadId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const HISTORY_RESPONSE_MAX_CHARS = 12_000;
export const HistorySourceKind = Schema.Literals(["event", "payload"]);
export const ProjectHistorySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  threadId: Schema.optional(ThreadId),
  includeArchived: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
});
export type ProjectHistorySearchInput = typeof ProjectHistorySearchInput.Type;
export const ProjectHistoryReadInput = Schema.Struct({
  threadId: ThreadId,
  sourceKind: HistorySourceKind,
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  sourceVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  includeArchived: Schema.optional(Schema.Boolean),
  byteOffset: Schema.optional(NonNegativeInt),
});
export type ProjectHistoryReadInput = typeof ProjectHistoryReadInput.Type;

const SourceFields = {
  threadId: ThreadId,
  sourceKind: HistorySourceKind,
  sourceId: Schema.String,
  sourceVersion: Schema.String,
};
export const HistorySource = Schema.Struct(SourceFields);
export type HistorySource = typeof HistorySource.Type;
export const ProjectHistorySearchResult = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      ...SourceFields,
      excerpt: Schema.String,
      byteOffset: NonNegativeInt,
      captureId: Schema.NullOr(Schema.String),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
  continuation: Schema.String,
});
export type ProjectHistorySearchResult = typeof ProjectHistorySearchResult.Type;
export const ProjectHistoryReadResult = Schema.Struct({
  ...SourceFields,
  encoding: Schema.Literals(["utf8-json", "utf8-text"]),
  byteOffset: NonNegativeInt,
  byteLength: NonNegativeInt,
  text: Schema.String,
  nextByteOffset: Schema.NullOr(NonNegativeInt),
  sha256: Schema.NullOr(Schema.String),
  continuation: Schema.String,
});
export type ProjectHistoryReadResult = typeof ProjectHistoryReadResult.Type;
