# Bounded handoff packet preparation

VIB-013 adds pure, deterministic handoff preparation over the retained summary/history contracts. It also fixes the existing bootstrap selector: newer messages are selected before chronological rendering, so an older long excerpt cannot crowd out the newest decision. Packet persistence, target-session binding and live dispatch integration remain VIB-014.

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

The packet SHA-256 covers canonical JSON of the final prepared record, excluding its own hash field. It includes selected context, the exact request, identities, watermarks, summary/objective references, limits and omission metadata. No clock, random ID or locale ordering enters preparation. The hash identifies content, not authorization. External prompt bytes are not supplied to this pure function; VIB-014 must persist the final provider input, including those additions, alongside target-session identity and delivery outcome.

## Verification

The audit's 700-character newest-decision regression and all three tiny-budget assertions failed against the merged helper before repair. The repaired handoff, packet and handoff-admission suites pass 31 cases; the focused reactor handoff/recovery/bootstrap sweep passes 26 cases. Tests cover exact requests, chronological newest-first selection, rendered and escaped budgets, Unicode boundaries, empty/stale summaries, source immutability, foreign/future inputs, deterministic hashes and exported packet bounds. These checks are in Windows CI.

No database migration, UI surface, provider/model choice or automatic summary writer is added here. Existing fork operations remain independent. Signed-installer and live-provider handoff qualification remain VIB-019; Linux CI remains deferred by project decision.
