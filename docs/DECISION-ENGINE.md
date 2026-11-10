# Decision-engine client

VIB-010 adds a lazy `DecisionEngine.decide(state, questions, { signal? })` service to the private desktop backend. It posts directly to the configured System One endpoint. It does not start Ollama, pull a model, poll health, or make ordinary chats wait for a decision model. Completed-turn classification is VIB-011; summary rewriting and refresh remain VIB-012/015. No settings controls or other renderer behavior change here.

## Configuration and credentials

The existing server settings contract accepts a `decisionEngine` patch:

```json
{
  "decisionEngine": {
    "enabled": true,
    "endpoint": "http://localhost:11434/v1/systemone",
    "model": "clef",
    "timeoutMs": 5000
  }
}
```

These defaults decode for existing installations without a database migration. Configuration uses the retained settings persistence and authenticated `server.updateSettings` operation. The client resolves current settings when called; construction performs no model request. There are no changes to coding-provider selections.

An optional `decisionEngine.credential` patch writes a Bearer credential through `ServerSecretStore`. It is write-only; settings snapshots, change streams, and `settings.json` contain only the derived `credentialConfigured` flag. Use `null` or an empty string to clear it. Do not put credentials in endpoint URLs or model state. The private secret record binds the credential to the endpoint origin: changing host, scheme or port cannot send the previous credential to that destination. A new origin requires an explicit credential update. Failed settings commits use the retained secret rollback path.

Endpoints allow HTTPS or HTTP on exact loopback hosts. The existing outbound HTTP policy pins DNS, restricts hosted destinations to public addresses, and allows plain HTTP only on loopback. URLs with credentials, query strings or fragments are rejected. Redirects are not followed. Hosted endpoints receive data only when explicitly configured and called.

## Protocol and bounds

The request carries `model`, JSON `state`, and named `questions`. Initially, each question has `type: "choice"`, `instructions`, and a `criteria` object mapping allowed labels to descriptions or null. There are 1–64 questions and 2–26 choices per question. Names are at most 100 ASCII letters, digits, dots, underscores or hyphens; prototype-sensitive names are rejected.

The client validates the returned named `answers`, answer types, allowed labels, complete probability maps, finite probabilities/confidence in [0, 1], approximately normalized probability totals, and selection of a maximum-probability label. Missing/extra answers or invented choices invalidate the result. Exact ties or confidence below 0.5 produce an uncertain fallback. This is a conservative concentration threshold, not a correctness guarantee; downstream retention policy must not treat a structurally valid answer as proof that information is unimportant.

| Boundary                          | Limit                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Serialized request / response     | 256 KiB / 128 KiB, enforced before send and while reading                                          |
| Input JSON                        | Depth 16, 10,000 nodes; finite plain JSON only                                                     |
| Response JSON                     | Depth 8, 5,000 nodes                                                                               |
| Instructions / option description | 4,000 characters each, within the total request allowance                                          |
| Network deadline                  | 5 seconds by default, configurable from 100 ms to 120 seconds; includes queueing and response body |
| Admission                         | One active request, up to four queued; no automatic retries                                        |

The transport reuses `@synara/shared/outboundHttp`; no second fetch/streaming/redirect implementation is introduced. Caller AbortSignal cancellation yields a typed cancelled fallback. Native Effect interruption propagates and aborts the transport. No source content, raw response, endpoint credential or transport exception cause is logged or returned.

## Results and authority

A valid response returns `{ status: "decided", answers }`, containing only validated label/probability data. Disabled, invalid-request, configuration, credential, unavailable, unauthorized, timeout, cancelled, invalid-response and uncertain cases return `{ status: "fallback", reason, retainInformation: true }`. No fallback invents a selected label; pending information stays retained.

The service executes no tools, generates no operation arguments, grants no permissions, changes no goals and writes no conversation history. The [retention classifier](RETENTION-CLASSIFICATION.md) uses its advisory outputs to store bounded source candidates, separate from authoritative application admission and provider approvals.

## Verification and live qualification

The HTTP fixture uses the documented choice envelope from the [official Clef model page](https://ollama.com/library/clef). The [Ollama decision guide](https://docs.ollama.com/capabilities/decision) documents the same named-question endpoint and confidence semantics. This verifies client compatibility with documented wire shapes, not an installed model's behavior.

Loopback HTTP tests exercise bounded responses, malformed/unknown choices, outages, deadlines, redirects, origin-bound credentials and actual connection cancellation. Settings tests exercise real secret persistence, snapshot/change-stream privacy, reload and rollback after a failed settings-file commit. Windows CI runs these checks and the affected embedded settings transport tests.

Live qualification must record the installed Ollama/server version, available Clef model, actual valid/invalid responses and cancellation behavior. Clef requires Ollama 0.35.1 or later according to its model page. Do not infer a live pass from documentation, fixtures or the presence of an executable. No model download, server startup or hosted inference is part of this change.
