# Desktop baseline adoption

VIB-001 is in progress. The source adoption, workspace layout, isolated identity, Windows build and local installer are implemented. Full provider/recovery qualification is still open; this is not a signed or published release.

## Delivered scope

- Adopt Synara commit `3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4`, preserving the original local commit, upstream ancestry, MIT license, copyright notices, patches and product planning documents.
- Ship only the Electron desktop. Preserve the renderer, backend, contracts, shared utilities and scripts as private Bun workspace packages. Keep `@synara/*` internal imports; omit the standalone marketing site and upstream publishing workflows.
- Make `dev`, `build`, `start` and `package:desktop` desktop commands. Use Vibeinator app/protocol/bundle/installer identities, isolated Electron profiles and `VIBEINATOR_HOME` with `.vibeinator`/`.vibeinator-dev` defaults. Synara's home variable is ignored.
- Default packaged updates to no feed, ignore inherited Synara/GitHub publishing destinations, and disable the parallel Beta download/launch/import entry points. Preserve implementation/artwork where it is not part of identity isolation.
- Shorten packaging stage names to keep native MSBuild tracking files below Windows path limits. Keep formatters and Git checkouts on LF. Add desktop verification CI with full Linux units and explicit Windows boundaries; remaining Windows suite portability work stays visible here.

## Verification on 3 November 2026

| Check                                                                                | Result                                                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Pinned Bun 1.4.4 dependency installation and compiler patching                       | Passed; seven workspace manifests, six runnable package checks                                            |
| `bun run fmt:check`                                                                  | Passed                                                                                                    |
| `bun run lint`                                                                       | Passed: zero errors, 943 inherited warnings; server synchronous-filesystem budget passed                  |
| `bun run typecheck`                                                                  | Passed across all six packages                                                                            |
| `bun run build`                                                                      | Passed: desktop, backend and renderer dependency graph; approximately three minutes locally               |
| Isolated `bun run dev --home-dir ./.vibeinator/baseline-smoke --dry-run`             | Passed; selected backend 3773 and renderer 5733 without starting either                                   |
| `bun run test:desktop-smoke`                                                         | Passed with disposable backend and Electron profiles; app closed afterward                                |
| Identity/home/feature-gate units                                                     | 38 passed                                                                                                 |
| Artifact identity, publication policy, macOS config portability and dev runner units | 41 passed                                                                                                 |
| Localization token guard and packaged-startup helper units                           | 17 and 5 passed                                                                                           |
| Affected desktop channel, launch, permission and static-protocol units               | 119 passed                                                                                                |
| Renderer locale-gate units after fixture updates                                     | 14 passed                                                                                                 |
| Contract package                                                                     | 204 passed                                                                                                |
| Backend home/provider-environment fixtures                                           | 124 passed, 18 failed; all 18 failures also reproduced in unchanged upstream on Windows                   |
| `bun run windows-runtime:check`                                                      | Passed: 318 application sources, 121 boundary files, four patches, seven manifests                        |
| `bun run migrations:check`                                                           | Passed against 103 fetched shared release tags; no migration changes                                      |
| `bun run dist:desktop:win --skip-build --keep-stage`                                 | Passed after the short-stage fix; produced unsigned `release/Vibeinator-1.1.0-x64.exe`, 260,093,155 bytes |
| Extracted NSIS payload runtime-dependency and desktop-startup smoke                  | Passed in disposable state, without installing the app                                                    |

The local installer was built from the adoption working tree before the adoption commit was recorded, and embeds the original local HEAD as its source metadata. It is a local qualification artifact, not a reproducible release for a claimed commit. Future committed builds obtain their own source metadata normally. No release was uploaded, installer executed, update feed enabled, or personal provider conversation used for testing.

The retained brand guard also passes after removing the excluded marketing site's screenshot from its required assets; all 12 guard unit tests pass.

## Remaining acceptance and known failures

The full Windows workspace suite is not green. The broad run was bounded at 11 minutes 22 seconds after an inherited `CheckpointReactor` integration fixture stopped making progress. Completed suites and narrower reproductions were retained in ignored `.tmp` logs. A stopped run is not a passing suite.

The unchanged upstream desktop suite reproduced 212 failures on this host, including Unix socket, POSIX path/mode and platform-specific fixtures. The initial adopted run had 214 failures; new home/protocol/icon fixture mismatches were corrected and the affected desktop tests rerun successfully. Broad concurrent runs also showed timing-sensitive differences, so these totals are observations, not a zero-regression proof.

The unchanged upstream shared/scripts suites reproduced the login-shell path assertion and ten remaining build-tool fixture failures. Two inherited macOS path assertions were fixed to use the host path separator. The upstream renderer timestamp/profile formatting subset reproduced the same six failures as the adopted subset; the adopted locale-gate tests now pass. A process-priority assertion failed under the broad concurrent load but passed in the smaller upstream run; it remains unqualified.

`ProviderCommandReactor.test.ts` still reports the previously audited edit-replay snapshot timeout. The broad run also reported a `ProviderService` timeout before the later checkpoint stall. These require diagnosis in the VIB-001 qualification follow-up; no tests were silently skipped or changed to accept those failures.

Next acceptance work is live disposable Codex and Claude streaming, approve/deny/interrupt, restart/recovery evidence, and the remaining Windows fixture/runtime distinctions. Linux/macOS runtime behavior, signed installers, auto-update feeds, migration of user data and the new storage/handoff design have not been qualified or implemented in this adoption slice.

## Review and delivery

The [implementation tracker](IMPLEMENTATION-TRACKER.md) links the twenty steps and their dependencies. [Adoption PR #21](https://github.com/felixrydberg/Vibeinator/pull/21) is merged into `main`; VIB-001 stays open for its remaining qualification checks. Subsequent changes get separate branches and PRs, merged in dependency order when complete.
