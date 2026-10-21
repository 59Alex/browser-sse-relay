# Implementation plan

Deliver recoverable SSE semantics with a runnable failure demo.

## 1. Protocol

- [ ] Define stream identity, cursor scope, retention and ordering.
- [ ] Treat opaque IDs as opaque; any monotonic comparison must belong to a specific server adapter.
- [ ] Define commit-after-handler-success behavior, idempotent handlers and failures during checkpoint persistence.
- [ ] Specify reset/resync signaling, authentication failures and bounded retry policy.
- [ ] Define maximum event size, client/server queue limits and slow-consumer recovery.

## 2. Browser core

- [ ] Evaluate an existing parser/transport before implementing a new one.
- [ ] Handle fragmented UTF-8 and SSE frames, multiline data, comments, CR/LF and retry fields.
- [ ] Implement connect/reconnect/replay/live/resync/closed states with AbortSignal.
- [ ] Persist cursors through an optional account-scoped adapter.
- [ ] Prevent old sessions and pending reconnects from delivering after logout.
- [ ] Bound deduplication history; document the duplicate window and handler requirements.

## 3. Reference relay

- [ ] Provide a retained event store and deterministic replay/live boundary.
- [ ] Capture a replay watermark while live events are safely observed; merge without loss under the declared protocol.
- [ ] Demonstrate reconnect to another replica using shared history.
- [ ] Report expired cursors and queue overflow as explicit resync requirements.
- [ ] Separate transport success from application processing acknowledgment.

## 4. Verification and release

- [ ] Drop connections before/after delivery and before/after handler/checkpoint completion.
- [ ] Publish events during replay/live switching; verify ordered observable delivery and documented duplicate behavior.
- [ ] Cover concurrent publishers, retention expiry, slow handlers, token refresh and logout.
- [ ] Test malformed/oversized frames, aborted retries and bounded memory.
- [ ] Run real-browser tests against the reference relay; record supported browsers.
- [ ] Publish a standalone failure demo and comparison with EventSource/fetch-event-source.
- [ ] Verify npm coordinates, package contents and clean-consumer install.
- [ ] Release v0.1 with English docs, changelog and an actual application integration.

A Java/WebFlux library is a later deliverable only if the reference implementation proves a stable reusable boundary.
