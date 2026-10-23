# browser-sse-relay

[English](README.md) · [Русский](README.ru.md) · Version: [0.1.0 guide](docs/v0.1.0/guide.en.md) · [All documentation](docs/README.md)

Recover an SSE stream from the last event your application successfully handled and checkpointed. Includes an independent TypeScript browser client and a Node reference relay with bounded retained history.

**v0.1.0 implementation is available in source. npm publication and a production application integration are not completed.**

## Capabilities

| Capability | Behavior and example |
|---|---|
| Awaited application processing | Handler → checkpoint → committed cursor. A failed checkpoint can repeat an effect. [Example](docs/v0.1.0/guide.en.md#process-and-checkpoint) |
| Replay and relay failover | Resume opaque account/stream-scoped cursors; verify the replay/live boundary. [Example](docs/v0.1.0/guide.en.md#reference-relay-and-handoff) |
| Retry and authentication | Bounded attempts, jitter, retry hints, header/idle timeouts, fresh headers, optional 401 token refresh. [Example](docs/v0.1.0/guide.en.md#retry-and-authentication) |
| Cancellation and logout | Abort transport/timers; prevent future handlers; await in-flight work before clearing the account cursor. [Example](docs/v0.1.0/guide.en.md#stop-and-logout) |
| Explicit resynchronization | Expired history and queue overflow stop with resync; resume from a matching application snapshot and cursor. [Example](docs/v0.1.0/guide.en.md#snapshot-after-resync) |
| Bounded resources | Frame bytes, queue count/bytes, duplicate window, retained history, scopes and subscribers all have limits. [Example](docs/v0.1.0/guide.en.md#limits-and-contracts) |
| Reproducible failure demo | Two real HTTP relay listeners, lost connection, repeated effect after checkpoint failure, retention expiry, snapshot recovery and logout. [Run it](docs/v0.1.0/guide.en.md#run-and-verify) |

The client cannot recover unretained events. Exactly-once effects are not promised. The reference relays share one in-memory object in one process; they do not provide distributed or durable storage.

## Try it locally

Requires Node 22.12 or newer and npm. No credentials are needed for the loopback-only demo.

```sh
npm ci
npm test
npm run demo
```

Visit the URL printed by the demo. It never opens a desktop window automatically. Start, publish, disconnect, then try “Offline + expire history” and “Apply snapshot + resume”.

To verify installation without claiming registry publication:

```sh
npm run test:package
# Produces output/59alex-browser-sse-relay-0.1.0.tgz and tests a clean consumer.
npm install /path/to/59alex-browser-sse-relay-0.1.0.tgz
```

See [the English guide](docs/v0.1.0/guide.en.md), [русское руководство](docs/v0.1.0/guide.ru.md), [protocol](docs/PROTOCOL.md), and [verification record](docs/VERIFICATION.md).

## Language and runtime

Library version **0.1.0** is independent of the compiler version: **TypeScript 5.9.3**, strict declarations, emitted **ES2022 ESM**. Interfaces, readonly contracts and union types are compile-time tools; runtime validation covers scopes, cursors, limits and protocol controls. Runtime APIs include fetch streaming, ReadableStream, TextDecoder, Headers and AbortController. No framework or native EventSource is required. [Version-specific details](docs/v0.1.0/guide.en.md#language-and-runtime).

## License and provenance

[MIT](LICENSE), copyright 2026 Aleksandr Kashevarov. SSE field parsing uses [eventsource-parser](https://github.com/rexxars/eventsource-parser) 4.1.2 under its own MIT license. [Parser decision and alternatives](docs/PARSER-DECISION.md). No private application configuration or infrastructure is included.
