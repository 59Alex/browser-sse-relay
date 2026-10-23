# Implementation plan

Deliver recoverable SSE semantics with a runnable failure demo.

Source implementation 0.1.0 is locally tested. Checked items describe implemented and locally verified behavior, not npm publication. [Verification record](docs/VERIFICATION.md).

## 1. Protocol

- [x] Define stream identity, cursor scope, retention and ordering.
- [x] Treat opaque IDs as opaque; any monotonic comparison must belong to a specific server adapter.
- [x] Define commit-after-handler-success behavior, idempotent handlers and failures during checkpoint persistence.
- [x] Specify reset/resync signaling, authentication failures and bounded retry policy.
- [x] Define maximum event size, client/server queue limits and slow-consumer recovery.

## 2. Browser core

- [x] Evaluate an existing parser/transport before implementing a new one.
- [x] Handle fragmented UTF-8 and SSE frames, multiline data, comments, CR/LF and retry fields.
- [x] Implement connect/reconnect/replay/live/resync/closed states with AbortSignal.
- [x] Persist cursors through an optional account-scoped adapter.
- [x] Prevent old sessions and pending reconnects from delivering after logout.
- [x] Bound deduplication history; document the duplicate window and handler requirements.

## 3. Reference relay

- [x] Provide a retained event store and deterministic replay/live boundary.
- [x] Capture a replay watermark while live events are safely observed; merge without loss under the declared protocol.
- [x] Demonstrate reconnect to another HTTP listener using one shared in-memory store in one process.
- [x] Report expired cursors and queue overflow as explicit resync requirements.
- [x] Separate transport success from application processing acknowledgment.

## 4. Verification and release

- [x] Drop connections before/after delivery and before/after handler/checkpoint completion.
- [x] Publish events during replay/live switching; verify ordered observable delivery and documented duplicate behavior.
- [x] Cover concurrent publishers, retention expiry, slow handlers, token refresh and logout.
- [x] Test malformed/oversized frames, aborted retries and bounded memory.
- [x] Run real-browser tests against the reference relay; record supported browsers.
- [x] Provide a standalone failure demo and a documented comparison with EventSource/fetch-event-source.
- [x] Verify tarball contents, public exports, declarations and clean-consumer install.
- [ ] Verify npm authentication and ownership of the provisional package name, then publish to npm.
- [x] Write English/Russian README files and versioned Markdown guides, changelog and CI configuration.
- [ ] Complete an actual production application integration.
- [ ] Release v0.1 after publication and integration gates pass.

A Java/WebFlux library is a later deliverable only if the reference implementation proves a stable reusable boundary.
