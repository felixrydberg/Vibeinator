# Synara audit for Vibeinator

What this repo does: Synara is a local coding-agent workspace with an Electron host, a React frontend, and a separate TypeScript server. It already owns provider sessions, streaming, approvals, durable orchestration, Git, Monaco editing, browser tools, goals, and recovery. This audit assumes one desktop user, several projects, long conversations, and Codex/Claude as the first qualified providers.

**Recommendation: retain the application and extend its information pipeline. Do not replace the provider adapters, permission system, event engine, frontend transport, editor, or database driver.**

Audited on 3 November 2026 against [Synara commit `3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4`](https://github.com/Emanuele-web04/synara/tree/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4). The source was cloned into the ignored `.synara-audit-source` directory for inspection and fixture tests. It has not been adopted as Vibeinator's application source.

## Scope and confidence

This is a repository-wide architecture, correctness, and implementation-readiness audit. All 9,366 tracked paths were inventoried. All seven workspace manifests, entry boundaries, build/CI configuration, and subsystem layout were mapped. Deep inspection concentrated on persistence, event delivery, handoffs, history queries, goals, recovery, and their callers/tests. Desktop isolation, process handling, authentication/capability boundaries, browser/editor integration, and release ownership were sampled at their integration points.

This is **not a claim that every line or every provider implementation was read**, an exhaustive security certification, or a live-provider qualification. Findings below distinguish reproduced defects, source-confirmed product differences, and unverified runtime failures. Existing intentional limits are not presented as upstream bugs merely because Vibeinator needs different behavior.

| Workspace            | Tracked files | JS/TS-family files | Test/spec/browser-named files | Audit disposition                                                                            |
| -------------------- | ------------: | -----------------: | ----------------------------: | -------------------------------------------------------------------------------------------- |
| `apps/desktop`       |           330 |                282 |                           124 | Retain host, preload, backend supervision, browser integration; isolate fork identity        |
| `apps/server`        |         1,510 |              1,490 |                           620 | Deep review of information lifecycle; retain providers, engine, authentication, and recovery |
| `apps/web`           |         6,036 |              1,999 |                           704 | Trace handoff, hydration, normalized store, editor and Git integration; retain UI            |
| `apps/marketing`     |           256 |                122 |                            15 | Review manifest/config/docs checks; outside application delivery path                        |
| `packages/contracts` |            91 |                 89 |                            27 | Retain schema ownership; extend information and handoff contracts                            |
| `packages/shared`    |           256 |                226 |                           105 | Retain platform/process, identity, policy and pagination helpers                             |
| `scripts`            |           141 |                119 |                            38 | Retain build, migration, runtime and release checks; redirect fork distribution              |

Counts describe files, not executed test cases or coverage percentages. Marketing tests under a `tests/` directory and other naming patterns can differ from this simple classification. See [the machine-readable inventory](audit/synara-inventory.json).

## Existing architecture worth retaining

The main flow is:

```text
React composer -> typed WebSocket RPC -> orchestration command engine
    -> SQLite orchestration events + projections + command receipt
    -> committed-event publication -> provider command reactor
    -> provider service -> Codex app-server / Claude Agent SDK

Provider callbacks -> adapter normalization -> supervised event pump
    -> bounded SQLite runtime-event journal -> ingestion/checkpoint consumers
    -> durable orchestration updates -> frontend streams and hydrated views
```

The database has two importantly different event stores:

| Store                     | Existing purpose                                                       | Consequence for Vibeinator                                                             |
| ------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `orchestration_events`    | Durable domain events: accepted messages, state changes and activities | Keep as the authoritative normalized conversation/state journal                        |
| `provider_runtime_events` | Bounded delivery/recovery journal with consumer acknowledgements       | Keep as a delivery buffer; add durable full-content capture before destructive shaping |

The command engine commits events, hot projections and its command receipt in a transaction, then publishes committed events. The provider service also journals canonical provider events before live publication. These ordering guarantees already exist; rebuilding them would create unnecessary risk. [Command transaction][engine] · [Provider publication][provider-service]

The SQLite layer already provides WAL, foreign keys, a lifecycle lock, migration backups/recovery, and memory budgeting. It supports both Bun and Node execution. Its deliberate `synchronous=NORMAL` setting is a power-loss durability tradeoff, not a corruption finding. Decide whether Vibeinator needs stronger durability after measuring the cost; do not silently promise that every acknowledged event survives power failure. [SQLite setup][sqlite]

Existing history tools provide message pagination and stable long-message slices. Existing diagnostic tools page orchestration/runtime events. These are valuable building blocks, although their current scope, retention and output shaping do not equal the planned project-scoped full-history service. [Thread reads][thread-read] · [Diagnostic reads][diagnostic-read]

## Must fix before the affected Vibeinator feature ships

### 1. A tight handoff budget can discard the newest prior decision

- **What this is:** The handoff builder formats up to six recent messages in chronological order and then truncates the assembled text from its end.
- **Problem:** Reproduced with an older 1,004-character message, a newer message containing `LATEST-DECISION: keep SQLite`, and a 700-character allowance: the newer decision is absent and one message is omitted. The current user request is separate, but the latest prior answer or decision can disappear.
- **Fix:** Select prior messages newest-first within the allowance, then render the selected messages chronologically. Define what happens when even the newest message cannot fit, and report every omission or shortening.
- **If we skip it:** A provider switch can lose the most recent instruction or implementation conclusion even though older text was transferred.

Type: reproduced correctness defect. Evidence: [handoff selection and final truncation][handoff]. Planned issue: **VIB-013**. A dependency-free reproduction is saved in [audit verification](audit/VERIFICATION.md).

### 2. The current raw-event journal cannot serve as a complete historical archive

- **What this is:** Runtime consumers acknowledge events; retention removes accepted rows while protecting open turns, pending checkpoints, and a trailing 512-event diagnostic tail.
- **Problem:** After enough completed work, older native payloads are no longer present in this table. Events over 2 MiB may also have string leaves shortened to 64 KiB and raw payloads replaced with a truncation marker. Codex ingress can compact earlier, and Claude removes diagnostic image bodies before its runtime queue.
- **Fix:** Capture approved conversation payload classes in an append-only SQLite archive before these transformations. Keep the bounded delivery buffer and its acknowledgement semantics. Store large content as bounded chunks with durable references, and retain links between native records and normalized domain events.
- **If we skip it:** Search, summary provenance and handoff recovery cannot retrieve content that has already been discarded. Increasing a display or handoff limit cannot recover it.

Type: source-confirmed mismatch with Vibeinator's retention requirement, not an upstream retention bug. Evidence: [runtime limits][runtime-contract] · [archive compaction and retention][runtime-store] · [Codex ingress][codex-adapter] · [Claude queue][claude-adapter]. Planned issues: **VIB-003–007**.

### 3. Active goals are automatically continued on startup

- **What this is:** `recoverActiveThreadGoals` selects unpaused active goals and dispatches `thread.goal.continue` with trigger `startup-recovery`. The reactor invokes it during startup.
- **Problem:** Reopening the app can resume a previously active goal. Our requirement is to mark goals paused and require explicit resume after restart. Synara's test explicitly expects active idle goal recovery.
- **Fix:** Preserve recovery of conversation and pending-request state, but persist a startup pause before any automatic goal dispatch. Inspect ordinary-chat restart continuation and saved quit/resume paths as well, so they cannot bypass the chosen policy.
- **If we skip it:** Vibeinator can start coding work on launch without the resume action specified in our plan.

Type: intentional upstream behavior requiring a product adaptation. Evidence: [startup goal recovery][goal-recovery] · [goal recovery test][goal-test] · [server startup][effect-server]. Planned issue: **VIB-002**.

### 4. Existing search is not the planned history retrieval service

- **What this is:** `threadSearch.ts` powers the sidebar search using substring predicates over settled user/assistant message projections.
- **Problem:** It excludes archived and child threads, has no project filter in this query, returns a best excerpt per thread, and scans message bodies rather than an FTS5 index. An agent looking for an old decision in an archived chat or full tool result cannot use this as the required project-scoped retrieval path.
- **Fix:** Keep sidebar behavior compatible. Add a project-authorized search/read service over retained history, with FTS5, stable source IDs, pagination, and explicit archived-history behavior. Reuse the existing message/event page readers instead of creating a second transcript.
- **If we skip it:** Handoff packets can promise retrieval that does not actually reach omitted information. Large-history search cost also grows with scanned text.

Type: source-confirmed feature/scope gap; no latency claim was benchmarked. Evidence: [search query][search] · [existing read tools][thread-read]. Planned issue: **VIB-008**.

### 5. An oversized goal's full objective lives outside SQLite and can be pruned

- **What this is:** Large goals are materialized to per-thread Markdown files. The persisted goal becomes a short reference, and superseded/completed goal files are cleaned up.
- **Problem:** A later history reconstruction from SQLite alone cannot obtain the original objective from that reference once its file is removed.
- **Fix:** Store the complete versioned objective in SQLite. An optional materialized file can remain a derived provider-delivery artifact, with its reference mapped to the retained objective revision.
- **If we skip it:** Completed or replaced large objectives can lose the text needed to explain decisions and verify a handoff's objective.

Type: mismatch with the planned source-of-truth contract. Evidence: [goal materialization][goal-files] · [post-commit cleanup][engine]. Planned issues: **VIB-003** and **VIB-017**.

## Should fix as part of the planned feature work

### 6. Handoff context is an excerpt, not independently maintained knowledge

- **What this is:** Recent messages are limited to 2,400 characters each, older messages to 320, and the assembled transcript to 32,000. The builder calls older excerpts a summary.
- **Problem:** A critical architectural decision late in an old message can be removed even when the message itself is included. This path does not supply the separate revisioned project and chat/goal summaries in our design.
- **Fix:** Add provenance-bearing summary revisions and retention candidates; compose them with recent raw messages. Keep a deterministic fallback when classification or rewriting is unavailable.
- **If we skip it:** Context quality depends on where a fact happened to appear in the transcript.

Type: planned information-quality improvement, not an allegation that existing limits are accidental. Evidence: [handoff builder][handoff] · [thread fields][contracts]. Planned issues: **VIB-009–015**.

### 7. The handoff timeline is not an immutable record of the final sent packet

- **What this is:** Same-thread handoff computes and records `contextText` when switching. The next send builds context again with its actual remaining input allowance and prompt additions.
- **Problem:** A large next request can yield a smaller recap than the one recorded at switch time. A switch-time preview alone does not prove the exact final context accepted by the target.
- **Fix:** Persist an immutable packet at dispatch preparation: source watermark, summary revision IDs, recent-message IDs, omissions, exact assembled context, target session, and send outcome. Reconcile uncertain acceptance using existing delivery machinery rather than blindly sending it again.
- **If we skip it:** Debugging a lost-context report requires guessing which of several context representations was delivered.

Type: source-confirmed observability/contract gap. Evidence: [switch-time record][handoff-execution] · [send-time composition][send-context]. Planned issues: **VIB-013–015**.

### 8. Goal completion is represented more simply than Vibeinator requires

- **What this is:** `synara_set_thread_goal` accepts `achieved: true` or `blocked: true`; completion clears the active goal and records an achievement, while blocked pauses it.
- **Problem:** The shown tool contract does not require structured completion evidence or keep blocked and user-paused as distinct reported states. Two goal-bearing chats can also need a new project-level coding admission rule; thread-level serialization is not proof of that rule.
- **Fix:** Extend the existing goal contracts and continuation loop with durable status/reason/evidence and an authoritative project coding-turn fence. Preserve queued human-input precedence and existing approval waits. Do not make Clef judge correctness.
- **If we skip it:** We cannot enforce or explain the evidence-bearing, one-coding-turn-per-project behavior in the README.

Type: feature gap. A project-level concurrency violation was not reproduced; admission behavior must be characterized before changing it. Evidence: [goal tool][goal-tool] · [goal prompt][goal-prompt] · [command admission][admission]. Planned issue: **VIB-017**.

### 9. A fork must isolate its identity and release destinations before distribution

- **What this is:** Desktop scheme, bundle ID, data-directory names and update channel are defined for Synara. Packaging derives update feeds from its configuration and environment.
- **Problem:** Shipping Vibeinator with those identities can share application/profile ownership with Synara or select an unintended update destination. Renaming only the window title is insufficient.
- **Fix:** Give the fork separate application/backend/browser data homes, protocol and updater identity. Keep updates disabled until a Vibeinator feed exists. Preserve license notices and the migration lineage; do not rename internal packages indiscriminately.
- **If we skip it:** Installing or launching the fork can interfere with the original application or make future updates unsafe.

Type: fork-adoption requirement, not an upstream vulnerability. Evidence: [desktop identity][identity] · [artifact publisher configuration][artifact]. Planned issue: **VIB-001**.

## Nice to have, bundled into existing work

### 10. Very small context budgets exceed their stated length

- **What this is:** `truncateText` appends `...` even when the supplied allowance is below three characters.
- **Problem:** Direct calls with budgets 0, 1, and 2 each returned three characters. Production send paths skip a zero allowance, but positive tiny allowances can still reach this helper.
- **Fix:** Return an empty string at zero and fit the truncation marker inside positive tiny allowances. Add boundary assertions alongside the newest-message retention test.
- **If we skip it:** A narrow edge case violates the builder's advertised hard bound.

Type: reproduced low-impact bound defect. Evidence: [truncation helper][handoff]. Include in **VIB-013**, not a separate refactor project.

## Reuse and deferral decisions

| Area                                        | Existing implementation inspected                                                                | Decision                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex/Claude                                | `codexAppServerManager.ts`, provider adapters/service, SDK loader, event pump, session directory | Retain. Add capture hooks at native boundaries; do not replace permission callbacks or cancellation                                          |
| Storage                                     | SQLite layer, event repositories, engine, migration tracker/backups/reclamation                  | Extend additively. Preserve replay, receipt deduplication, bounded consumers and backup safety                                               |
| Frontend                                    | `useThreadHandoff`, handoff helpers, WebSocket transport, normalized store/derivation            | Retain same-thread UX and hydration. Add summary/packet visibility through existing patterns                                                 |
| Monaco/Git                                  | Editor panes, lazy localization load, shared models, Git scopes/staging contracts                | Already present. Qualify requirements and patch demonstrated gaps; do not schedule a new editor build                                        |
| Tools and authorization                     | Agent Gateway, scoped principals/capabilities, external MCP policy, real-path checks             | Reuse as the implementation under `vibe.*`; classification must never grant authority                                                        |
| Text generation                             | Existing Codex/Claude Git-writing helpers and isolated child execution                           | Candidate building blocks for summary maintenance; add a distinct operation with the active provider/account and verified tools-off behavior |
| Browser/terminal                            | Desktop-owned browser bridge, host RPC, project files, shared process runtime                    | Retain. Test result retention and external-side-effect approvals through the actual adapter path                                             |
| Automations, Hubs, devices, extra providers | Registered in server composition and UI; independently tested subsystems                         | Defer pruning. Avoid deleting them just to reduce file count; qualify Codex/Claude first                                                     |
| Marketing, onboarding, releases             | Separate Next.js workspace; release scripts, identity and CI gates                               | No redesign or deployment. Exclude marketing from the first app-delivery milestone where existing tooling allows                             |

No defensible line-count or dependency deletion estimate follows from this audit. Large modules are a maintenance consideration, not proof of dead code. Extract only the new archive/summary/packet jobs at their ownership boundaries; do not begin with a wholesale reactor or adapter refactor.

## Verification results and limitations

The isolated checkout used Node 24.22.1 and downloaded Bun 1.4.4 locally because the installed Bun 1.3.13 cannot read Synara's lockfile version. Frozen installation with lifecycle scripts disabled installed 1,649 packages. This is sufficient for the reported fixture checks, not a fully qualified packaged build; normal dependency lifecycle patches/native setup remain part of baseline qualification.

| Check                                        | Result                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Windows runtime boundary script              | Passed: 318 application files, 121 boundary files, four dependency patches, eight manifests    |
| Migration lineage script after fetching tags | Passed against 110 shared release tags, `v0.0.16` through `v1.1.1-beta.1`                      |
| Focused server run: ten suites               | 765 passed, one failed, 256 skipped; eight suites passed and two did not pass                  |
| Provider-service rerun outside sandbox       | All 256 passed; initial suite failure was a sandbox hard-link `EPERM`                          |
| File-recovery rerun outside sandbox          | Still failed: timed out waiting for `sendTurn` in the edit-replay recovery test                |
| Focused frontend: four suites                | 173 passed: handoff helpers, store reducer/projection, workspace-file-editor helpers           |
| Marketing workflow/release-doc checks        | 20 passed                                                                                      |
| Direct handoff reproduction                  | Confirmed newest-prior-message omission at 700 characters and 0/1/2-character bound violations |

The unresolved recovery test is `ProviderCommandReactor.test.ts`, “retains a discoverable file recovery snapshot across edit replay and store restart” at line 14,469. It logs creation of a rescue snapshot, then fails before the expected resend. Root cause is **not established**: fixture timing, Windows behavior and an implementation defect remain possibilities. Treat this as a baseline investigation in VIB-001, not a proven data-loss vulnerability. Do not call the baseline fully green.

Full-repository lint/typecheck, the full test suite, browser/Electron suites, signed packaging, live provider authentication/approvals, hardware performance, Linux/macOS, and actual Clef integration were not run. No exploit finding is claimed. Complete those qualification gates before changing the guarantees they cover. See [verification details](audit/VERIFICATION.md).

**Verdict:** keep Synara's foundations. Establish an isolated, understood baseline; preserve full information before pruning; add retrieval and summary revisions; then change the handoff packet. Use the [implementation draft](IMPLEMENTATION-DRAFT.md) for issue sequencing.

[engine]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L1295
[provider-service]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/provider/Layers/ProviderService.ts#L2191
[sqlite]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/persistence/Layers/Sqlite.ts#L90
[runtime-contract]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/persistence/Services/ProviderRuntimeEvents.ts#L7
[runtime-store]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/persistence/Layers/ProviderRuntimeEvents.ts#L97
[codex-adapter]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/provider/Layers/CodexAdapter.ts#L149
[claude-adapter]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2631
[handoff]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/handoff.ts#L4
[goal-recovery]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L10779
[goal-test]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts#L11804
[effect-server]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/effectServer.ts#L279
[search]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/threadSearch.ts#L84
[goal-files]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/threadGoalMaterialization.ts#L1
[contracts]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/packages/contracts/src/orchestration.ts
[handoff-execution]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L8190
[send-context]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L3803
[goal-tool]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/agentGateway/Layers/AgentGateway.ts#L1035
[goal-prompt]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/provider/goalMode.ts
[admission]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/orchestration/orchestrationAdmission.ts
[identity]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/packages/shared/src/desktopIdentity.ts#L4
[artifact]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/scripts/build-desktop-artifact.ts#L695
[thread-read]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/agentGateway/threadReadTools.ts#L287
[diagnostic-read]: https://github.com/Emanuele-web04/synara/blob/3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4/apps/server/src/agentGateway/threadDiagnosticTools.ts#L353
