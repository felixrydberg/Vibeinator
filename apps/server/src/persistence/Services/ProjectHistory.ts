import type {
  ProjectHistoryReadResult,
  ProjectHistorySearchResult,
  ProjectHistoryReadInput,
  ProjectHistorySearchInput,
  ThreadId,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { NativeArchiveRepositoryError } from "./NativeArchive.ts";

export class ProjectHistoryError extends Schema.TaggedErrorClass<ProjectHistoryError>()(
  "ProjectHistoryError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "ownership",
      "stale-source",
      "stale-cursor",
      "integrity",
    ]),
  },
) {}
type Error = ProjectHistoryError | NativeArchiveRepositoryError;
export interface ProjectHistoryRepositoryShape {
  /** The service derives the project from the authenticated caller, never an input project ID. */
  readonly search: (
    callerThreadId: ThreadId,
    input: ProjectHistorySearchInput,
  ) => Effect.Effect<ProjectHistorySearchResult, Error>;
  readonly read: (
    callerThreadId: ThreadId,
    input: ProjectHistoryReadInput,
  ) => Effect.Effect<ProjectHistoryReadResult, Error>;
  /** Local maintenance only; not an agent tool or a permission grant. */
  readonly rebuildIndex: Effect.Effect<void, Error>;
}
export class ProjectHistoryRepository extends ServiceMap.Service<
  ProjectHistoryRepository,
  ProjectHistoryRepositoryShape
>()("vibeinator/persistence/ProjectHistory") {}
