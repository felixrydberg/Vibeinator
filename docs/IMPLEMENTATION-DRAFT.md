# Vibeinator implementation draft

Status: implementation started with VIB-001; later steps remain planned. All twenty steps have GitHub issues. The [tracker](IMPLEMENTATION-TRACKER.md) records state and links the issue bodies and GitHub mapping. Based on the [Synara audit](SYNARA-AUDIT.md), source revision `3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4`, and the [Vibeinator requirements](../README.md). Written 3 November 2026.

## Outcome and boundaries

Deliver a Synara-based desktop app that keeps a reliable record of project work and carries the right information between Codex and Claude. Keep Electron, React, TypeScript, the existing server/SQLite integration, provider adapters, approvals, frontend transport, editor, Git/browser surfaces, and build/test infrastructure. No runtime/framework migration, full provider rewrite, or mass feature deletion belongs on the initial path.

The key change is the distinction between **what is retained** and **what is sent to a model**. Retain the full supported conversation record. Send bounded, attributable context assembled from summaries and recent messages. Keep history retrieval available for omitted information.

This draft proposes implementation boundaries; file/table names for new code are suggestions. Existing paths below are verified against the pinned source. Add focused modules at the current service boundaries instead of expanding the largest reactor/adapter files with unrelated jobs.

## First decisions, with proposed defaults

| Decision             | Proposed default                                                                                                                         | Why it matters                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Source ownership     | Preserve upstream history/notices; pin the baseline; no upstream merge commitment                                                        | Reproducible provenance without requiring ongoing compatibility work                                               |
| Data migration       | Separate Vibeinator home from day one; support a deliberate offline copy of a Synara baseline database                                   | Avoid opening or migrating the user's original database in place                                                   |
| Archive scope        | Full supported native conversation/tool payloads and normalized events; known credentials/auth exchanges excluded by contract            | “Full history” must not accidentally mean credential logging                                                       |
| Large content        | Chunked SQLite payloads and complete goal text; existing managed attachments retain their lifecycle until a separate decision changes it | No silent truncation or broken objective references; attachment migration is not hidden in the first schema change |
| Execution on restart | Conversations restore, orphaned turns settle, active goals become paused; no new coding continuation without an explicit user action     | Matches the README and avoids inherited restart paths bypassing it                                                 |

VIB-003 settles the attachment boundary in the [durable information contract](DURABLE-INFORMATION.md): complete conversation/objective text and durable attachment metadata/references belong in SQLite; binary attachments keep the existing managed-file lifecycle and explicit availability. A SQLite-only backup does not recover external attachment bytes. The contract also fixes process-crash durability, identities, source/revision/packet invariants and additive upgrade/backout rules for subsequent issues.

## Retained components and extension points

| Concern               | Keep                                                                                                 | Extend                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Conversation commands | `orchestration/Layers/OrchestrationEngine.ts`, `decider.ts`, `projector.ts`, command receipts        | New information-domain commands and transactions; keep persist-before-publication       |
| Native event delivery | `provider/Layers/ProviderService.ts`, `providerRuntimeEventPump.ts`, runtime consumer cursors        | Native capture before adapter shaping; durable links to normalized events               |
| Database              | `persistence/Layers/Sqlite.ts`, migrations, backup/lifecycle lock/reclamation                        | Archive, summary, candidate, FTS and packet tables/indexes                              |
| Provider sessions     | `codexAppServerManager.ts`, `provider/Layers/CodexAdapter.ts`, `ClaudeAdapter.ts`, session directory | Capture callbacks and maintenance-session purpose; keep permission and process handling |
| Handoff               | `orchestration/handoff.ts`, `ProviderCommandReactor.ts`, `useThreadHandoff.ts`                       | New deterministic context builder, immutable packet records and refresh/fallback gates  |
| History tools         | `threadReadTools.ts`, `threadDiagnosticTools.ts`, `threadSummary.ts`, target resolver                | Project-scoped search and full-payload lookup with existing authorization               |
| UI                    | Normalized store, existing summary/detail disclosures, provider picker and handoff divider           | Separate knowledge panels and exact-context inspection                                  |
| Summary generation    | Existing `git/Services/TextGeneration.ts` and Codex/Claude text-generation patterns                  | Dedicated tools-off maintenance operation with active provider/account selection        |
| Goals                 | `goalMode.ts`, goal commands/projections, continuation loop, goal tool                               | Restart pause, complete objectives, evidence/status and project admission               |

Paths in this table are under `apps/server/src` unless the name identifies a frontend module; frontend handoff is under `apps/web/src/hooks`. Shared contracts remain in `packages/contracts/src`; reusable platform behavior remains in `packages/shared/src`.

## Storage design to resolve in VIB-003

Keep `orchestration_events` as the authoritative normalized event journal and keep its projections rebuildable. Keep `provider_runtime_events` as bounded operational delivery state. Add durable native records alongside them; do not keep a second independently edited conversation transcript.

| Proposed record        | Minimum contents and invariants                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native capture/payload | Capture ID, provider/session/lifecycle identity, ingress ordinal, timestamps, schema version, content hash, payload/chunk references, and normalization links. Identity must distinguish repeated text and reused provider IDs across sessions |
| Payload chunks         | Ordered complete content in SQLite with stable offsets and total length/hash. Preview truncation never mutates stored bytes/text. References must not point only to prunable runtime-buffer rows                                               |
| Retention candidate    | Source IDs/ranges, source watermark, category, retain/uncertain decision, classifier/version, state and retry metadata. Explicit objective/status changes are always candidates                                                                |
| Summary revision       | Separate project and chat/goal scope, revision number, previous revision, bounded text, cited source IDs and processed watermark, generation provider/account/model, outcome and timestamps                                                    |
| Handoff packet         | Conversation and target session identity, source watermark, summary revision IDs, ordered recent message IDs, limits/omissions, exact assembled context and final dispatch input, content hash and outcome                                     |

Ordering rules: capture content durably before acknowledging it for derived/live display; persist user commands before provider dispatch; commit summary text, sources and processed watermark together; persist a prepared packet before dispatch; record accepted/failed/uncertain outcomes separately. Reuse existing command delivery/reconciliation for external provider side effects because stopping/starting a process cannot be rolled back by a SQLite transaction.

Use migrations after the existing lineage, whose highest registered ID is **141** at the audited revision. Do not fill historical gaps or edit released migrations. If the adopted baseline changes, derive the next available ID from that revision instead of assuming 142.

## Milestones and order

| Milestone                                           | Issues           | Exit condition                                                                                                               |
| --------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A. Owned, safe baseline                             | 001–003          | App/profile/update isolation, known baseline failures, restart policy and information contracts settled                      |
| B. Retained and retrievable history                 | 004–008          | Both providers retain complete supported content; old/large results remain retrievable after restart and operational pruning |
| C. Better handoffs without a local-model dependency | 009, 013–014     | Revision storage exists; deterministic packets work with empty/existing summaries and history retrieval                      |
| D. Maintained knowledge                             | 010–012, 015–016 | Clef classification and provider-written revisions feed handoffs with failure-safe fallback and visible provenance           |
| E. Remaining product guarantees                     | 017–019          | Goal semantics, coarse tools, Windows release and performance qualified                                                      |

Issue 020 is optional, after measurement. The numbers identify issues, not a command to implement strictly in numeric order. In particular, **013–014 can precede 010–012** so local-model setup does not block a usable handoff milestone.

Recommended first queue: **001 -> 002 and 003 -> 004 -> 005 and 006 -> 007 and 008 -> 009 -> 013 -> 014**. These are logical dependencies, not an instruction to use multiple agents. After that, complete 010–012 and 015–019.

## Draft issue index

Priorities: P0 is baseline/data-integrity work; P1 is needed for the main product; P2 is a later capability. Estimates are experienced-developer working days including focused tests, not elapsed promises or measured AI-agent durations. Do not sum every upper bound into a release date: discoveries, baseline failures and cross-cutting qualification require re-estimation.

| ID      | Draft title                                                    | Priority    | Depends on                                   | Rough size                                   |
| ------- | -------------------------------------------------------------- | ----------- | -------------------------------------------- | -------------------------------------------- |
| VIB-001 | Adopt and qualify an isolated Synara baseline                  | P0          | —                                            | 1–3 days, plus unresolved baseline diagnosis |
| VIB-002 | Restore state without automatically restarting coding goals    | P0          | 001                                          | 1–2 days                                     |
| VIB-003 | Define durable information contracts and migration fixtures    | P0          | 001                                          | 1–2 days                                     |
| VIB-004 | Add complete native-payload retention in SQLite                | P0          | 003                                          | 2–4 days                                     |
| VIB-005 | Capture Codex payloads before destructive shaping              | P0          | 004                                          | 1–3 days                                     |
| VIB-006 | Capture Claude payloads before destructive shaping             | P0          | 004                                          | 1–3 days                                     |
| VIB-007 | Enforce capture failure and projection/replay guarantees       | P0          | 005, 006                                     | 2–3 days                                     |
| VIB-008 | Add project-scoped history search and exact payload reads      | P1          | 004; both adapters for qualification         | 2–4 days                                     |
| VIB-009 | Persist separate project and chat/goal summary revisions       | P1          | 003                                          | 1–2 days                                     |
| VIB-010 | Add the configurable Clef decision-engine client               | P1          | 003                                          | 1–2 days                                     |
| VIB-011 | Classify completed-turn information into durable candidates    | P1          | 005, 006, 009, 010                           | 1–3 days                                     |
| VIB-012 | Rewrite summaries through isolated tools-off provider sessions | P1          | 009, 011                                     | 2–4 days                                     |
| VIB-013 | Build bounded handoff packets from durable information         | P1          | 008, 009                                     | 1–3 days                                     |
| VIB-014 | Integrate immutable packets into existing handoff/recovery     | P1          | 007, 013                                     | 2–4 days                                     |
| VIB-015 | Refresh summaries before handoff and completion, with fallback | P1          | 012, 014                                     | 1–2 days                                     |
| VIB-016 | Expose project/chat summaries and exact handoff context        | P1          | 009, 014                                     | 1–3 days                                     |
| VIB-017 | Extend existing goals with evidence and project admission      | P1          | 002, 003, 007; 015 for final completion path | 2–4 days                                     |
| VIB-018 | Expose coarse tools over the retained gateway                  | P2          | 008, 010, 017                                | 2–4 days                                     |
| VIB-019 | Qualify migrations, provider handoffs and Windows delivery     | P1          | All shipped behavior above                   | 2–5 days                                     |
| VIB-020 | Remove only measured, unwanted background costs                | P2/optional | 019 and measurements                         | Re-estimate from evidence                    |

## Issue acceptance drafts

### VIB-001 — Adopt and qualify an isolated Synara baseline

**Problem/outcome:** Establish a reproducible working fork while preserving the original app's data and update ownership. Investigate the known failing edit-replay fixture before claiming the baseline is green.

**Scope:** Import the pinned source/history through a deliberate Git adoption step that preserves this repo's README/drafts and all upstream notices. Use distinct application/backend/browser profile homes, protocol/bundle identity and update configuration. Disable publication/auto-update destinations until owned feeds exist. Keep internal package names initially. Use the existing build/CI scripts, lockfile and patches.

**Touch points:** `packages/shared/src/desktopIdentity.ts`; `apps/desktop/src/main.ts`, updater/launch helpers; `apps/server/src/config.ts`; `scripts/build-desktop-artifact.ts`; workspace manifests and existing identity tests.

**Accept when:** A Windows development build opens with disposable data homes; Codex and Claude can each run a disposable project turn, approve/deny a request and interrupt; restart restores the UI; original Synara directories/feed are untouched. Record actual format/lint/typecheck, affected unit/browser/native checks and packaging limitations. Diagnose `ProviderCommandReactor.test.ts:14469`; a documented upstream/environment failure may be quarantined only with a bounded explanation and follow-up, not silently ignored.

**Split later if needed:** Source adoption/identity and baseline failure diagnosis are separate PRs under this issue. No mass branding or UI redesign.

### VIB-002 — Restore state without automatically restarting coding goals

**Problem/outcome:** The inherited active-goal recovery deliberately starts work on launch; Vibeinator must require resume.

**Scope:** Replace goal startup continuation with durable pause while preserving orphaned-turn and pending-request settlement. Characterize and gate ordinary-chat automatic restart, saved quit/resume, queued promotions and usage-limit recovery so they do not start a coding turn contrary to this policy.

**Touch points:** `orchestration/startupTurnReconciliation.ts`; `orchestration/Layers/ProviderCommandReactor.ts` startup/recovery; `effectServer.ts`; desktop quit/resume helpers; goal timing tests.

**Accept when:** Clean quit, crash and kill/restart all leave unfinished turns interrupted and active goals paused. No provider send occurs until user resume/new input. Pending approval cards from dead sessions settle rather than becoming approvals for replacement sessions. Explicit resume continues the same conversation with recovery context.

### VIB-003 — Define durable information contracts and migration fixtures

**Problem/outcome:** Full-content retention, provenance and packet semantics need shared definitions before different features invent incompatible stores.

**Scope:** Define the records/invariants in the storage section, native-to-domain identity mapping, capture exclusions, attachment policy, complete objective revisions, and additive migration ownership. Build synthetic databases at the pinned schema and representative released schemas; never read personal databases for tests.

**Touch points:** `packages/contracts/src`; `persistence/Services`; `persistence/Migrations.ts`; existing migration/backup/NodeSqliteClient tests.

**Accept when:** Upgrade/backout procedures are written; foreign keys and replay behavior are specified; identities handle multiple providers and repeated native IDs; unknown payload types remain retainable. Tests prove pre-existing conversations survive migrations and an older binary refuses a too-new schema. Decide process-crash versus power-loss durability explicitly.

### VIB-004 — Add complete native-payload retention in SQLite

**Problem/outcome:** Keep complete supported history after operational consumers prune their delivery rows.

**Scope:** Add append/read APIs and chunked large payloads with stable IDs, integrity hashes and source links. Persist atomically under existing database ownership. Keep the current bounded runtime journal and its cursor/checkpoint protections. Backfill surviving existing content with explicit coverage metadata; do not claim previously pruned payloads were recovered.

**Touch points:** New focused archive repository/layer and migrations under `persistence`; existing runtime-event repository and provider-service capture interface.

**Accept when:** Large Unicode text/JSON can be reconstructed byte-for-byte according to the encoding contract; duplicate accepted identities are idempotent; differing content under one identity is rejected; reads are paged; interrupted writes leave no published partial record. Operational pruning and database reopen do not remove archive content. Disk failure tests establish the contract used by 007.

### VIB-005 — Capture Codex payloads before destructive shaping

**Problem/outcome:** A later hook at `ProviderService` cannot recover data already compacted at Codex ingress.

**Scope:** Connect archive acceptance at the native notification/request boundary before `compactCodexNativeEventForIngress`, with bounded queues/backpressure. Preserve native request IDs, session/lifecycle identity, ordering, tools/results and approval decisions without changing authorization or responding twice.

**Touch points:** `codexAppServerManager.ts`; `provider/Layers/CodexAdapter.ts`; runtime ingress/budget helpers; archive API.

**Accept when:** Recorded stream fixtures, unknown events, multi-megabyte tool output, approvals, cancellation and reconnect preserve full supported data and existing normalized UI behavior. Setup/auth secrets follow 003's exclusion policy. Retrying a capture cannot rerun a tool or answer a stale request.

### VIB-006 — Capture Claude payloads before destructive shaping

**Problem/outcome:** Claude's normalized/runtime diagnostic representation intentionally strips some original data.

**Scope:** Connect capture to the SDK message and permission/input lifecycle before `stripDiagnosticImages` and preview shortening. Keep `canUseTool`, permission modes/settings, account identity, process ownership and session resume unchanged.

**Touch points:** `provider/Layers/ClaudeAdapter.ts`; `provider/claudeAgentSdk.ts`; archive API; Claude fixtures.

**Accept when:** Streaming deltas and final snapshots, tool calls/results, approvals/denials, questions, interrupted turns and session restarts retain reconstructable content without duplicating messages. Capture exclusions and attachment handling match 003. Existing permission and process tests remain green.

### VIB-007 — Enforce capture failure and projection/replay guarantees

**Problem/outcome:** Adding an archive must preserve persist-before-display while stopping work when required recording cannot continue.

**Scope:** Integrate capture acceptance with the supervised pump/dispatch readiness. Introduce bounded archive failure state and stop/interruption behavior rather than merely retrying forever while work proceeds. Keep semantic domain events, previews and raw records linked; avoid making the UI hydrate every raw event.

**Touch points:** `providerRuntimeEventPump.ts`; `provider/Layers/ProviderService.ts`; `orchestration/Layers/ProviderRuntimeIngestion.ts`; engine publication and session stop paths.

**Accept when:** Disk-full, unavailable database, malformed payload, duplicate delivery and restart tests retain the last committed record, block new dispatch, stop active work and show an actionable failure. Archive retries never duplicate provider execution. Replay reconstructs the same UI; streaming text remains complete while long tool previews stay bounded and point to full content.

### VIB-008 — Add project-scoped history search and exact payload reads

**Problem/outcome:** Any omitted handoff/summary content must actually be discoverable later.

**Scope:** Add FTS5 over relevant retained messages/tool text and exact source/payload lookup. Reuse existing stable pagination, thread targeting and capability checks. Include archived chats under an explicit authorized history option; do not expose deleted or other-project data accidentally. Keep sidebar search compatibility separate from the new agent-facing API.

**Touch points:** `threadSearch.ts`; `agentGateway/threadReadTools.ts`, `threadDiagnosticTools.ts`, `threadSummary.ts`, target resolver/capabilities; new FTS migration/repository; frontend search as needed.

**Accept when:** An agent retrieves an old fact and a complete oversized result after handoff, operational pruning and restart. Every excerpt has source IDs and continuation instructions; default text output is bounded to 12,000 characters including its response envelope. Cross-project IDs/cursors are rejected at the service boundary. Index rebuild/backfill and update/delete behavior are covered.

### VIB-009 — Persist separate project and chat/goal summary revisions

**Problem/outcome:** Project knowledge and a conversation's working state need independent revision history.

**Scope:** Add revision/candidate repositories and typed read/update contracts. Keep notes, display snippets and provider-native compaction separate. Implement atomic revision commit with cited durable sources, processed watermark, expected previous revision and per-scope concurrency control.

**Accept when:** Two chats share project knowledge without overwriting each other's chat state; simultaneous project-summary writers cannot lose updates; failure keeps the previous revision and pending candidates. Rollback, deletion and project relocation have explicit invalidation rules. Empty summaries are valid, allowing 013–014 before classification exists.

### VIB-010 — Add the configurable Clef decision-engine client

**Problem/outcome:** Provide bounded local classification with a safe fallback, without making ordinary chats depend on a running model.

**Scope:** Implement `DecisionEngine.decide(state, questions)` against the README's Jev/System One endpoint. Validate question/answer schemas, allowed choices, response size, timeout and cancellation. Configure endpoint/model/optional credential through existing settings and secret storage. Verify the actual installed Ollama/Clef API during qualification rather than treating the README as a runtime test.

**Accept when:** Recorded valid/invalid responses, timeout, unavailable model and cancelled request yield typed outcomes. Invalid/uncertain decisions retain information. Credentials never appear in logs/history packets. Clef cannot approve tools, invent operation arguments or mark goals complete.

### VIB-011 — Classify completed-turn information into durable candidates

**Problem/outcome:** Extract useful information for later rewriting without copying every message into summaries.

**Scope:** Subscribe at successful coding-turn boundaries, read bounded source sections, classify retention/category, and persist source IDs and pending candidates. Always include explicit goal/objective/status changes. Distinguish coding turns from maintenance turns so classification cannot recursively trigger itself.

**Accept when:** Duplicate completion events produce one candidate set; failures/interruption follow documented retention rules; unavailable Clef conservatively retains pending candidates. Retries/restart do not skip source ranges. Source text remains immutable and complete irrespective of classification.

### VIB-012 — Rewrite summaries through isolated tools-off provider sessions

**Problem/outcome:** Replace stale facts and resolved blockers with current knowledge while retaining revision evidence.

**Scope:** Add a dedicated maintenance operation using the current coding provider/account/model and existing text-generation isolation/process helpers where suitable. Tools-off must be enforced by launch configuration, not just a prompt. Bound inputs/outputs and validate structured source references. Do not alter the native coding session's history or permissions.

**Accept when:** After five completed coding turns with pending retained information, revisions update once. New revisions deduplicate/supersede facts, remove resolved blockers, and stay within the 8,000-character-per-summary cap. Failure/cancellation/invalid sources leave prior revisions and pending candidates intact. Maintenance cannot run tools, count as coding progress, or trigger a goal continuation.

### VIB-013 — Build bounded handoff packets from durable information

**Problem/outcome:** Preserve recent intent and useful knowledge with explicit, reproducible limits.

**Scope:** Replace excerpt selection with a pure deterministic builder receiving durable summary revisions, objective/status, recent messages, source watermark and actual send allowance. Default to the latest 12 user/agent messages within 24,000 characters, plus summaries capped at 8,000 each; reserve metadata and provider prompt overhead rather than assuming 40,000 characters always fit. Select newest messages before rendering chronologically. Include omission counts and usable history-tool instructions.

**Touch points:** `orchestration/handoff.ts`; send-context budget helpers; contracts and handoff fixtures.

**Accept when:** The current request is preserved, recent decisions take priority over older excerpts, Unicode and budgets 0/1/2 are handled, empty/stale summaries have an explicit fallback, and identical inputs produce identical packet hashes. Full source history is never mutated. Cover the 700-character regression from the audit.

### VIB-014 — Integrate immutable packets into existing handoff/recovery

**Problem/outcome:** Use the new context while keeping the existing provider switch behavior and failure controls.

**Scope:** Persist the final packet before dispatch, bind it to the same conversation and new provider session, and record accepted/failed/uncertain status through existing delivery/receipt mechanisms. Reuse the same context preparation when native resume is unavailable. Keep active-turn/background-task/approval gates and source selection restoration. Leave deliberate new-thread forks as independent operations rather than silently merging their histories.

**Touch points:** `ProviderCommandReactor.ts`; `ProviderService.ts` and session directory; `useThreadHandoff.ts`; handoff divider/outcome contracts.

**Accept when:** Codex -> Claude -> Codex retains one app conversation and starts fresh target sessions. Ordinary same-provider turns send only new input unless native history is unavailable. Failed target start and crashes between prepare/start/send/outcome retain a clear packet/outcome and do not replay tools or blindly resend uncertain input. Inspectable context equals the actual dispatch record, not a switch-time estimate. This milestone can use existing/empty summaries before 012 exists.

### VIB-015 — Refresh summaries before handoff and completion, with fallback

**Problem/outcome:** Ensure pending knowledge is available at the two most important boundaries without making a local-model failure block provider switching.

**Scope:** Wire 012 into a cancellable pre-handoff/pre-goal-completion gate. Freeze the source watermark and relevant revisions for packet assembly. On rewrite failure use the previous revisions and a bounded, marked unsummarized excerpt. Record which path was used.

**Accept when:** Concurrent user input, summary generation and provider selection changes cannot send a packet for the wrong target or omit unprocessed recent information silently. A failed rewrite neither advances the processed watermark nor erases candidates. The latest user request and provider approval settings survive every fallback.

### VIB-016 — Expose project/chat summaries and exact handoff context

**Problem/outcome:** Make context state understandable and reviewable in the retained interface.

**Scope:** Add separate project and chat/goal panels using existing disclosures/panels, typography and localization patterns. Show revision freshness, pending/failed refresh state, sources, and the exact packet/omissions attached to a handoff. Preserve existing provider attribution and conversation scrolling.

**Accept when:** Reload restores the same revisions/packet; panels show correct project/chat isolation; keyboard/reduced-motion/accessibility checks pass. UI updates stay within this requested information workflow. Browser screenshots verify the panels alongside streaming and Monaco.

### VIB-017 — Extend existing goals with evidence and project admission

**Problem/outcome:** Preserve Synara's goal loop while enforcing Vibeinator's explicit states and completion contract.

**Scope:** Keep complete objectives/revisions in SQLite, distinguish paused/blocked/completed, require agent-reported progress/completion evidence, and enforce one active coding turn per project at authoritative admission. Preserve human-input precedence, approval waits, failure pauses and no default turn/time/cost cap. Define no-progress detection using agent reports and deterministic lifecycle signals; Clef does not judge coding correctness.

**Touch points:** `goalMode.ts`; goal tool and command contracts; `decider.ts`; continuation/recovery paths; existing project/session workspace admission; goal projection/history and summary triggers.

**Accept when:** Two competing chats cannot bypass project coding admission; permit release occurs on interruption/crash/failure; maintenance tasks cannot claim progress. Completion stores evidence and refreshes summaries, blocked differs from user pause, large old objectives remain readable, and restart never silently continues a goal. Preserve existing successful goal timing/queue tests and add focused tests for the stricter product policy.

### VIB-018 — Expose coarse tools over the retained gateway

**Problem/outcome:** Reduce model-facing tool/context overhead without replacing safe existing implementations.

**Scope:** Implement `vibe.files`, `vibe.repo`, `vibe.history`, `vibe.browser` as focused facades over existing workspace/Git/history/browser services and the authenticated Agent Gateway. Accept intent plus optional explicit operation and structured arguments. When omitted, Clef chooses only an allowlisted operation; deterministic fallback and clarification cover uncertainty. The caller supplies destinations/arguments.

**Accept when:** Results default to 12,000 characters with source IDs and retrievable omissions, full supported captured results are stored, path/symlink/project checks stay authoritative, and browser external effects retain existing approval gates. Invalid routing grants no permissions. Explicit operation works with Clef offline. Keep native-provider tools available and accurately describe that only routed outputs are filterable.

### VIB-019 — Qualify migrations, provider handoffs and Windows delivery

**Problem/outcome:** Demonstrate that the adapted app preserves history and does not trade responsiveness or permissions for retention.

**Scope:** Run the inherited format/lint/typecheck/affected tests, migration/runtime guards and relevant broad suites. Add end-to-end failure/restart scenarios and Windows packaging smoke. Establish measurements rather than selecting another framework on expected percentages.

**Accept when:** A disposable Codex/Claude session completes approve, deny, interrupt, same-provider resume, cross-provider switches and lost-session recovery. Retained old/large payloads are retrieved after pruning/restart; summary failures and Clef outages preserve chat/handoff. An isolated baseline DB upgrades without loss; rollback requires restoring a verified backup when schema incompatibility exists. App identities/update feeds remain separate. No claimed pass relies only on mocks for native behavior.

**Measurement matrix:** Cold/warm startup; app idle and streaming memory across all app processes; first visible text and input latency; scrolling while Monaco is open; archive bytes and write cost; FTS latency; handoff input size and preparation latency. Use the same machine/scenario for the unmodified baseline and candidate, with short chats and synthetic large histories (for example 10,000 and 100,000 retained messages). Report Ollama/provider/browser memory separately. Choose numeric regression gates from those baseline measurements, not from guessed Tauri savings.

### VIB-020 — Remove only measured, unwanted background costs

**Problem/outcome:** Optional simplification once we know which retained services impose a real cost.

**Scope:** Measure startup subscriptions, periodic jobs, dependencies and unwanted UI paths. Candidate areas include extra providers, Hubs, automation/device integrations and marketing build participation. Disable or remove one independently owned feature per PR only after checking contracts, dynamic references, migrations and tests.

**Accept when:** A measured cost or clear product exclusion justifies each removal, required behavior remains qualified, and retained history/schema remain readable. Record actual removed code/dependencies and performance changes. No blanket deletion percentage or reactor rewrite is a prerequisite for shipping.

## Splitting into GitHub issues and PRs

Use these IDs as draft labels until real issue numbers exist. Each created issue should carry: the trigger/problem, user-visible result, retained implementation, precise scope, dependencies, acceptance evidence, migrations/data effect, and out-of-scope work. Do not paste the entire architecture into every ticket; link this document and the corresponding audit finding.

Create the first baseline/storage/handoff milestone first. Keep provider-specific capture changes separate, but merge their shared schema/API before either adapter integration. Keep summary storage independent of model invocation. Keep UI changes separate from backend/schema changes when that makes review and rollback clearer.

Do not create a ticket to rebuild authentication, approvals, streaming, Monaco, Git diffs or the desktop shell: those already exist. Only open a gap/fix issue when baseline qualification demonstrates a concrete mismatch. GitHub issues #1–#20 now track these steps in `felixrydberg/Vibeinator`. VIB-001 adoption is underway on `codex/vib-001-desktop-baseline`; its qualification acceptance remains open.
