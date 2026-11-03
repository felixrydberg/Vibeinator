# Audit verification record

Date: 3 November 2026. Source: `Emanuele-web04/synara` at `3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4`.

All application checks used an isolated audit checkout and disposable fixture directories. No personal Synara database, provider authentication session or live coding task was used. The clone, downloaded toolchain, dependencies and detailed logs remain under the ignored `.synara-audit-source/` directory. Do not commit that directory as the application import.

## Environment

- Windows, Node 24.22.1, Git 2.43.0.windows.1.
- The system Bun shim fails through Volta. The other installed Bun is 1.3.13 and cannot parse lockfile version 3.
- Bun 1.4.4 was downloaded from its official GitHub release into `.audit-tools/bun-windows-x64/` inside the audit checkout. Frozen installation with `--ignore-scripts` installed 1,649 packages.
- Lifecycle scripts were deliberately not run for this audit install. This is not a fully configured native desktop build. Qualification must apply the normal pinned setup and required dependency patches.
- Vitest's first attempt could not rename cache files in the sandbox-provided system temporary directory. Setting `TEMP` and `TMP` to disposable directories inside `.audit-tools` allowed test collection/execution.

## Checks performed

From the audit checkout:

```powershell
node scripts/check-windows-runtime-boundary.ts
node scripts/check-migration-lineage.ts
node --test apps/marketing/scripts/workflow-docs.test.mjs apps/marketing/scripts/release-feature-docs.test.mjs
```

Results: Windows runtime guard passed across 318 application source files, 121 boundary files, four dependency patches and eight manifests. The lineage guard initially skipped because the shallow clone had no release tags. After `git fetch --tags --depth 1 origin`, it passed against all 110 shared release tags from `v0.0.16` through `v1.1.1-beta.1`. The two marketing documentation test files passed all 20 test cases.

These guards do not replace live Windows process/PTY tests or a database upgrade test. In particular, a skipped lineage check is not a pass; the later tag-backed result is the result used in the audit.

### Server

The pinned Bun runtime was placed first on the process-local `PATH`; `TEMP`/`TMP` pointed at `.audit-tools/temp`. Executed through the repository's Vitest script, not `bun test`:

```powershell
bun run --cwd apps/server test `
  src/orchestration/handoff.test.ts `
  src/orchestration/decider.providerHandoff.test.ts `
  src/orchestration/Layers/OrchestrationEngine.test.ts `
  src/orchestration/Layers/ProviderCommandReactor.test.ts `
  src/persistence/Layers/ProviderRuntimeEvents.test.ts `
  src/persistence/Layers/OrchestrationEventStore.test.ts `
  src/persistence/Migrations.test.ts `
  src/threadSearch.test.ts `
  src/provider/goalMode.test.ts `
  src/provider/Layers/ProviderService.test.ts
```

Initial run: **765 passed, one failed, 256 skipped; eight suites passed and two failed**. Duration approximately 246 seconds. One suite could not start because a fixture's hard-link operation returned `EPERM`. The file-recovery test also timed out and its cleanup hook reached 90 seconds.

Follow-up runs addressed those specific failures:

| Follow-up                                                                                               | Result                                                                 | Interpretation                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ProviderService.test.ts` outside the filesystem sandbox                                                | 256 passed, approximately 23 seconds                                   | The initial hard-link failure was environmental; this fixture suite passed with native filesystem access |
| `ProviderCommandReactor.test.ts -t 'retains a discoverable file recovery snapshot'` outside the sandbox | One failed, 636 deliberately skipped; approximately nine seconds total | Timeout persists; root cause unresolved                                                                  |
| Small server subset (`handoff`, `threadSearch`, `goalMode`) with workspace-local temp                   | 23 passed                                                              | These are already represented in the 765; do not count them twice                                        |

The isolated recovery test is at `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts:14469`. It creates a disposable repository/checkpoints, edits tracked/untracked files, requests edit-and-resend, and waits for `harness.sendTurn` to be called. The rerun logs `edit replay workspace recovery snapshot retained`, then times out before resend. This does not establish loss of the rescue snapshot or a confirmed product bug. Investigate checkpoint/rollback scheduling and fixture timing on the qualified Windows baseline.

The combined observations are **1,021 distinct passing server tests in the selected ten-file set**, one unresolved test failure, with the provider suite qualified separately. They are not a green all-ten-suite run and not the repository's complete server test suite.

### Frontend

```powershell
bun run --cwd apps/web test `
  src/lib/threadHandoff.test.ts `
  src/storeEventReducer.test.ts `
  src/storeProjection.test.ts `
  src/lib/workspaceFileEditor.test.ts `
  --maxWorkers=1 --no-file-parallelism
```

Result: four suites, **173 tests passed**, approximately ten seconds. This verifies pure/state/helper behavior, not visible browser interactions. The frontend tooling rewrote the generated route tree during initialization; no intentional application source edit was made.

## Direct handoff reproduction

The pure handoff module can be imported using Node's TypeScript support without running a provider. From the audit checkout, run the following JavaScript using `node --input-type=module`:

```javascript
import { buildPriorTranscriptBootstrap } from "./apps/server/src/orchestration/handoff.ts";

const message = (id, text) => ({
  id,
  role: "assistant",
  text,
  streaming: false,
  source: "native",
});
const thread = {
  title: "Audit",
  branch: null,
  worktreePath: null,
  messages: [
    message("old", "OLD " + "a".repeat(1000)),
    message("new", "LATEST-DECISION: keep SQLite"),
  ],
};

for (const budget of [0, 1, 2, 700]) {
  const result = buildPriorTranscriptBootstrap(thread, undefined, budget);
  console.log({
    budget,
    length: result.text.length,
    includesLatest: result.text.includes("LATEST-DECISION"),
    omitted: result.omittedMessages,
  });
}
```

Observed:

| Budget | Output characters | Includes latest prior decision | Omitted messages |
| -----: | ----------------: | ------------------------------ | ---------------: |
|      0 |                 3 | No                             |                2 |
|      1 |                 3 | No                             |                2 |
|      2 |                 3 | No                             |                2 |
|    700 |               700 | No                             |                1 |

The current request is not included in this fixture; it is sent separately by the production composer. The confirmed loss is a **newer prior message**, not proof that the current user request is dropped. Production guards avoid calling this path for a zero allowance, but the helper itself violates that bound.

## Not performed

Full-repository lint/typecheck, all workspace tests, browser/Electron interaction tests, signed builds or release publication, real provider authentication and approvals, hardware performance measurements, Linux/macOS qualification, actual Clef/Ollama requests, or an exhaustive exploit-oriented security scan. No personal database was used to test migration compatibility. These remain delivery gates, not implied successes.
