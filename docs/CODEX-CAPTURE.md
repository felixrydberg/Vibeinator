# Codex native capture

VIB-005 connects the [native archive](NATIVE-ARCHIVE.md) to the production desktop's Codex manager. It reuses the existing stdio framer/writer, process supervisor, approval handling and adapter. No renderer changes, new dependencies or migrations are required.

## Acceptance boundary

Each owned coding-session JSON-RPC envelope is committed before notification/request handling, runtime mapping, native logging or callback-ingress compaction. Incoming JSON text is retained exactly, excluding its JSONL newline/CRLF framing delimiter. Outgoing JSON is serialized once for capture, frozen as a plain object and passed to the existing writer after commit. An outgoing capture records dispatch intent; it does not prove provider acceptance or execution.

Capture covers requests, notifications, responses, unknown protocol methods, tool results and outgoing approval/input decisions. Non-JSON launcher noise and malformed transport frames retain existing handling and are not claimed as complete captures. Discovery-only processes have no app conversation owner and are not archived.

Identity includes the app thread/project, provider instance, a new runtime UUID per process attempt, lifecycle generation and per-attempt ingress ordinal. Native request IDs preserve their JSON type (`71` and `"71"` differ); native thread/turn/item IDs remain metadata and the full original envelope remains authoritative. Repeated native IDs and identical content in a later attempt remain distinct evidence. Notifications/requests carry `nativeCaptureId` into derived runtime events, including their compacted diagnostic copies. VIB-007 adds [durable normalization links and failure/replay integration](CAPTURE-REPLAY.md).

## Backpressure and lifecycle

The session-owned capture lane serializes SQLite commits. It admits at most 256 frames and 32 MiB of pending UTF-8 input, including the active write. Stdout pauses while capture is pending; a partial frame or launcher noise resumes immediately when no accepted capture remains. After an outgoing commit, stdout resumes before waiting for stdin drain, so a child blocked on its own output can consume a large request. The retained transport's 16 MiB normal-frame limit still applies.

Queue overflow, write/ownership failure or a five-second storage deadline (including queue wait) rejects capture with a fixed error, suppresses dispatch of that frame and enters the existing transport-failure teardown path. The deadline interrupts asynchronous storage waits; it cannot preempt synchronous SQLite/native work blocking the event loop. Raw SQLite errors and payloads are not included in that error. No automatic capture retry can repeat protocol handling, execute a tool or answer a request twice. Previously committed frames remain durable even when later capture fails.

EOF/exit handling waits for accepted captures. Explicit stop starts the existing process teardown promptly and drains accepted storage work before releasing the session replacement barrier. A frame that commits after explicit stop remains evidence but cannot create approvals or publish into the replacement session. Pending human requests continue through the existing cancellation path, with outgoing cancellation replies captured before writes. Failure of that path is not reported as provider acceptance. Existing process-exit verification remains authoritative.

## Exclusions

The [durable information policy](DURABLE-INFORMATION.md#capture-exclusions-and-attachment-boundary) applies before archive writes and publication. Login/token exchanges, MCP OAuth exchanges, setup/config frames, unmatched responses and known credential-bearing fields become content-free exclusions. Excluded captures have an allowlisted reason and no raw content/hash or native IDs extracted from their body.

Known credential keys include access/refresh/ID/session/bearer/API tokens, passwords, client secrets, credentials, authorization/proxy authorization headers and cookies, ignoring case and hyphen/underscore spelling. Nonempty environment records are also excluded because their custom variable names can carry credentials. Published diagnostic payloads remove those values; protocol handlers still receive their original successful input. Credential/setup errors use a fixed message and preserve numeric error codes, so free-form response errors cannot echo credentials into logs. The account-read body is no longer logged. Credential-free account/login/OAuth completion status, rate limits, token counts and approval decisions remain ordinary evidence.

This is a protocol-field policy, not arbitrary secret detection inside user/tool text. User-pasted sensitive text can remain in conversation content. Original envelope access still requires the archive's existing project ownership checks; retained text never authorizes tools.

## Verification and limits

Nine focused regression cases use the real manager, adapter compaction and SQLite repository, with a synthetic child transport. They cover multi-megabyte Unicode/NUL output, exact incoming JSON, unknown methods, typed approval IDs and accept/deny/cancel replies, reconnect/stale requests, credential exclusions and benign auth/quota status, blocked SQLite backpressure and EOF, archive write failure/recovery, stop during pending capture, queue overflow, storage timeout during shutdown and partial stdout during a backpressured stdin write. The large-payload regression also fails against `main`'s manager because the archive record is missing, then passes with the capture hook. The partial-stdout test fails with the outgoing resume omitted, then passes with the drain ordering fixed.

These tests do not launch or authenticate a live Codex process. Live provider startup/approval qualification, external process-tree termination and signed packaged behavior remain separate qualification work. See [shared failure/replay guarantees](CAPTURE-REPLAY.md) and [Claude capture](CLAUDE-CAPTURE.md) for their implementations and limits.

## VIB-005 verification (7 November 2026)

| Check                                                                                                    | Result                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Capture regressions                                                                                      | Nine passed; missing-archive and stdio-drain negative controls failed as expected before their fixes                                   |
| Manager, adapter, transport, archive, runtime journal/pump, provider service/routing and lifecycle sweep | 629 passed, four skipped; three unchanged failures reproduced against `main`                                                           |
| Formatting, lint, six-package types and Windows runtime guard                                            | Passed; lint has 943 inherited warnings and zero errors                                                                                |
| Full workspace attempt                                                                                   | Shared package: 1,116 passed, 14 skipped, two failures; Turbo aborted other workspaces, with concurrent desktop failures also observed |

The desktop/backend build and the final startup smoke passed. The smoke rebuilt affected artifacts and used a fresh disposable home and Electron profile; its cleanup also passed.

The three backend failures are the existing global/project connector tests expecting `mcp_servers.vibeinator` and the Windows PATH replacement version-gate test. Both the manager and its test file were temporarily restored from the merged `main` revision for the baseline reproduction, then the implementation was restored. They remain VIB-001 qualification work.

The shared failures are the inherited Windows login-shell home-path expectation and the process-priority assertion. Concurrent desktop failures include browser file-URL handling and the inherited CUA host suite. Incomplete or failing workspaces are not counted as green. No migration changed, so migration qualification is unchanged from VIB-004.
