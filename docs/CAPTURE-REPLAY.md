# Capture failure and replay

VIB-007 connects the [native archive](NATIVE-ARCHIVE.md), [Codex capture](CODEX-CAPTURE.md) and [Claude capture](CLAUDE-CAPTURE.md) to provider readiness and durable domain projections. It reuses existing pumps, archive storage, teardown and error publication. A new recording-state service supplies durable per-generation intent that the existing provider-wide pump health registry cannot represent. It retains Electron, provider approval policy, existing transcript rendering and package boundaries.

## Failure and recovery

Migration 143 adds recording intent per thread/lifecycle generation. The provider facade commits intent before starting a runtime. Native capture records its runtime identity before admitting its first frame. A clean stop is recorded only after adapter teardown succeeds. Failed metadata writes leave dirty intent; successful process teardown cannot erase a recording failure.

Capture, serialization, journal, projection and callback-overflow failures latch the affected generation. New sends, steers, reviews, approval grants and user answers cannot proceed. Cancellation and stop remain available. The provider facade requests generation-fenced adapter teardown; Claude starts physical retirement before queued cancellation events can block it. Cleanup failure is logged as unverified and does not clear the failure latch.

The existing runtime-error path reports: “Conversation recording failed. Restore database access or free disk space, stop the runtime, then resume. The last committed history is preserved.” The same fixed error is returned by dispatch readiness. No new renderer layout, controls or navigation are introduced. The failure notification is journaled when storage accepts it; a failed database cannot be used to promise durable error publication.

Repair storage, stop the failed runtime and explicitly start/resume a new generation. Repairing storage alone never re-enables failed work. Startup marks unfinished recording intent as failed and preserves the first durable failure timestamp. Late failures and delayed native frames cannot reclaim an active replacement's recording ownership; observe claims are checked before and after SQL yields. Restored conversations and goals remain paused under the existing restart policy.

The in-memory failure registry retains at most 1,024 thread failures; exhausting it closes readiness until restart. Capture retains its 256-frame/32 MiB queue budget and five-second admission deadline. Journal writes have a five-second acceptance deadline; individual failure-metadata and clean-stop writes have a one-second deadline. These are application admission bounds, not proof that an operating-system call can always be interrupted on time.

Only immutable storage operations are retried. A failed journal head remains owned by its supervised pump; no turn, permission grant or provider command is replayed by these retries. Permanent malformed events retain the existing bounded quarantine behavior. A failed generation and its native evidence remain explicit even if an operational poison row is quarantined.

## Projection and replay

The runtime journal validates each native source's thread, provider, instance and generation. Trusted ingestion context carries provenance to the engine without adding source authority to public commands. The engine saves `metadata.nativeCaptureIds` and normalization-link rows in the same transaction as domain events, hot projections and command receipts. Publication follows commit. A storage failure rolls back all of them and remains retryable; an invalid source or unrelated target is rejected. Root captures can link to materialized descendants in the same project, with cycle-safe lineage checks.

Live subscribers receive the journal's accepted preview, so live and replay payloads agree. Assistant and reasoning text are never clipped to fit the journal: oversized deltas are split into deterministic segments of at most 256 Ki UTF-16 code units without splitting surrogate pairs. Ordinary deltas and existing pump batches keep their identities. The repository rejects unsplit text that still exceeds its envelope budget. Duplicate delivery uses stable IDs and existing command receipts.

Long tool previews remain bounded; their native capture IDs resolve to complete chunked archive content. The transcript is rebuilt from semantic domain events and projected message chunks, without hydrating raw payloads. Exact agent-facing source lookup/search is VIB-008.

Historical coverage markers remain historical: normalized-only or unavailable content is not relabeled native-complete. Recording intent and failure state identify interrupted native generations; they do not claim that SDK-internal traffic, external attachment files or older provider output was captured.

## Verification limits

Tests use real SQLite, archive/journal repositories, provider lifecycle code, ingestion, domain transactions and message readers with synthetic provider traffic. They cover disk-full/read-only writes, malformed native JSON, failed failure-metadata writes, restart intent, duplicate delivery, foreign provenance, rollback/retry, source-linked bounded previews, Unicode/NUL/lone-surrogate text, transcript replay and Claude queue backpressure.

Live provider execution, external process-tree termination and signed packaged Windows behavior remain unqualified. Baseline failures remain tracked under VIB-001; passing synthetic teardown tests does not prove live cleanup.

## VIB-007 verification (7 November 2026)

| Check                                                                            | Result                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fourteen-file provider/archive/ingestion/lifecycle sweep                         | 1,194 passed, four skipped, three known Codex baseline failures                                                                                                                    |
| Final regression follow-ups                                                      | Nine recording/provider/engine cases passed, including the added registry-overflow case; linked-ingestion and oversized-journal rejection cases passed separately                  |
| Additional migration/recovery fixtures                                           | Six remaining CI fixture files: 59 passed                                                                                                                                          |
| Regression controls against merged main                                          | All three failed as expected: unrelated source targets were accepted, live/journal payloads diverged, and Claude queue-pressure shutdown timed out; restored implementation passes |
| Formatting, lint, six-package types, Windows runtime guard and migration lineage | Passed; lint retains 943 warnings and zero errors                                                                                                                                  |
| Desktop/backend build and rebuilt isolated startup smoke                         | Passed, including disposable-home/profile cleanup                                                                                                                                  |
| Full workspace attempt                                                           | Contracts: 215 passed. Shared: 1,116 passed, 14 skipped, two failures; Turbo aborted remaining workspaces and concurrent desktop failures were observed                            |

The three Codex failures remain the global/project connector expectations and the Windows PATH replacement version probe documented and reproduced against unchanged main in [VIB-005](CODEX-CAPTURE.md#vib-005-verification-7-november-2026). Shared failures remain the Windows login-shell home-path expectation and process-priority assertion. Concurrent desktop failures include browser file-URL handling, frame capture, browser automation hosting and pipe-server cases. Incomplete workspaces are not counted as green.

The delayed-frame ownership regression failed in all three capture-failure modes before the observe guard was added, then passed after the fix. The existing paced-stream write benchmark passed on focused rerun and in the final sweep. One earlier loaded run hit its timing-sensitive boundary exactly (130 rows against a strict `< 130` threshold); no performance-test thresholds were relaxed.
