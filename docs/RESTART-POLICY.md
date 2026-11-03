# Restart policy (VIB-002)

Reopening Vibeinator restores conversation state without automatically continuing coding work. Existing Resume controls and new user input authorize continuation. This extends the retained Synara lifecycle and delivery journal; there are no schema changes.

## Startup order

1. Attach runtime/checkpoint observers and ingest durable provider events. Already-journaled terminal results retain their actual outcome.
2. Settle orphaned turns and streaming messages, retire dead callbacks/background-task displays, pause active goals (including idle goals), and cancel persisted usage-limit recovery episodes.
3. Prune settled runtime replay state. Fence historical provider intents and hold restored queued promotions before starting provider-command delivery.
4. Start background reactors and admit fresh commands. Consume legacy quit-resume records without dispatching their continuation prompts.

Failure to persist a goal pause or cancel a restored usage-limit wait aborts provider startup. Existing best-effort stale-turn diagnostics remain intact. Unknown native acceptance and claim ownership retain the original delivery-reconciliation rules; restart does not turn uncertain execution into proof that nothing happened.

## Restored work

| State before shutdown                                     | State after startup                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Running turn or streaming assistant message               | Interrupted/finalized, with persisted text retained                                                                          |
| Active or idle goal                                       | Paused; explicit goal Resume retains the objective and existing continuation path                                            |
| Saved quit/crash continuation                             | No automatic turn; legacy record is consumed                                                                                 |
| Due or resuming usage-limit recovery                      | Cancelled as a restart continuation; the preference can still apply to new work started in this process                      |
| Unsent or explicitly retryable historical provider intent | Fenced/abandoned with existing durable delivery mechanisms; fresh input is handled normally                                  |
| Ambiguous/inflight native delivery                        | Existing ownership/uncertainty recovery, without blindly replaying a coding send                                             |
| Saved backend queue promotion                             | Prompt and promotion record retained; held until fresh input/resume in that thread                                           |
| Saved frontend composer queue                             | Hydrates paused, including a first prompt with no previous turn; prior resume acknowledgements do not authorize a new launch |
| Held Claude compaction/send response                      | Requires a fresh decision; startup does not send the parked message                                                          |

Same-process reactor repair keeps its existing replay behavior. The server boot path explicitly establishes the restart fence, so replacing an internal reactor is not confused with reopening the app. Independently scheduled automations are outside this conversation-restart policy.

The quit dialog no longer offers automatic resume. Restored composer queues show a neutral pause notice and reuse the existing Resume/Edit actions. Existing preference and record formats remain readable for compatibility.

## Verification

Verified on Windows on 3 November 2026:

- Formatting, lint (zero errors; 943 inherited warnings), all six package type checks, desktop build, and Windows runtime-boundary guard pass.
- Startup/lifecycle, runtime reconciliation, and usage-limit scheduling suites pass. The larger legacy quit-record group has 65 passes and one concurrent-claim failure, also reproduced in unchanged upstream (12/13 there).
- Last complete provider-command run: 640 passed, one existing edit-replay recovery timeout. A further focused run passes 21 restart/queue cases, including an added check that unknown native acceptance stays unresolved. The changed usage-limit expectation now tests cancellation on restart.
- Composer persistence, queue pause/drain, and quit helper units: 83 passed. Quit-dialog browser tests: three passed, including running-chat interrupt without any automatic-resume preparation.
- Native desktop startup smoke passes with disposable state; it does not qualify a live provider interrupted during coding. Live Codex/Claude and crash/recovery qualification remains tracked under VIB-001.

The full workspace suite is not claimed green. The baseline [main CI run](https://github.com/felixrydberg/Vibeinator/actions/runs/41659385419) already failed its Linux CUA host tests (114 failures), while its Windows lane passed. No baseline tests were silently skipped or weakened for this issue.
