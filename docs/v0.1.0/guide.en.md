# browser-sse-relay 0.1.0 — guide

[English](guide.en.md) · [Русский](guide.ru.md) · [Version index](../README.md) · [Repository README](../../README.md)

## Overview

Use this package when a reconnect must resume from application processing, rather than from the most recently received transport event. The server must implement [protocol v1](../PROTOCOL.md), retain history, and provide an application snapshot path when recovery is no longer possible.

| Need | API |
|---|---|
| Process, then save a cursor | SseRelayClient.onEvent and CheckpointStore |
| Retry with fresh authentication | headers callback, refreshAuth, retry options |
| Isolate accounts and streams | StreamScope and scoped checkpoint keys |
| Stop and clear account state | stop(), start() terminal result, logout() |
| Replay across reference relays | MemoryEventStore and createNodeRelay |
| Recover an expired history | terminal resync result and initialCursor from a snapshot |
| Limit memory and waiting | frame/queue/dedup/history limits and timeouts |

<a id="language-and-runtime"></a>
## Language and runtime

Version 0.1.0 uses TypeScript 5.9.3 with strict mode, exact optional properties and unchecked-index checks. Interfaces, readonly event/scope contracts and state unions make API misuse visible at compilation; they do not create runtime authorization. Output is ES2022 ESM with declarations and no CommonJS bundle.

Runtime mechanisms are standard APIs: async/await, optional chaining, nullish coalescing, Map/Set, streaming fetch, ReadableStream readers, TextDecoder, Headers and AbortController/AbortSignal. The code does not use TypeScript decorators, preview APIs or framework lifecycle hooks. TypeScript private members are compile-time encapsulation, not a security boundary.

The Node reference server and development tools require Node 22.12+. Local verification used Node 24.21.0 and headless Chromium 156.0.8078.4. Firefox, WebKit and older browser releases have not been verified. Browser consumers need the runtime APIs listed above and an ESM-aware bundler or import map. The demo supplies its own import map.

## Install from the tested local package

```sh
npm ci
npm test
npm run test:package
npm install /path/to/output/browser-sse-relay-0.1.0.tgz
```

The package smoke test creates a clean consumer, checks both export paths and TypeScript declarations, and processes an actual HTTP SSE event. It does not publish to npm. Registry credentials and package-name ownership still need verification before release.

<a id="process-and-checkpoint"></a>
## Process and checkpoint

Browser example for a counter stream. The endpoint must emit protocol v1 controls and JSON application payloads containing a numeric value. The scope must identify the authenticated account, not a user-entered arbitrary account ID.

```ts
import { SseRelayClient, LocalStorageCheckpointStore } from 'browser-sse-relay';

const scope = { accountId: 'account-42', streamId: 'counter' };
const checkpoint = new LocalStorageCheckpointStore(localStorage);
let counter = 0;

const options = {
  scope,
  url: '/api/events?stream=counter',
  checkpoint,
  async onEvent(event, context) {
    context.signal.throwIfAborted();
    const payload = JSON.parse(event.data);
    if (typeof payload.value !== 'number' || !Number.isFinite(payload.value)) {
      throw new Error('Invalid counter payload');
    }
    counter = payload.value; // Repeating this assignment is idempotent.
  },
} satisfies import('browser-sse-relay').RelayOptions;

let client = new SseRelayClient(options);
const finished = client.start();
```

The observable sequence is handler completion → checkpoint.save completion → committedCursor update. Until both complete, reconnect uses the previous cursor. If the assignment succeeds and checkpoint storage fails, the same event may run again. Replace the counter example with application-specific idempotency or a transactionally deduplicated effect; a browser checkpoint cannot atomically commit a separate backend side effect.

The duplicate set only covers successfully committed IDs in the current bounded session window. It is not durable. A new session can repeat effects after a crash. Storage errors are surfaced through bounded retries, not ignored.

Without an adapter, the committed cursor exists only in this client instance. For a shared process-local cursor map, substitute MemoryCheckpointStore. For custom persistence, implement load(scope, signal), save(scope, cursor, signal), and clear(scope, signal). Honor cancellation immediately before committing and settle every promise. Do not let two sessions concurrently write the same scope's checkpoint; stop and await logout before reusing that scope. Multi-tab ownership coordination is not included.

<a id="retry-and-authentication"></a>
## Retry and authentication

The following callbacks can be supplied when constructing the client above. The token endpoint and its JSON response are application contracts; this library does not implement an identity provider.

```ts
let token = 'initial-application-token';
const authentication = {
  headers: () => ({ Authorization: `Bearer ${token}` }),
  async refreshAuth({ signal }) {
    const response = await fetch('/api/token/refresh', { method: 'POST', signal });
    if (!response.ok) return false;
    const body = await response.json();
    if (typeof body.token !== 'string') return false;
    token = body.token;
    return true;
  },
  retry: { maxAttempts: 8, minDelayMs: 250, maxDelayMs: 10000, jitter: 0.2 },
  connectTimeoutMs: 10000,
  idleTimeoutMs: 45000,
} satisfies Partial<import('browser-sse-relay').RelayOptions>;

client = new SseRelayClient({ ...options, ...authentication });
```

Use this instead of constructing the preceding client; never start two owners of one checkpoint scope. Headers are rebuilt for every request. HTTP 401 invokes refreshAuth, when configured; false or a thrown refresh error ends authentication. HTTP 403 is terminal. Repeated 401 responses still consume the finite attempt budget. maxAttempts counts total connections for this one-shot session, including the first; it does not reset after a healthy period.

Network errors, header/idle timeouts, HTTP 408/429 and 5xx retry with bounded delay and jitter. SSE retry and HTTP Retry-After are clamped to the configured range. Other HTTP failures and invalid protocol controls fail closed. HTTP 204 closes normally; HTTP 409/410 requires resync. Redirects are rejected. For cross-origin use, the server must allow the specific origin and request headers and expose X-Relay-Protocol; the demo shows that host configuration.

A quiet healthy stream needs server comments/heartbeats more frequently than idleTimeoutMs. The timers bound network waits; application handlers, token providers and checkpoint adapters remain responsible for settling their own asynchronous work.

<a id="stop-and-logout"></a>
## Stop and logout

Continue with the active client from the first example:

```ts
client.stop();
const stopped = await client.start(); // Returns the same session promise.
console.log(stopped.state, stopped.reason, stopped.cursor);

await client.logout(); // Await in-flight work, then clear this scope's checkpoint.
```

stop() aborts transport and pending retries and prevents the next handler from starting. It cannot undo an effect already performed by an in-flight handler. Such handlers receive an aborted signal and can inspect context.isCurrent() before applying their own delayed effects.

logout() waits for the session to settle before clearing its scoped cursor. An uncooperative handler or persistence adapter can delay that completion. A terminal session is never restarted; construct a new SseRelayClient. Memory and localStorage adapters key by both accountId and streamId, so one account's logout does not erase another account's cursor.

<a id="snapshot-after-resync"></a>
## Snapshot after resync

Resync is a terminal result, not an instruction to discard the cursor and continue at the newest event. The application must install state and its matching log position. This continuation assumes options and counter from the first example, plus an application endpoint returning `{ value, cursor, scope }` atomically.

```ts
const result = await finished;
if (result.state === 'resync') {
  const response = await fetch('/api/snapshot');
  if (!response.ok) throw new Error('Snapshot unavailable');
  const snapshot = await response.json();
  if (snapshot.scope.accountId !== scope.accountId || snapshot.scope.streamId !== scope.streamId) {
    throw new Error('Snapshot scope mismatch');
  }
  if (typeof snapshot.value !== 'number' || !Number.isFinite(snapshot.value)) {
    throw new Error('Invalid snapshot');
  }
  counter = snapshot.value; // Apply application state BEFORE committing its cursor.
  client = new SseRelayClient({ ...options, initialCursor: snapshot.cursor });
  void client.start();
}
```

initialCursor is validated, persisted, and used instead of a stale stored cursor. Events published between snapshot capture and subscription are replayed, provided retention still covers that position. If snapshot acquisition itself races beyond retention, handle another resync; the library does not invent a replacement cursor.

The demo implements a consistent counter snapshot by reading state and MemoryEventStore.currentCursor in the same synchronous JavaScript section. A production database/log snapshot needs an equivalent consistency mechanism. Reading a database asynchronously and then independently asking for the latest log cursor can lose events.

<a id="reference-relay-and-handoff"></a>
## Reference relay and handoff

This Node example starts two listeners sharing one object. The fixed bearer value is demonstration-only authentication; replace authenticate and authorize with the host application's real security boundary.

```ts
import { createServer } from 'node:http';
import { MemoryEventStore, createNodeRelay } from 'browser-sse-relay/server';

const store = new MemoryEventStore({ maxEventsPerStream: 256, retentionMs: 300000 });
const scope = { accountId: 'demo-account', streamId: 'counter' };
for (const port of [8081, 8082]) {
  const relay = createNodeRelay({
    store,
    authenticate: request => request.headers.authorization === 'Bearer demo-only'
      ? scope.accountId : undefined,
    stream: () => scope.streamId,
  });
  createServer((request, response) => { void relay(request, response); }).listen(port, '127.0.0.1');
}
store.append(scope, JSON.stringify({ value: 1 }), 'counter');
```

subscribe synchronously validates the resume position, captures a watermark, registers the subscriber and queues hello/replay/ready without yielding. New appends follow ready. This gives a deterministic handoff in one JavaScript process. The tests publish while replay is unread and verify exact observable order.

A request without a cursor asks for the origin. If that origin expired, the server returns resync instead of hiding a gap. The immediately preceding eviction-boundary cursor remains resumable while all subsequent events remain available. Cursors are opaque printable ASCII strings, unique within their stream; clients must never parse or order them.

Two listeners sharing MemoryEventStore are not a distributed store. Process restart loses history. A cross-process retained-log adapter must independently provide atomic log ordering, replay/live subscription and persistence; there is no such production adapter in 0.1.0.

<a id="limits-and-contracts"></a>
## Limits and contracts

```ts
const limitedClient = new SseRelayClient({
  ...options,
  limits: {
    maxFrameBytes: 65536,
    maxQueuedEvents: 128,
    maxQueuedBytes: 1048576,
    dedupEntries: 1024,
  },
});
```

These are the default client limits. Frame limits count wire bytes; queue bytes count UTF-8 data, id and event type. One active handler frame and a bounded parser frame are additional to the queued budget. Browser/OS buffering and application-owned copies are outside this accounting. Queue overflow and oversized frames produce resync, not silent event dropping.

Server defaults: 256 retained events per stream, 300 seconds retention, 16 MiB total retained bytes, 64 scopes, 64 subscribers, 1,024 queued frames and 1 MiB per subscriber, 64 KiB per application frame. Subscriber overflow and oversized replay require resync. A socket that cannot drain is closed after five seconds; if its network is already broken, the resync control cannot be guaranteed to arrive, and reconnect revalidates retention.

Scope validation is not authorization. The HTTP host authenticates accounts and checks permitted streams. It also owns TLS, allowed origins, resource quotas and consistent snapshots. No transport acknowledgment proves that an application side effect is durable.

| Alternative | Appropriate use |
|---|---|
| Native EventSource | Standard browser SSE transport when application-level checkpoint ownership is unnecessary. |
| fetch-event-source | Fetch-based SSE with response/header/retry hooks; application recovery and storage remain your responsibility. |
| browser-sse-relay | A specified retained-history protocol plus awaited handler/checkpoint cursor ownership, explicit resync and a runnable reference failure model. |

See [parser evaluation](../PARSER-DECISION.md). This is not a drop-in client for an arbitrary SSE endpoint without protocol v1 controls.

<a id="run-and-verify"></a>
## Run and verify

```sh
npm ci
npm test
npm run demo
# Open the printed loopback URL yourself.

npx playwright install chromium
npm run test:browser
npm run test:package
```

The browser smoke test runs headless. It checks initial commit, relay B replay after a disconnect, a repeated handler after checkpoint failure, terminal resync on expiry, snapshot recovery, and logout with no stale restart. It writes its browser version and screenshot under output/playwright. The package smoke test installs a tarball into a fresh temporary consumer, type-checks public imports and processes an HTTP event.

A failure to start the browser usually means its Playwright binary is not installed; run the install command above. A 401 means the host authentication rejected the request. A protocol-error commonly means a missing protocol header/control, wrong scope, malformed frame or invalid replay watermark. A cursor-unavailable result requires a consistent snapshot, not an empty-cursor retry loop. A retry-exhausted result requires an application decision; this client does not reconnect indefinitely.

Remaining release gates: npm authentication/name ownership, registry publication, production application integration, and additional browser coverage. [Verification record](../VERIFICATION.md) and [roadmap](../../ROADMAP.md) distinguish tested source from published artifacts.
