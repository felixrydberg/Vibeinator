# Durable summary revisions

VIB-009 adds SQLite repositories for independent project and chat/goal summaries and retention candidates. It reuses the VIB-003 durable contracts and existing SQL transaction/layer conventions. No retained repository provided revision history, citation ownership and compare-and-swap commits; the new store supplies those operations. Notes, display snippets and provider-native compaction remain separate. Automatic classification, rewriting, handoff assembly and UI exposure remain later issues.

## Repository contract

`SummaryStoreRepository` is available in the private server runtime. Typed request/read schemas live in `packages/contracts/src/summaryStore.ts`; existing durable record schemas remain in `durableInformation.ts`. This is an internal storage API, not a new agent write capability.

| Operation                      | Behavior                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(scope)`                   | Return the scope epoch, invalidation sequence and current immutable revision, or null before the first commit/after invalidation. Null is valid empty context.                                     |
| `appendCandidate(input)`       | Validate/pin citations and persist a pending or discarded decision. Exact retries return the existing record, including its consumed state; changed content under the same candidate ID conflicts. |
| `getCandidate`, `listPending`  | Read an exact candidate or up to 100 pending candidates in the current epoch. Old-epoch pending work stays inert.                                                                                  |
| `commit(input)`                | Atomically check expected epoch/head, validate sources/watermarks, append a revision, pin sources, consume the selected candidates and advance the head.                                           |
| `getRevision`, `listRevisions` | Read an exact scope-owned revision or page immutable history, newest first, including invalidated epochs. Pages are capped at 50.                                                                  |

Project and chat scopes use separate keys, even when they share a project. Summary text is capped at 8,000 characters; nonempty text requires citations. An empty revision is valid without classification. Consuming retain/uncertain candidates into empty text is rejected. Commits accept at most 100 candidates and 1,000 citations. Candidates must be pending in that same scope/epoch; each selected candidate's sources must be cited and its source watermark covered. No method selects a model, dispatches a provider, grants permissions or executes retained content.

SQLite transactions serialize writers in the existing server connection. The expected previous revision and epoch are also checked in the final SQL head update. A concurrent loser must reload and merge; it cannot silently overwrite another chat's project update. A transaction failure or cancellation preserves the previous head, history and pending candidates. A retry of candidate ingestion cannot resurrect a consumed candidate.

Processed orchestration/capture watermarks are monotonic within an epoch and cannot exceed durable allocation fences. Event citations must match an existing event ID and sequence; capture citations must have retained bytes and valid byte ranges. Project summaries may cite live threads in that project or that project's events; chat summaries may cite only their own thread. Excluded captures, foreign/deleted owners and unavailable source IDs are rejected. Objective-revision citations are rejected until goal revision storage exists; retained goal/status events can already be cited. Citations pin event/capture rows against operational removal.

The generic canonical JSON implementation is extracted from the retained browser catalogue into the shared `canonicalJson` subpath. The catalogue keeps its existing exports; candidate fingerprints and citation identity use that same implementation.

## Invalidation and deletion

| Trigger                         | Current summaries and pending work                                                                                       | Retained history                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted thread rollback/revert | Advance epochs and clear the affected chat and project heads. A different chat's own summary is unaffected.              | Immutable old revisions/candidates remain auditable; old pending candidates cannot be consumed in a new epoch.                                                       |
| Accepted thread deletion        | Invalidate that chat/project; reads of a deleted owner are rejected.                                                     | Retained until explicit purge.                                                                                                                                       |
| Accepted project deletion       | Invalidate every scope in the project; ownership checks reject reads/writes.                                             | Retained until explicit purge.                                                                                                                                       |
| Project workspace relocation    | Invalidate all project/chat scopes. A current workspace fingerprint also detects direct imported relocation on access.   | Old revisions remain history, never automatically reinstated.                                                                                                        |
| Explicit thread archive purge   | Invalidate affected scopes and remove their derived revision/candidate history and source pins in the purge transaction. | Unrelated chat scopes survive. Affected project history is conservatively cleared because later derived text can carry a purged fact without repeating its citation. |

Invalidation is driven by durable event insertion, not projection replay. Recorded invalidation sequences prevent duplicate sequence replay from reopening stale work. Epochs are opaque concurrency tokens; revision numbering restarts at one within a new epoch, while globally unique revision IDs preserve exact historical references. Refreshes must cover the invalidation event watermark. Old candidates are not automatically reclassified or provider work resumed.

Additive migration 145 is replay safe. Summary ownership does not use foreign keys into rebuildable projection tables. Source references use restrictive foreign keys into durable sources; the existing explicit archive purge releases these references before removing sources. Normal operational pruning never calls that purge helper.

## Verification

The focused repository suite covers independent chat/project state, empty summaries, concurrent writers, idempotent ingestion after consumption, transaction failure/cancellation, source/watermark validation, invalidation, explicit purge, exact history paging and file-backed reopen. It replays the full migration lineage from 54 over populated summary state and also exercises atomic candidate consumption with the production Bun SQLite driver. Existing browser catalogue tests cover compatibility of the extracted JSON implementation. These checks are included in Windows CI.

No UI, provider/model choice, automatic rewriting or goal continuation behavior changes in this issue. Live-provider and signed-installer qualification remains under VIB-001/019; Linux CI remains deferred by project decision.
