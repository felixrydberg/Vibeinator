# Vibeinator

A desktop app for working with Codex and Claude while preserving project context across sessions and provider switches.

Status: the desktop baseline is adopted. Conversations restore paused after restart; storage and handoff changes remain planned.

The [Synara audit](docs/SYNARA-AUDIT.md) maps the existing implementation and confirmed gaps. The [implementation draft](docs/IMPLEMENTATION-DRAFT.md) defines issues, dependencies, acceptance criteria, and milestone order. The [tracker](docs/IMPLEMENTATION-TRACKER.md) links twenty GitHub issues and records delivery state. The [adoption report](docs/BASELINE-ADOPTION.md) records passing checks and remaining qualification. [UPSTREAM.md](UPSTREAM.md) records the source revision and retained notices.

## Run the desktop app

Use Node 24.13.1 or newer within Node 24, and Bun 1.4.4.

```sh
bun install --frozen-lockfile
bun run dev --dry-run
bun run dev
```

`bun run build` builds the desktop and its backend/renderer dependencies. `bun run start` opens that build. `bun run package:desktop` creates an unsigned installer for the current platform; on Windows, `bun run dist:desktop:win` creates the x64 NSIS installer. Packaging does not publish a release. Native packaging requirements are documented in the inherited [release guide](docs/release.md); its Synara publishing instructions do not apply to Vibeinator.

The desktop is the only product. Bun workspaces and Turborepo keep `apps/desktop` (Electron), `apps/web` (embedded React renderer), `apps/server` (private backend), `packages/contracts`, `packages/shared`, and `scripts` separate. The renderer and backend are internal components, not separately shipped apps. New applications or libraries can be added under `apps/*` or `packages/*`; internal `@synara/*` names remain for now to preserve existing imports.

Vibeinator uses `~/.vibeinator` for packaged backend data, `~/.vibeinator-dev` during desktop development, and separate Electron profiles. Override backend data with `VIBEINATOR_HOME` or `--home-dir`; inherited `SYNARA_HOME` is ignored. To test with disposable data, run `bun run dev --home-dir ./.vibeinator/test-run --dry-run` before removing `--dry-run`. Automatic updates have no feed by default, and parallel Beta installation is disabled until Vibeinator owns its release channel.

## Synara foundation

Use [Synara](https://github.com/Emanuele-web04/synara) as the application base and retain as much of its working implementation as possible. Take ownership of a pinned source revision without planning ongoing upstream merges. Preserve its license and copyright notices.

Keep the Electron/React interface, provider adapters, streaming pipeline, authentication, approval handling, session lifecycle, editor, Git/browser tools, and packaging wherever they satisfy the requirements below. The main changes are how conversation information is stored, summarized, retrieved, and handed between providers. Assess existing behavior before replacing a component; remove features only when they interfere with the intended workflow or impose a demonstrated maintenance or performance cost.

## Implementation order

1. Import a pinned Synara baseline and verify its Windows build, Codex/Claude streaming, approvals, and session recovery.
2. Adapt existing SQLite persistence and event capture to the authoritative conversation-storage requirements below.
3. Add separate project and chat/goal summaries, with Cloudflare Clef through Ollama for retention classification.
4. Adapt provider handoffs to use persisted summaries and bounded recent history while retaining the existing provider integrations.
5. Fill gaps in goals, tool routing, context limits, and editor/Git review by extending the retained components.

## Desktop and storage

Retain Synara's Electron + TypeScript/React desktop, Bun/Effect backend, SQLite integration, build tooling, and test framework. Target Windows first, keeping path and process handling portable. Preserve the existing typed frontend/backend transport and isolated preload boundary; database access, subprocesses, and privileged tools belong outside the renderer. Avoid changing runtimes, database drivers, or packaging tools as part of the storage and handoff work.

Provide projects/chats, a streaming conversation with expandable tool activity, provider/model selection, goal controls, history search, separate summary panels, and executable/decision-engine settings.

SQLite is the full source of truth. Store projects, chats, goals, turns, provider sessions, ordered events, summary revisions, and classification results in application data. Enable foreign keys, WAL, transactional migrations, and FTS5 history search.

The [durable information contract](docs/DURABLE-INFORMATION.md) defines the storage records, source identities, migration/backout rules and synthetic upgrade fixtures. Full conversation and objective text belongs in SQLite. Binary attachment bytes remain in the existing managed file store with durable SQLite metadata, availability and references; a SQLite-only backup does not include those external bytes. Retain WAL/NORMAL durability across process crashes; recent commits may be lost after an OS crash or power failure.

Extend the existing event store, schema, migrations, and UI projections where practical. Audit which raw and normalized events Synara already persists, then add the missing capture and metadata at those boundaries. Maintain one authoritative conversation history and keep retained UI projections consistent with it. Schema changes must preserve existing conversations and be verified against a database from the pinned baseline.

Persist user input before dispatch and incoming events before display. Preserve raw provider payloads alongside normalized messages, tool calls/results, timestamps, approvals, usage, errors, and interruption state. Context filtering must not delete stored history.

Reconstruct the UI from SQLite on restart. Mark unfinished turns interrupted and goals paused. Require explicit Resume or new input before continuing restored coding work, including saved queues and usage-limit waits. See the implemented [restart policy](docs/RESTART-POLICY.md). Database write failures stop dispatch and interrupt active work.

## Embedded editor and Git review

Reuse Synara's existing editor and Git review surfaces, extending them to meet these requirements. Embed [Monaco Editor](https://github.com/microsoft/monaco-editor), the editor used by VS Code, in a resizable panel alongside the conversation. Provide project-file navigation, file tabs, syntax highlighting, editing, and explicit save with an unsaved-change indicator. Monaco supplies the editor; the full VS Code workbench and extension system are outside V1 scope.

Show added, modified, and deleted lines through Monaco gutter decorations. Provide a changed-file list and inline or side-by-side review through Monaco's diff editor. Distinguish unstaged changes (index versus working copy) from staged changes (HEAD versus index). Update editor markers against the index as the user edits, including unsaved text; handle untracked files and repositories without a first commit.

Run Git operations, file reads/writes, and file watching outside the renderer, using the Git CLI and existing typed frontend/backend bridge. Monaco receives file contents, comparison baselines, and change markers; it does not access the filesystem or launch commands directly. Restrict file access to the current project with resolved-path and symlink checks. Detect external edits, including agent writes, and require conflict resolution before overwriting a changed file with an unsaved buffer.

Load Monaco and its language workers only when the editor is opened. Reuse the editor surface across tabs, preserve per-file view state, and dispose unused models and listeners. Bundle editor assets locally and keep file loading and Git refreshes asynchronous so they do not block conversation streaming.

## Providers and handoff

Retain Synara's provider interfaces and adapters for availability, session start/resume, streamed turns, permission responses, interruption, and disposal. Add persistence and handoff integration at the existing lifecycle boundaries rather than introducing a parallel provider abstraction.

- Codex: retain the existing `codex app-server` integration.
- Claude: retain the existing Claude Agent SDK/Claude Code integration and session handling.
- Preserve existing authentication, permission settings, approval UI, and cancellation behavior. Storage and handoff changes must not broaden permissions or replace the provider approval mechanisms.

Resume the current native session for ordinary same-provider turns, sending only new input. Native sessions are execution state, not the authoritative conversation store.

Every provider switch starts a fresh native session, including a switch back to a previously used provider. Bootstrap it with the project summary, chat/goal summary, objective/status, and recent raw messages. Use the same recovery path if a native session is unavailable.

Keep the app conversation identity and its stored history across switches. Adapt Synara's existing handoff workflow so a provider session is linked to that conversation and its exact bootstrap packet. Do not copy the conversation into a second authoritative transcript or replay stored tool calls for execution.

Default handoff: latest 12 user/agent messages within 24,000 characters, plus summaries capped at 8,000 characters each. Preserve chronological order and the latest user request. Identify omitted context, provide SQLite history-search instructions, and store the exact handoff packet. A switch during a turn waits for completion unless the user chooses interruption.

## Goals

Goals behave like Codex goals: persist an objective and continue at idle turn boundaries until completion, a blocker, or a user pause. Default to no time, turn, or cost cap.

Track active, paused, blocked, and completed states. Pending approvals, failures, queued user input, and turns without meaningful progress stop automatic continuation. The coding agent reports progress/completion with evidence through `vibe.repo`; Clef does not judge coding correctness. Allow one active coding turn per project. Do not run goals while the app is closed or silently resume them after restart.

## Summaries

Maintain two independently revisioned summaries:

| Project summary                  | Chat/goal summary            |
| -------------------------------- | ---------------------------- |
| Architecture decisions           | Current objective            |
| Important implementation details | Current implementation state |
| Completed major work             | Recent decisions             |
| Known problems                   | Active problems/blockers     |
| Failed approaches to avoid       | Outstanding work             |

After each successful coding turn, Clef classifies bounded message sections for retention and category. Store candidate source-event IDs and classifications. Explicit objective/status changes always enter chat-summary updates.

The active coding provider rewrites summaries in a separate, tool-disabled maintenance session after five completed turns with pending retained information, and before handoff or goal completion. Deduplicate, replace superseded facts, and resolve completed blockers; do not append every message.

Save revisions atomically with source references and processed-event watermarks. Failed rewrites preserve previous summaries and pending candidates. If refresh fails during handoff, use existing summaries plus a bounded, marked unsummarized excerpt.

## Local decision engine: Cloudflare Clef

Use Cloudflare Clef through Ollama as the default local decision model. Clef requires **Ollama 0.35.1 or later** and supports the Jev/System One API. See the [official Ollama model page](https://ollama.com/library/clef) and [Cloudflare announcement](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/).

Install the model separately:

```powershell
ollama pull clef
```

Planned decision-engine defaults:

```json
{
  "endpoint": "http://localhost:11434/v1/systemone",
  "model": "clef"
}
```

Define `DecisionEngine.decide(state, questions)` using typed System One questions, initially `choice`. Requests carry `model`, `state`, and named `questions`; responses contain named `answers`. Use the HTTP API directly rather than generating classifications through a chat prompt.

Configure the endpoint, model, timeout, and optional credential so a hosted Jev/System One-compatible engine can replace Ollama mainly through configuration. `clef-flash` is an optional smaller model selection; `clef` remains the default.

Clef selects information worth retaining, categorizes it, chooses among allowed local operations, and filters irrelevant context. Claude/Codex write summaries and make coding and architectural decisions. Clef never grants permissions or decides that a goal is correctly implemented.

Validate responses. Confidence measures concentration of model probabilities, not a guarantee of correctness. On timeouts, unavailable models, or malformed responses, retain uncertain candidates and use deterministic routing/filtering rather than losing context or blocking ordinary chats.

## Tools and context efficiency

Expose four working MCP capabilities alongside native provider tools:

| Capability     | Initial operations                                                           |
| -------------- | ---------------------------------------------------------------------------- |
| `vibe.files`   | List, search, read relevant file sections                                    |
| `vibe.repo`    | Status, diff hunks, goal-state reporting                                     |
| `vibe.history` | Project-scoped SQLite search and event retrieval                             |
| `vibe.browser` | Controlled Chromium navigation, text, screenshots, clicks, typing, scrolling |

Each accepts an intent plus an optional explicit operation and structured arguments. When the operation is omitted, Clef chooses among allowlisted operations. The coding agent supplies targets and arguments; the router validates them and never invents commands or destinations. Ambiguous requests return clarification requirements. Permission plumbing stays separate from working capabilities.

Default text results to 12,000 characters with source identifiers and pagination. Return relevant sections, diff hunks, and ranked history excerpts. Preserve complete captured results in SQLite and allow retrieval of omissions. Native tool outputs can only be filtered when routed through Vibe.

Scope file/history operations to the current project, including resolved-path and symlink checks. Validate browser URLs, isolate browser profiles per project, and require approval for browser actions with external side effects. Routing classifications do not grant permission.

## Validation and delivery

- Retain Synara's existing test framework and provider fixtures. Establish a passing baseline before changes, then use temporary SQLite databases, fake CLI processes, and recorded protocol fixtures for persistence, migrations, streaming deduplication, approvals, interruption, restart recovery, and failures.
- Verify Codex → Claude → Codex handoffs, missing native sessions, bounded context, summary updates, and retrieval of older history through FTS5.
- Verify summary replacement, project/chat isolation, failed rewrites, Clef timeout/malformed responses, deterministic fallback, and path/browser validation.
- Verify autonomous goals, user-input precedence, pause/resume, approval waits, no-progress stops, and evidence-bearing completion. Smoke-test browser automation against a local page and both providers against a disposable project.
- Verify editor open/save, unsaved-change handling, external-edit conflicts, Git gutter markers, staged/unstaged diffs, untracked files, and repositories without commits. Smoke-test resizing, keyboard focus, and large-file behavior alongside a streaming conversation.
- Deliver Windows packaging and development/setup instructions. CLIs, Git, and Ollama remain separately installed. V1 excludes cloud sync, external transcript import, and the full VS Code workbench and extension system.
