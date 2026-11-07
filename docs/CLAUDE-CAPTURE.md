# Claude native capture

VIB-006 connects the production desktop's Claude adapter to the [native archive](NATIVE-ARCHIVE.md). It preserves the SDK, query ownership, permission modes, account configuration, native resume and existing transcript mapping. It adds no renderer surface, dependencies or migration.

## Acceptance boundaries

| Boundary              | Retained evidence                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK message iterator  | Each decoded message before native logging, routing, image stripping or preview shaping: deltas, final assistant snapshots, tool calls/results, inline images, status and unknown message types |
| SDK prompt iterator   | The complete queued user message before yielding it to the SDK; archive failure prevents that yield                                                                                             |
| `canUseTool` callback | Original tool input and callback metadata, including native request/tool IDs, permission suggestions and agent identity; the live `AbortSignal` is a control handle and is not serialized       |
| Human settlement      | Approval/denial/cancellation or question answers before releasing the pending interaction; a separate record captures the resulting SDK permission response before callback return              |
| Query setup           | A content-free credential-material exclusion; runtime options contain credentials, process functions and control handles and are not archived as conversation text                              |

The SDK exposes decoded objects. Capture serializes their JSON once before awaiting storage; original provider transport whitespace is unavailable. Native conversation/tool text and inline base64 remain complete. Cyclic or unsupported non-JSON values fail capture rather than silently replacing content. Optional undefined object fields follow JSON serialization. Filesystem workflow polling, discovery-only queries, native session imports and hidden SDK control traffic are outside this SDK message/callback boundary.

Separate raw delta, snapshot and permission records are evidence, not duplicate transcript messages. The existing stream/snapshot reconciliation still owns normalized display. Native IDs are metadata, not deduplication keys. Identity uses the app project/thread, provider instance, per-query runtime UUID, lifecycle generation and ingress ordinal. Reused IDs after resume remain distinct captures. Child SDK traffic is retained by the owning root query before existing subagent routing.

Fiber-local capture provenance carries `nativeCaptureId` into derived runtime events without letting concurrent permission callbacks overwrite another message's origin. Logical settlement records carry their own capture IDs. Durable normalization-link rows, replay coverage and shared pump/dispatch readiness belong to VIB-007.

## Backpressure, failure and stop

Codex and Claude share the storage-only queue extracted from VIB-005. Protocol classification and execution remain provider-owned. The queue admits at most 256 pending frames and 32 MiB of UTF-8 content, including the active write and excluded SDK input (whose bytes are counted transiently without storing its content). Its five-second admission deadline includes queue wait. It interrupts asynchronous storage waits; synchronous SQLite/native work cannot be preempted while blocking the event loop. SDK iteration and prompt yielding await commit; this does not qualify the SDK's internal transport buffering.

Capture failure latches on the owning context, suppresses that input's handling or dispatch, and enters the existing failure/turn-completion and supervised retirement path. A failed approval capture becomes cancellation and never an allow result. Settlement ownership still prevents duplicate releases. The adapter never retries a tool, prompt or permission callback to repair storage.

Abort/stop checks run again after awaited capture. Pending interactions settle through the existing cancellation path; stale callbacks cannot create a new approval or grant a tool in a replacement runtime. Stop drains already accepted archive work before releasing the session replacement barrier, while retaining the existing process-tree exit proof. Captured outgoing intent or a returned permission result does not prove that the native runtime received or executed it.

## Credentials and attachments

The [exclusion policy](DURABLE-INFORMATION.md#capture-exclusions-and-attachment-boundary) applies before archive, logging and publication. Credential-bearing envelopes become content-free exclusions with an allowlisted reason and no body hash or native IDs extracted from that body. Claude reuses the existing sensitive-field classifier, while treating numeric `tokens` counts as metrics. Nonempty environment records are excluded because custom variable names can contain credentials. Auth output/errors and login/OAuth/token exchanges are excluded; credential-free auth status and usage counters remain ordinary evidence.

Permission handling receives the original tool input; diagnostic/publication values are redacted. Provider error details from archive writes are replaced with a fixed capture failure, so SQL causes and payload text cannot escape through that failure path. This is protocol-field exclusion, not detection of arbitrary sensitive text pasted into conversation content.

Managed attachment files retain their existing storage, authorization and expiry rules. Inline image data supplied inside an SDK payload remains in that payload in SQLite before the diagnostic image copy is stripped. Capturing a file path does not import that file or prove its availability.

## Verification and limits

Thirteen regression cases use the real Claude adapter, archive repository and SQLite with synthetic SDK input. They cover large Unicode/NUL tool results and inline images, unknown types, delta/snapshot reconciliation, native prompt capture, approval/denial/question responses, cancellation, native resume and reused IDs, credential exclusions with unchanged SDK tool input, blocked-storage stop/drain, capture failure at message/prompt/request/decision boundaries, rejection of cyclic, sparse-array and non-finite SDK values, and byte admission for oversized excluded frames. The large-payload regression fails against the merged main adapter because its capture records are missing, then passes with this integration. Existing Claude permission/process tests and Codex capture tests also exercise compatibility.

No live Claude account is authenticated or invoked by these tests. Live-provider behavior, external process-tree termination, SDK-internal buffering and signed packaged behavior remain unqualified. Shared durable replay/projection guarantees remain VIB-007.

## VIB-006 verification (7 November 2026)

| Check                                                         | Result                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Claude capture and compatibility                              | 13 new capture cases and 301 existing Claude tests passed; all nine Codex capture cases also passed after sharing storage code       |
| Thirteen-file provider/archive/lifecycle sweep                | 943 passed, four skipped, three known Codex baseline failures                                                                        |
| Formatting, lint, six-package types and Windows runtime guard | Passed; lint has 943 inherited warnings and zero errors                                                                              |
| Rebuilt desktop/backend and isolated startup smoke            | Passed, including disposable-home/profile cleanup                                                                                    |
| Full workspace attempt                                        | Shared package: 1,116 passed, 14 skipped, two failures; Turbo aborted other workspaces and concurrent desktop failures were observed |

The three backend failures are the same global/project connector gateway expectations and Windows PATH replacement version-probe case recorded in [VIB-005](CODEX-CAPTURE.md#vib-005-verification-7-november-2026), where they were reproduced against unchanged main. The shared failures are the Windows login-shell home-path expectation and process-priority assertion. Concurrent desktop failures include inherited CUA host/capture and browser cases. These remain VIB-001 qualification work; unfinished or failing workspaces are not counted as green. No migration changed.
