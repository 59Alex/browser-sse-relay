# browser-sse-relay

A planned TypeScript client and reference server contract for recovering Server-Sent Events after connection loss.

**Status: design and implementation planning. No installable release is available yet.**

## Problem

Reconnecting an HTTP connection does not recover events emitted while a client was offline. Reliable recovery needs a retained server history, a cursor contract, a replay-to-live handoff and an explicit response when history is unavailable.

## Planned scope

- Framework-independent browser client with reconnect state and cancellation.
- Resume from the last successfully processed event cursor.
- Bounded duplicate tracking and event-size/queue limits.
- Explicit resynchronization when retention gaps or slow consumers prevent replay.
- A reference server and failure demo exercising replay/live races.

The browser client cannot recreate events that a server did not retain. Ordering and deduplication depend on the documented server protocol; arbitrary SSE IDs are opaque strings. Exactly-once delivery is not promised.

## Implementation

See [the v0.1 plan](ROADMAP.md) and [open issues](https://github.com/59Alex/browser-sse-relay/issues).
The npm client is the initial artifact; a reusable Java/WebFlux server module will be considered after the reference protocol is validated.

## References

- [WHATWG Server-Sent Events specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [fetch-event-source](https://github.com/Azure/fetch-event-source), an existing fetch-based SSE client

## License

[MIT](LICENSE).
