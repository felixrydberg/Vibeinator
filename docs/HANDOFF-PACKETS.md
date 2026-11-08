# Bounded handoff packet preparation

VIB-013 adds pure, deterministic handoff preparation over the retained summary/history contracts. VIB-014 uses it in same-conversation handoff and missing-native-history recovery, committing the final application dispatch before entering the provider adapter. The existing bootstrap selector also selects newer messages before chronological rendering, so an older long excerpt cannot crowd out the newest decision.

## Inputs and results

`buildHandoffPacket` receives project/thread identity, a source watermark, selected project/chat summary revisions with explicit refresh status, objective/status, settled prior user/assistant messages in authoritative chronological order, the count of earlier messages outside that candidate window, the exact current request, the actual send allowance, external prompt reservations and the count of unsummarized sources. It performs no database access, provider calls, tool execution or filesystem reads. The caller must resolve authorized, settled source data; the builder rejects foreign thread/summary scope, future summary watermarks, duplicate message IDs and invalid numeric budgets. A bounded snapshot loader can therefore report complete omission counts without hydrating the whole transcript.

| Priority | Content                                                                           | Bound                                                                                                |
| -------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1        | Exact current request and retained provider framing                               | Never shortened; insufficient allowance blocks preparation                                           |
| 2        | Source watermark, refresh/omission metadata and working history-tool instructions | Rendered before allocation; insufficient metadata allowance blocks preparation                       |
| 3        | Newest prior user/assistant messages, rendered oldest first                       | At most 12 messages and 24,000 UTF-16 characters of excerpt text                                     |
| 4        | Objective text, then chat and project summary text                                | Objective and each summary capped at 8,000 characters, further reduced by actual remaining allowance |

Excerpts preserve source prefixes with a bounded truncation marker. Packet records retain message IDs, original/retained character counts, summary revision IDs and processed watermarks, objective revision ID when available, effective limits and omission counts. Complete source history is never edited. Partial or omitted content remains retrievable through `synara_search_history` and `synara_read_history_source`; their actual names and required source fields appear in the context.

Current, empty, stale, failed, unavailable and not-requested summary states are explicit. A retained last-known summary can still be included when refresh is stale or failed, with that state recorded rather than claiming freshness. A caller-provided unsummarized-source count identifies pending coverage without inventing counts from gaps in global sequences.

## Actual send allowance

`reservedChars` must include provider prompts, other send-time additions and safety allowance that sit outside this prepared text. The existing reactor's framing and available-context calculation are extracted into `providerContext.ts` and reused unchanged. A ready packet satisfies `dispatchText.length + reservedChars <= maxInputChars`; accounting includes tags, labels, separators, JSON quoting/escaping and metadata. The 24,000/8,000 character defaults do not imply that a fixed 40,000-character bootstrap always fits.

If the complete current request or minimum reference metadata cannot fit, the result is `insufficient-budget` with a typed reason, empty `contextText`, null `dispatchText` and the original request intact. This handles allowances of 0, 1 and 2 without silently sending a clipped request. The retained legacy text helpers also obey these tiny limits.

All limits count JavaScript UTF-16 code units, matching the retained send contracts. Excerpt boundaries never split an existing surrogate pair. Quoted source text escapes context delimiters and remains untrusted reference data; it cannot grant execution, approval or filesystem authority. Existing approval boundaries are unchanged.

## Determinism and ownership

Prepared-packet schemas live in `packages/contracts`. Server-side selection/preparation lives under `apps/server/src/orchestration`; canonical JSON and Unicode boundary handling reuse existing shared utilities. No comparable durable packet builder existed. The new selector is shared by the existing bootstrap helpers and the new builder; provider framing is shared with the reactor rather than copied.

The preparation SHA-256 covers canonical JSON of the prepared record, excluding its own hash field. It includes selected context, the exact request, identities, watermarks, summary/objective references, limits and omission metadata. No clock, random ID or locale ordering enters preparation. The hash identifies content, not authorization. External prompt bytes are not supplied to this pure function; the dispatch payload has its own SHA-256 over its exact stored UTF-8 JSON bytes.

## Durable dispatch and recovery

Migration 146 adds packet, start-attempt, turn-receipt and append-only outcome tables. Packet preparation, exact assembled context, final routed application input and an initial `uncertain` outcome commit in one transaction before the adapter receives input. The final input includes project/mention/completion context, skill and goal/debug prompts, attachment metadata and existing provider normalization. Ephemeral server-only attachment path markers and adapter-native wire encodings are not part of the serializable application input. Stored input is evidence, never a replay queue.

Packets bind the app project/conversation, source command/delivery attempt, actual routed provider instance/model and service lifecycle generation. `target.runtimeSessionId` is the logical service runtime identity (`service:<generation>`), distinct from adapter-native session/capture IDs. Unknown native session IDs remain null. Same-thread Codex → Claude → Codex switches retain the conversation and create fresh native sessions. A normal turn with native history sends only new input. Deliberate new-thread forks, sidechats, native review and native `/compact` keep their existing independent paths.

After packet commit, recording readiness and the routed lifecycle generation are checked again before adapter dispatch. Stop or replacement during persistence rejects that prepared attempt and retains its failure evidence. The regression fails for both Codex and Claude without this guard; it exercises real storage and lifecycle services with synthetic adapters.

The reactor reads project/chat summary heads and source allocation fences in one SQL transaction, then uses settled messages before the current request. Without automatic refresh, retained summaries are conservatively marked stale and absent summaries unavailable. The uncovered-source count counts actual chat events/captures beyond the chat summary watermark, rather than sequence gaps. Existing objective/status text is included with a null revision ID until objective revisions are implemented. Reservations include outer prompts, portable skills, AppSnap labels and the existing safety margin.

| Boundary                                     | Durable evidence and behavior                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before source stop / target start            | A start-attempt record names source, target and event; uncertainty commits before native work. Successful startup records `started`; proven rejection records `failed`. No request or final packet is invented before a user sends.                                      |
| Before adapter send                          | Immutable packet and exact dispatch payload commit together. Storage failure stops dispatch.                                                                                                                                                                             |
| Codex acknowledgement                        | Its existing turn/start result appends `accepted`.                                                                                                                                                                                                                       |
| Other adapters enqueue or launch             | A turn receipt is retained, but acceptance remains uncertain until a matching successful terminal is journaled. Thread, turn, instance, provider and generation must match.                                                                                              |
| Early terminal                               | SQL triggers handle either event/receipt ordering. Acceptance survives runtime-journal retention.                                                                                                                                                                        |
| Rejected send                                | Existing typed validation/session rejection or proven startup failure appends `failed`; ambiguous errors retain uncertainty.                                                                                                                                             |
| Lost send/outcome acknowledgement or restart | The existing delivery journal and paused-restart policy quarantine external uncertainty. Packet persistence never authorizes automatic tool replay or resending saved input. Explicit accepted reconciliation appends acceptance to the latest packet for that delivery. |

Start failures retain the existing source-selection restoration and recovery bootstrap. Active-turn, saved-send, background-task and approval gates remain authoritative. A failure recording an outcome after native work is not a safe automatic retry. Explicit thread purge removes project-wide derived packet copies and their payload/search records because a project summary may have carried that chat's facts into another packet; unrelated native source history is retained.

`HandoffStore.get` returns immutable scoped packet/preparation records and outcomes, and the archive reads the exact dispatch payload. UI exposure is tracked in VIB-016; the inherited switch-time disclosure is not the authoritative dispatch record.

## Verification

The audit's 700-character newest-decision regression and all three tiny-budget assertions failed against the merged helper before repair. The repaired handoff, packet and handoff-admission suites pass 31 cases; the focused reactor handoff/recovery/bootstrap sweep passes 26 cases. Tests cover exact requests, chronological newest-first selection, rendered and escaped budgets, Unicode boundaries, empty/stale summaries, source immutability, foreign/future inputs, deterministic hashes and exported packet bounds. These checks are in Windows CI.

VIB-014 adds storage/reopen, exact final-byte, terminal-ordering, scope, transaction rollback, explicit-purge, provider admission and same-conversation round-trip checks to Windows CI. These use real SQL/service boundaries with synthetic provider adapters. Live CLI permission/cleanup and signed-installer qualification remain VIB-019; Linux CI remains deferred by project decision. No provider/model preference or automatic summary writer is changed.
