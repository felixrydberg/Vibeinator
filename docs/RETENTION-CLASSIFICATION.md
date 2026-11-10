# Retention classification

VIB-011 turns successful coding output into advisory project/chat summary candidates. It reuses the [decision-engine client](DECISION-ENGINE.md), immutable orchestration events and [summary store](SUMMARY-REVISIONS.md). It does not rewrite summaries, open provider sessions, execute tools, change goals or grant approvals. Summary rewriting is VIB-012; the existing handoff disclosure remains unchanged until VIB-016.

## Admission and sources

Migration 147 adds a durable `retention_jobs` queue. An insertion trigger admits normalized `turn.completed` activities only when their state is `completed` and their turn ID is present. One job is shared by duplicate completions for the same chat/turn. Existing successful boundaries are backfilled idempotently. No prunable runtime-journal cursor is required.

For a successful turn, the worker reads immutable, non-streaming user/assistant message events and completed tool payloads associated with that chat/turn. Unbound user messages since the preceding terminal are included. Streaming deltas are not independently classified: settlement supplies the complete message event. Late settled messages/tool payloads reopen the existing successful job after its committed source position. Events from other chats cannot enter its source range.

Failed, cancelled, interrupted, abandoned and still-running turns do not admit coding candidates. Their complete source history remains available through the archive/history tools. Explicit `goal`, goal start/pause/achievement and settled-status changes always admit retained chat candidates, including clearing an objective or status; they do not wait for a successful coding turn or a model decision. Other metadata edits do not trigger classification.

The worker sends only one source section at a time, capped at 4,000 Unicode code points of serialized JSON. SQL slices before materializing the text in JavaScript. Message text is serialized as a JSON string, tool payloads as their JSON value, and explicit changes as a JSON object. Escaping before slicing prevents SQLite's NUL-terminated string operations from silently skipping the rest of a message. No source event or native payload is edited, truncated or deleted by classification. Native captures are not separately sent to Clef; candidate capture watermarks remain zero rather than claiming that the full native archive was classified.

## Decisions and persistence

Two bounded choice questions ask for retention (`retain`, `uncertain`, `discard`) and category (`architecture`, `decision`, `constraint`, `discovery`, `progress`, `unresolved`, `other`). Source text is quoted as untrusted data. The client validates the reply against these labels; its existing deadlines, request/response limits, credential isolation and transport cancellation apply.

| Result                                                             | Stored candidates                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Retain                                                             | Pending candidates in both project and chat scopes                 |
| Uncertain                                                          | Pending candidates in both scopes                                  |
| Discard                                                            | Discarded candidates in both scopes; source history remains intact |
| Client fallback, including disabled/offline/invalid/low-confidence | Pending, uncertain, unclassified candidates in both scopes         |
| Explicit objective/status change                                   | Pending, retained chat candidates; no inference request            |

Each candidate cites its exact immutable event ID/sequence, source watermark, classifier implementation/version, decision, category and state. `retention_sections` records the candidate's source field and half-open code-point offsets into that field's serialized JSON. Its `explicit-change` field denotes a JSON object containing `goal`, `goalStartedAt`, `goalPausedAt`, `goalAchievements` and `settledAt`, in that order, with absent fields represented as null. Candidate IDs include the job, epochs, scope, source and range. `decision-engine` / version `1` identifies the classifier implementation, not a model revision; the endpoint/model remain operator settings.

Both scope candidates, range receipts and the source position commit in one SQLite transaction. HTTP runs outside that transaction. Interruption or a failed write leaves the last committed position intact. A restarted worker re-reads only uncommitted sections; an inference response lost before commit can safely be requested again. Fallback candidates remain pending for the summary rewriter, without an unbounded inference retry loop. `attemptCount` counts the classification attempt, including a client fallback; `nextAttemptAt` remains null.

Summary epochs and workspace/ownership checks fence results across rollback, relocation and deletion, including changes made while inference is pending. Pre-adoption rollback boundaries are checked before backfilled work is admitted. Invalidated work is retired rather than resurrected into the new scope. Explicit archive purge also removes queued jobs and range receipts through the existing summary-purge transaction.

## Lifecycle and verification

The scoped worker starts with orchestration observers, processes one section at a time, and checks its durable queue after a one-second idle delay. It shares the configured decision engine and summary store. Shutdown cancels inference and leaves durable work resumable; it never restarts a coding goal. Classification creates neither conversation events nor provider turns. Future tools-off maintenance sessions must stay isolated from the coding conversation/event pipeline, as specified by VIB-012, so their completion cannot recursively admit coding work.

Windows CI runs the classification tests and orchestration startup-order test, alongside existing migration/backup, archive, summary and decision-client checks. Focused tests exercise actual SQLite writes, atomic failure recovery, Unicode ranges, late sources, duplicate completions, explicit changes, invalidation and source immutability. A two-process test interrupts the production Bun SQLite worker, closes the process, reopens the disk database and verifies that only uncommitted sections resume.

Decision outcomes in these storage tests are controlled service fixtures. Live Clef/Ollama model quality and end-to-end provider qualification remain VIB-019; the existing client HTTP tests establish the transport boundary separately.
