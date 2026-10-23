# Recovery protocol v1

[← Back to documentation and versions / Назад к документации и версиям](index.md)

## Scope and ordering

A stream is identified by the pair `{ accountId, streamId }`. Cursors are opaque, nonempty printable-ASCII strings (1..1024 characters, no spaces) and valid only for that pair. The server authenticates the account; a request cannot select another account by a query parameter. The client verifies the server's scope before invoking application handlers. A cursor is not an authorization credential.

Within a scope the retained log defines a total order. Every application event has a unique cursor, an event type, and a string payload. Reserved event types begin with `relay-`. The client never compares cursors numerically or lexicographically. It resumes using `Last-Event-ID` after the last committed application event.

A request without a cursor means replay from the log's origin. If the origin is no longer covered by retention, the server requires resynchronization; it must not silently start at the newest event. Applications with an existing snapshot may supply that snapshot's cursor explicitly. Producing a consistent snapshot and cursor is the application's responsibility.

## HTTP and frames

The reference endpoint uses GET, `Accept: text/event-stream`, and optional `Last-Event-ID`. Successful responses have `Content-Type: text/event-stream` and `X-Relay-Protocol: 1`.

1. `event: relay-hello` announces JSON `{ protocol: 1, scope, after, watermark }` before any application event. No SSE id is attached.
2. Application frames include their own nonempty `id`, `event`, and `data`. They are replayed in log order up to the captured watermark.
3. `event: relay-ready` announces JSON `{ scope, watermark }`. It follows every replay event and precedes every live event after that watermark. Once the watermark is reached, another application frame before ready is a protocol error and is not delivered. It has no id and is not an application checkpoint.
4. Live application frames continue in log order. Comments may keep the connection alive. SSE retry fields are accepted as bounded reconnect hints.
5. `event: relay-resync` with JSON `{ reason }` ends the session when history or queue capacity cannot sustain recovery.

HTTP 409 or 410 requires resynchronization. HTTP 401 may invoke a configured token-refresh callback once per request before a bounded retry; 403 stops as an authentication failure. HTTP 204 stops cleanly. Network failures, 408, 429, and 5xx responses consume the configured retry budget. Other unsuccessful statuses and invalid protocol responses fail closed.

## Commit boundary

For each application event, the client awaits the handler and then awaits checkpoint persistence. Only after both succeed does it update its committed cursor and bounded duplicate set. Handler or checkpoint failures close the current connection and retry from the prior committed cursor. Therefore a side effect can occur twice when it succeeds but checkpointing fails, or when the process stops between those actions. Handlers must be idempotent or transactionally deduplicate effects using the event cursor and scope.

This is at-least-once processing within the retained history, retry budget, and caller's successful recovery policy. It does not guarantee exactly-once effects or infinite eventual delivery. Once retention is exhausted, the only safe action is an application snapshot/resync.

The duplicate cache covers only successfully committed IDs in the current session, is bounded, and is not durable. It cannot replace application idempotency. A previously committed duplicate is skipped without moving the cursor backwards.

## Session lifecycle

The one-shot client moves through idle → connecting → replaying → live. Failures can move it to waiting or authenticating before another connection. Resync, failed, and closed are terminal. A fresh client instance starts a new session.

HTTP-header waits default to 10 seconds and byte-idle waits to 45 seconds; comments/heartbeats reset the byte-idle timer. EOF stops the byte-idle timer while already-received events finish processing. Timer settings must be integers no greater than 2,147,483,647 ms; zero is permitted only for reconnect delays. Timeouts consume the finite connection-attempt budget. This budget counts total connections in one session and does not reset after success.

Stop aborts fetch and pending timers. No later application handler is started; an already-running handler receives an aborted signal and must stop its own external work. Logout waits for the in-flight operation to settle before clearing the scoped checkpoint. Custom checkpoint adapters must honor AbortSignal before committing and settle their promises; cancellation cannot undo an external write already committed by an uncooperative adapter.

Checkpoint adapters are single-writer per scope: await logout before reusing that scope, and coordinate tabs externally. No adapter offers cross-tab leases. A persisted cursor does not restore application state: load matching durable state or install a consistent snapshot before resuming a page whose in-memory state was reset.

All async boundaries recheck the session signal before starting handlers or saving checkpoints. A stale session cannot continue draining queued events after stop/logout. Authentication headers are rebuilt for every request. Redirects are rejected so credentials are not silently forwarded to another endpoint.

## Replay/live handoff and reference limits

The reference MemoryEventStore opens a subscription synchronously: it prunes retention, validates the cursor, captures the current watermark, registers a bounded subscriber queue, and enqueues hello/replay/ready without yielding the JavaScript event loop. Subsequent appends enqueue only events after that watermark. This is the linearization point; there is no gap between separately querying history and observing live events.

Two Node relay instances can share the same MemoryEventStore object. This demonstrates relay failover and handoff semantics in one process. It is not distributed persistence, cross-process consensus, or durability across restart. A production retained-log adapter must preserve the same atomic subscribe/replay boundary and per-scope ordering.

Retention is bounded by event count, age, total retained bytes, and number of scopes. Subscriber count, queued events/bytes, event size, and socket-drain wait are also bounded. A subscription that cannot replay or keep up reports resync. Explicit subscription close discards unread frames and releases queue accounting, while retained history remains available. Heartbeats pass through the same bounded socket-drain loop as application frames. When overflow occurs on a blocked socket the relay destroys it instead of appending an undeliverable control. If the network is already broken, a control frame may not arrive; reconnect still resumes from the committed cursor and revalidates retention.

Client limits cover raw frame size, parsed queue count and UTF-8 bytes (data, id, and event type), and duplicate history. One active handler frame and one bounded parser frame are additional to queued frames. Browser/OS fetch buffering and application-owned payload copies are outside the library's accounting. Oversized frames and queue overflow stop with an explicit resync result instead of dropping an event silently.

[← Back to documentation and versions / Назад к документации и версиям](index.md)
