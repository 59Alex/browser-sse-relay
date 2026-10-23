import test from 'node:test';
import assert from 'node:assert/strict';
import { SseRelayClient, MemoryCheckpointStore, LocalStorageCheckpointStore } from '../dist/index.js';
import { scope, hello, ready, event, sse, deferred, until, sleep } from './helpers.mjs';

const retry = { maxAttempts: 3, minDelayMs: 1, maxDelayMs: 5, jitter: 0 };
const options = extra => ({ scope, url: 'https://relay.invalid/events', onEvent: async () => {}, retry, ...extra });

test('commit awaits handler AND checkpoint; ready is observed after replay commits', async () => {
  const handler = deferred(), persistence = deferred(); let saved = false, liveCursor;
  const client = new SseRelayClient(options({
    checkpoint: { async load() {}, async save() { saved = true; await persistence.promise; }, async clear() {} },
    onEvent: () => handler.promise,
    onState(state, value) { if (state === 'live') liveCursor = value.cursor; },
    fetch: async () => sse(hello('origin', 'e1') + event('e1') + ready('e1'), { keepOpen: true }),
  }));
  const running = client.start();
  await until(() => client.state === 'replaying');
  assert.equal(client.committedCursor, undefined); assert.equal(saved, false);
  handler.resolve(); await until(() => saved);
  assert.equal(client.committedCursor, undefined);
  persistence.resolve(); await until(() => client.state === 'live');
  assert.equal(liveCursor, 'e1'); client.stop(); assert.equal((await running).state, 'closed');
});

test('checkpoint failure repeats handler effect and reconnects from prior committed cursor', async () => {
  let requests = 0, effects = 0, saves = 0; const cursors = [];
  const client = new SseRelayClient(options({
    checkpoint: { async load() {}, async save() { if (++saves === 1) throw new Error('disk unavailable'); }, async clear() {} },
    onEvent: async () => { effects++; },
    fetch: async (_url, init) => {
      requests++; cursors.push(init.headers.get('Last-Event-ID'));
      return requests === 3 ? new Response(null, { status: 204 }) : sse(hello('origin', 'e1') + event('e1') + ready('e1'));
    },
  }));
  const result = await client.start();
  assert.equal(result.state, 'closed'); assert.equal(effects, 2); assert.equal(saves, 2);
  assert.deepEqual(cursors, [null, null, 'e1']); assert.equal(result.cursor, 'e1');
});

test('handler rejection never checkpoints; replay retries the same event', async () => {
  let calls = 0, requests = 0; const checkpoint = new MemoryCheckpointStore();
  const client = new SseRelayClient(options({ checkpoint,
    onEvent() { if (++calls === 1) throw new Error('temporary application error'); },
    fetch: async () => ++requests === 3 ? new Response(null, { status: 204 }) : sse(hello('origin', 'e1') + event('e1') + ready('e1')),
  }));
  assert.equal((await client.start()).cursor, 'e1'); assert.equal(calls, 2);
  assert.equal(await checkpoint.load(scope, new AbortController().signal), 'e1');
});

test('logout invalidates queued callbacks and waits before clearing a scoped checkpoint', async () => {
  const checkpoint = new MemoryCheckpointStore(), pending = deferred(); const seen = []; let requests = 0;
  const client = new SseRelayClient(options({ checkpoint,
    onEvent: async value => { seen.push(value.id); await pending.promise; },
    fetch: async () => { requests++; return sse(hello('origin', 'e2') + event('e1') + event('e2') + ready('e2'), { keepOpen: true }); },
  }));
  const running = client.start(); await until(() => seen.length === 1);
  const logout = client.logout(); pending.resolve(); await logout;
  assert.equal((await running).state, 'closed'); assert.deepEqual(seen, ['e1']); assert.equal(requests, 1);
  assert.equal(await checkpoint.load(scope, new AbortController().signal), undefined);
});

test('stopped session cannot write after an awaited handler, even when handler ignores cancellation', async () => {
  const pending = deferred(); let entered = false, saves = 0;
  const client = new SseRelayClient(options({ onEvent: async () => { entered = true; await pending.promise; },
    checkpoint: { async load() {}, async save() { saves++; }, async clear() {} },
    fetch: async () => sse(hello('origin', 'e1') + event('e1') + ready('e1'), { keepOpen: true }),
  }));
  const running = client.start(); await until(() => entered); client.stop(); pending.resolve(); await running;
  assert.equal(saves, 0); assert.equal(client.committedCursor, undefined);
});

test('headers refresh for each request and 401 token refresh remains bounded', async () => {
  let token = 'old', refreshed = 0; const received = [];
  const client = new SseRelayClient(options({ headers: async () => ({ Authorization: token }),
    refreshAuth: async () => { refreshed++; token = 'new'; return true; },
    fetch: async (_url, init) => { received.push(init.headers.get('Authorization')); return new Response(null, { status: received.length === 1 ? 401 : 204 }); },
  }));
  assert.equal((await client.start()).state, 'closed'); assert.deepEqual(received, ['old', 'new']); assert.equal(refreshed, 1);
  let attempts = 0;
  const exhausted = new SseRelayClient(options({ refreshAuth: async () => true,
    fetch: async () => { attempts++; return new Response(null, { status: 401 }); } }));
  assert.equal((await exhausted.start()).reason, 'retry-exhausted'); assert.equal(attempts, 3);
});

test('abort during token refresh prevents a stale reconnect', async () => {
  const refresh = deferred(); let entered = false, requests = 0;
  const client = new SseRelayClient(options({ refreshAuth: async () => { entered = true; return refresh.promise; },
    fetch: async () => { requests++; return new Response(null, { status: 401 }); },
  }));
  const running = client.start(); await until(() => entered); client.stop(); refresh.resolve(true);
  assert.equal((await running).state, 'closed'); assert.equal(requests, 1);
});

test('403 does not refresh or retry; HTTP retention gaps require explicit resync', async () => {
  for (const status of [403, 409, 410]) {
    let calls = 0;
    const client = new SseRelayClient(options({ fetch: async () => { calls++; return new Response(null, { status }); } }));
    const result = await client.start(); assert.equal(calls, 1);
    assert.equal(result.state, status === 403 ? 'failed' : 'resync');
  }
});

test('stop cancels retry timer and an enormous retry hint is capped', async () => {
  let calls = 0; let client;
  client = new SseRelayClient(options({ retry: { maxAttempts: 3, minDelayMs: 10000, maxDelayMs: 10000 },
    onState(state) { if (state === 'waiting') queueMicrotask(() => client.stop()); },
    fetch: async () => { calls++; throw new TypeError('offline'); },
  }));
  assert.equal((await client.start()).state, 'closed'); assert.equal(calls, 1);
  const capped = new SseRelayClient(options({ fetch: async () => ++calls === 2
    ? sse('retry: 999999999999999\n\n' + hello() + ready()) : new Response(null, { status: 204 }) }));
  const start = Date.now(); assert.equal((await capped.start()).state, 'closed'); assert.ok(Date.now() - start < 1000);
});

test('dedup is bounded, ignores committed live duplicates, and never rewinds cursor within its window', async () => {
  const seen = []; let calls = 0;
  const client = new SseRelayClient(options({ limits: { dedupEntries: 2 }, onEvent: value => { seen.push(value.id); },
    fetch: async () => ++calls === 1 ? sse(hello() + ready() + event('e1') + event('e2') + event('e3') + event('e2')) : new Response(null, { status: 204 }),
  }));
  assert.equal((await client.start()).cursor, 'e3'); assert.deepEqual(seen, ['e1', 'e2', 'e3']); assert.equal(client.dedupSize, 2);
});

test('wrong scope, missing event id, malformed control, and broken handoff fail before unsafe delivery', async () => {
  const wires = [hello('origin', 'origin', { ...scope, accountId: 'other' }) + ready(),
    hello() + ready() + 'data: no id\n\n', 'event: relay-hello\ndata: nope\n\n',
    hello('origin', 'e1') + ready('e1')];
  for (const wire of wires) {
    let handled = 0;
    const client = new SseRelayClient(options({ onEvent: () => { handled++; }, fetch: async () => sse(wire) }));
    assert.equal((await client.start()).reason, 'protocol-error'); assert.equal(handled, 0);
  }
});

test('oversized wire and bounded queue overflow report resync, including Unicode metadata bytes', async () => {
  const large = new SseRelayClient(options({ limits: { maxFrameBytes: 128 }, fetch: async () => sse(': ' + 'a'.repeat(129)) }));
  assert.equal((await large.start()).reason, 'frame-too-large');
  const queue = new SseRelayClient(options({ limits: { maxQueuedEvents: 1 },
    fetch: async () => sse(hello() + ready() + event('e1') + event('e2')),
  }));
  assert.equal((await queue.start()).reason, 'client-queue-overflow');
  const unicode = new SseRelayClient(options({ limits: { maxQueuedBytes: 200 },
    fetch: async () => sse(hello() + ready() + event('e1', 'x', 'я'.repeat(100)), { chunks: 1 }),
  }));
  assert.equal((await unicode.start()).reason, 'client-queue-overflow');
});

test('checkpoint scopes are distinct, storage failure surfaces, and snapshot cursor overrides stale state', async () => {
  const map = new Map(); const storage = new LocalStorageCheckpointStore({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const signal = new AbortController().signal;
  await storage.save(scope, 'old', signal); await storage.save({ ...scope, accountId: 'other' }, 'other-cursor', signal);
  let requested;
  const client = new SseRelayClient(options({ checkpoint: storage, initialCursor: 'snapshot',
    fetch: async (_url, init) => { requested = init.headers.get('Last-Event-ID'); return new Response(null, { status: 204 }); },
  }));
  await client.start(); assert.equal(requested, 'snapshot'); await client.logout();
  assert.equal(await storage.load(scope, signal), undefined);
  assert.equal(await storage.load({ ...scope, accountId: 'other' }, signal), 'other-cursor');
  const failed = new SseRelayClient(options({ checkpoint: { async load() { throw new Error('Storage denied'); }, async save() {}, async clear() {} } }));
  assert.equal((await failed.start()).reason, 'initialization-failed');
});

test('external AbortSignal and repeated start refer to the same one-shot session', async () => {
  const external = new AbortController(); let calls = 0;
  const client = new SseRelayClient(options({ signal: external.signal,
    fetch: async () => { calls++; return sse(hello() + ready(), { keepOpen: true }); } }));
  const first = client.start(); assert.equal(first, client.start());
  await until(() => client.state === 'live'); external.abort(); assert.equal((await first).state, 'closed'); assert.equal(calls, 1);
});

test('connection-header and idle-byte timeouts retry and stop within the attempt budget', async () => {
  let headers = 0;
  const connecting = new SseRelayClient(options({ connectTimeoutMs: 10,
    fetch: async (_url, init) => {
      if (++headers > 1) return new Response(null, { status: 204 });
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    },
  }));
  assert.equal((await connecting.start()).state, 'closed'); assert.equal(headers, 2);
  let idle = 0;
  const stalled = new SseRelayClient(options({ idleTimeoutMs: 10,
    fetch: async () => ++idle === 1 ? sse(hello() + ready(), { keepOpen: true }) : new Response(null, { status: 204 }),
  }));
  assert.equal((await stalled.start()).state, 'closed'); assert.equal(idle, 2);
});

test('stop from a state observer prevents new URL and token-refresh callbacks', async () => {
  for (const stateToStop of ['connecting', 'authenticating']) {
    let urls = 0, refreshes = 0, requests = 0;
    const client = new SseRelayClient(options({
      url: () => { urls++; return 'https://relay.invalid/events'; },
      refreshAuth: () => { refreshes++; return true; },
      fetch: async () => { requests++; return new Response(null, { status: 401 }); },
      onState: state => { if (state === stateToStop) client.stop(); },
    }));
    assert.equal((await client.start()).state, 'closed');
    assert.equal(urls, stateToStop === 'connecting' ? 0 : 1);
    assert.equal(requests, stateToStop === 'connecting' ? 0 : 1);
    assert.equal(refreshes, 0);
  }
});

test('EOF cancels the byte-idle timer while received events finish processing', async () => {
  const seen = []; let calls = 0;
  const client = new SseRelayClient(options({ idleTimeoutMs: 10,
    onEvent: async value => { seen.push(value.id); await sleep(30); },
    fetch: async () => ++calls === 1 ? sse(hello('origin', 'e2') + event('e1') + event('e2') + ready('e2'))
      : new Response(null, { status: 204 }),
  }));
  const result = await client.start();
  assert.deepEqual(seen, ['e1', 'e2']); assert.equal(result.cursor, 'e2');
});

test('no application event is handled between the replay watermark and relay-ready', async () => {
  for (const replay of [false, true]) {
    const seen = [];
    const client = new SseRelayClient(options({
      onEvent: value => { seen.push(value.id); },
      fetch: async () => sse((replay ? hello('origin', 'e1') + event('e1') : hello()) + event('too-early')),
    }));
    const result = await client.start();
    assert.equal(result.reason, 'protocol-error');
    assert.deepEqual(seen, replay ? ['e1'] : []);
    assert.equal(result.cursor, replay ? 'e1' : undefined);
  }
});

test('stop detaches the external signal even when start was never called', async () => {
  const { getEventListeners } = await import('node:events');
  const external = new AbortController();
  const client = new SseRelayClient(options({ signal: external.signal }));
  assert.equal(getEventListeners(external.signal, 'abort').length, 1);
  client.stop(); client.stop();
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('timer options reject values that setTimeout would clamp to near-zero', () => {
  const overflow = 2 ** 31;
  for (const extra of [{ connectTimeoutMs: overflow }, { idleTimeoutMs: overflow },
    { retry: { maxDelayMs: overflow } }, { retry: { minDelayMs: overflow, maxDelayMs: overflow } }]) {
    assert.throws(() => new SseRelayClient(options(extra)), /timer range/);
  }
  const allowed = new SseRelayClient(options({ connectTimeoutMs: overflow - 1, idleTimeoutMs: overflow - 1 }));
  allowed.stop();
});
