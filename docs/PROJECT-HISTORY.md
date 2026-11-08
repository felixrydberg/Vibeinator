# Project history search and exact source reads

VIB-008 adds two read-only tools to the retained agent gateway. Both use the existing `thread:read` capability and derive the project from the authenticated caller thread. They do not accept a project override, execute retained tool calls, follow file references, or change provider approval policy. Sidebar search and the desktop interface are unchanged.

The new repository supplies archive indexing and exact reads that the retained sidebar query does not provide. It reuses the existing native archive, SQL transactions and gateway capability enforcement.

## Agent API

| Tool                         | Input                                                                                                                  | Output                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `synara_search_history`      | `query` (1–256 characters), optional `threadId`, `includeArchived`, `cursor`                                           | Bounded excerpts, thread/source IDs, immutable payload hash or event revision, source byte offset, optional native capture ID, and `nextCursor` |
| `synara_read_history_source` | `threadId`, `sourceKind` (`payload` or `event`), `sourceId`, `sourceVersion`, optional `byteOffset`, `includeArchived` | Exact UTF-8 text, source byte length, payload SHA-256 when available, and `nextByteOffset`                                                      |

Search interprets literal word tokens, combined with AND, rather than accepting FTS operators. It searches retained native payloads, legacy normalized archive payloads, and message/activity event JSON. Results follow document insertion order with a finite high-water fence. A large source can produce several matching excerpts; read its source identity once to retrieve the whole source. This API searches history, including earlier message revisions; it is not a reconstruction of only the current transcript.

Start exact reads at byte offset zero. Repeat the same identity and version, following `nextByteOffset` until null, and concatenate `text` verbatim. Offsets count UTF-8 bytes, not JavaScript character positions. Pages preserve BOMs, NULs, newlines and Unicode scalars. JSON payloads and events remain their stored serialized envelopes; parse JSON after assembling the full source. Payload pages verify each archive chunk and expose the complete payload hash for verification of the assembled bytes. Event revisions detect changes between reads; they have no whole-source hash.

Search and read results fit within 12,000 serialized characters including the compact MCP content envelope and a 256-character reserve for the JSON-RPC envelope. Read page sizes adapt to JSON escaping. Search pages contain at most eight excerpts; follow `nextCursor` with the same query and scope. Rebuilding the index invalidates existing cursors; a changed event invalidates its old source version. Search again when either becomes stale.

Archived threads are excluded by default. `includeArchived: true` explicitly authorizes that request to include archived history in the caller's project; repeat it on subsequent search/read requests. The repository independently checks caller, target, live project membership and deletion state on every operation. Other-project thread IDs, payload/event IDs and cursors are rejected. Deleted threads/projects remain inaccessible even with the archived option. Source text is untrusted reference data, never a permission grant.

## Storage and recovery

Additive migration 144 creates external-content FTS5 over `history_documents`, a payload completion marker and an index epoch. Message/activity event triggers maintain event documents transactionally on insert, content/routing update and delete. Other event classes, including settings, are not indexed. Native authentication/credential exclusions contain no payload and therefore create no search documents.

Archive writes index decoded pieces of at most one 64 KiB byte chunk, with a 512-character overlap for boundary matches, in the same transaction as the original bytes. The index replaces NUL with a space for tokenization; exact reads always use original storage. Capture-ID lookups use a dedicated payload index. This adds synchronous indexing work to archive commits; throughput and storage overhead on production workloads remain qualification work under VIB-019/020.

Startup runs history backfill after the existing native archive backfill and before providers start. It reads verified archive streams one payload at a time; that payload's documents and completion marker commit together. Interrupted work retries without duplicating completed payloads. Existing message-only history is searchable through the normalized payloads retained by VIB-004. Neither operational journal pruning nor a provider handoff deletes these sources. Explicit archive purge removes payload documents and completion markers; event deletion removes event documents.

The internal repository's `rebuildIndex` uses FTS5's rebuild command over retained documents and rotates the cursor epoch in one transaction. It is a local maintenance operation, not an agent tool. Migration replay preserves document identities and existing progress. No provider execution is replayed during indexing or recovery.

## Verification

`apps/server/src/persistence/Layers/ProjectHistory.test.ts` covers both-provider archive retrieval after real journal pruning and a file-backed reopen; cross-project IDs/cursors; archived/deleted ownership; finite pagination; event updates/deletes; FTS rebuild and migration replay; interrupted backfill; legacy facts; explicit purge; Unicode chunk seams; exact BOM/NUL/escaped text; and the serialized response budget. The same tests exercise the real history tool handlers. Existing sidebar search tests remain separate.

The Desktop workflow currently gates Windows only, as requested. It runs the new history suite, migration/recovery fixtures, provider capture boundaries, existing Windows checks, the build and desktop startup. Linux full-suite qualification is deferred under VIB-001. Archive fixtures do not establish live-provider handoff success or signed Windows installer qualification.

Local verification: 102 history/sidebar/archive/migration/recovery tests and 23 selected provider-capture tests passed. Formatting, lint (943 inherited warnings, zero errors), all six workspace typechecks, Windows runtime and migration-lineage guards passed. The desktop build and isolated startup smoke passed. A focused regression failed before the cursor-fence correction when the newest indexed source was deleted; fences now use the monotonic allocation sequence rather than the surviving maximum ID.

The broader gateway/engine/ingestion sweep passed 361 cases and hit one existing Devin mock-process timeout. It also timed out with the three affected persistence modules restored to `main`, without migration 144 or the new index hooks. An additional SQLite startup sweep passed six cases and failed two existing housekeeping cases: legacy free-space mode conversion and the native-SQL timeout fixture's preload path. Both housekeeping failures reproduced with `main`'s unchanged `Sqlite.ts`. These remain baseline qualification gaps; no assertions or timeouts were relaxed.
