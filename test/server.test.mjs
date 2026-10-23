import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEventStore } from '../dist/server/index.js';
import { SseRelayClient, MemoryCheckpointStore, ResyncError } from '../dist/index.js';
import { createWireParser } from '../dist/parser.js';
import { scope, encoder, relayServer, until, sleep } from './helpers.mjs';

function decode(frames) { const result = []; const parser = createWireParser(65536, item => result.push(item), () => {}); for (const frame of frames) parser.feed(encoder.encode(frame)); return result; }
async function take(subscription, count) { const it = subscription[Symbol.asyncIterator](); const frames = []; for (let i = 0; i < count; i++) { const value = await it.next(); assert.equal(value.done, false); frames.push(value.value); } return decode(frames); }
const retry = { maxAttempts: 5, minDelayMs: 5, maxDelayMs: 20, jitter: 0 };

test('subscribe is an atomic replay/live boundary even when a publisher runs during replay', async () => {
  const store = new MemoryEventStore();
  const first = store.append(scope, 'first');
  const second = store.append(scope, 'second');
  const sub = store.subscribe(scope, first.id);
  const third = store.append(scope, 'published while replay is unread');
  const frames = await take(sub, 4);
  assert.deepEqual(frames.map(value => value.event), ['relay-hello', 'message', 'relay-ready', 'message']);
  assert.equal(JSON.parse(frames[0].data).watermark, second.id);
  assert.equal(frames[1].id, second.id); assert.equal(frames[3].id, third.id);
  sub.close(); assert.equal(store.stats().subscribers, 0);
});

test('concurrent publisher microtasks retain one order with no duplicate handoff', async () => {
  const store = new MemoryEventStore(); const sub = store.subscribe(scope); const committed = [];
  await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => { committed.push(store.append(scope, String(i)).id); })));
  const frames = await take(sub, 42);
  assert.deepEqual(frames.slice(2).map(value => value.id), committed);
  assert.equal(new Set(committed).size, 40); sub.close();
});

test('count/time/global-byte retention expires the origin and retains the immediate boundary cursor', async () => {
  let now = 0;
  const store = new MemoryEventStore({ maxEventsPerStream: 2, retentionMs: 10, now: () => now });
  const origin = store.currentCursor(scope);
  const a = store.append(scope, 'a'), b = store.append(scope, 'b'), c = store.append(scope, 'c');
  assert.throws(() => store.subscribe(scope, origin), ResyncError);
  assert.throws(() => store.subscribe(scope), ResyncError);
  const atBoundary = store.subscribe(scope, a.id);
  assert.deepEqual((await take(atBoundary, 4)).slice(1, 3).map(item => item.id), [b.id, c.id]); atBoundary.close();
  now = 11; assert.equal(store.stats().retainedEvents, 0);
  assert.throws(() => store.subscribe(scope, b.id), ResyncError);
  const current = store.subscribe(scope, c.id); assert.equal((await take(current, 2)).length, 2); current.close();
  const budget = new MemoryEventStore({ maxRetainedBytes: 180, maxEventBytes: 180 });
  const old = budget.currentCursor(scope); budget.append(scope, 'x'.repeat(80)); budget.append({ ...scope, accountId: 'b' }, 'y'.repeat(80));
  assert.ok(budget.stats().retainedBytes <= 180); assert.throws(() => budget.subscribe(scope, old), ResyncError);
});

test('cursor from another account cannot be reused; snapshot position allows fresh recovery after expiry', async () => {
  const store = new MemoryEventStore({ maxEventsPerStream: 1 });
  const a = store.append(scope, 'one'); store.append(scope, 'two');
  assert.throws(() => store.subscribe({ ...scope, accountId: 'other' }, a.id), ResyncError);
  const snapshotCursor = store.currentCursor(scope);
  const after = store.append(scope, 'three');
  const sub = store.subscribe(scope, snapshotCursor);
  const frames = await take(sub, 3); assert.equal(frames[1].id, after.id); sub.close();
});

test('slow subscriber and oversized replay request require resync without losing committed publications', async () => {
  const store = new MemoryEventStore({ maxQueuedFrames: 3 });
  const sub = store.subscribe(scope);
  store.append(scope, 'one'); const second = store.append(scope, 'two');
  assert.ok(sub.error instanceof ResyncError); assert.equal(sub.error.reason, 'server-queue-overflow');
  assert.equal(store.currentCursor(scope), second.id); assert.equal(store.stats().subscribers, 0);
  await assert.rejects(sub[Symbol.asyncIterator]().next(), ResyncError);
  assert.throws(() => store.subscribe(scope), /replay-too-large/);
});

test('store enforces event/stream/subscriber/byte bounds and reserved types', () => {
  const store = new MemoryEventStore({ maxStreams: 1, maxSubscribers: 1, maxEventBytes: 128 });
  assert.throws(() => store.append(scope, 'x'.repeat(129)), RangeError);
  assert.throws(() => store.append(scope, 'x', 'relay-ready'), TypeError);
  const sub = store.subscribe(scope);
  assert.throws(() => store.subscribe(scope), /Subscriber capacity/);
  assert.throws(() => store.currentCursor({ ...scope, streamId: 'another' }), /Stream capacity/);
  sub.close(); assert.equal(store.stats().subscribers, 0);
});

test('real HTTP disconnect resumes on a second relay sharing retained history', async t => {
  const store = new MemoryEventStore();
  const a = await relayServer(store), b = await relayServer(store);
  t.after(async () => { await a.close(); await b.close(); });
  const first = store.append(scope, 'first'); let second;
  const seen = [], urls = [], checkpoints = new MemoryCheckpointStore();
  const client = new SseRelayClient({ scope, checkpoint: checkpoints, headers: { Authorization: 'Bearer valid' }, retry,
    url: ({ attempt }) => { const url = attempt === 1 ? a.url : b.url; urls.push(url); return url; },
    onEvent(value) {
      seen.push(value.id);
      if (value.id === first.id && !second) { a.server.closeAllConnections(); second = store.append(scope, 'while disconnected'); }
    },
  });
  const running = client.start();
  try { await until(() => second && client.committedCursor === second.id, 'replay committed on another replica'); }
  finally { client.stop(); await running; }
  assert.deepEqual(seen, [first.id, second.id]); assert.deepEqual(urls.slice(0, 2), [a.url, b.url]);
  await until(() => store.stats().subscribers === 0, 'server subscription cleanup');
});

test('HTTP scope authorization, expired cursor, and snapshot resume have observable results', async t => {
  const store = new MemoryEventStore({ maxEventsPerStream: 1 }); const relay = await relayServer(store);
  t.after(() => relay.close());
  const expired = store.currentCursor(scope); store.append(scope, 'one'); store.append(scope, 'two');
  assert.equal((await fetch(relay.url)).status, 401);
  const old = new SseRelayClient({ scope, url: relay.url, initialCursor: expired, headers: { Authorization: 'Bearer valid' }, retry, onEvent() { throw new Error('must not deliver'); } });
  assert.equal((await old.start()).state, 'resync');
  const snapshot = store.currentCursor(scope); const next = store.append(scope, 'after snapshot'); const seen = [];
  const resumed = new SseRelayClient({ scope, url: relay.url, initialCursor: snapshot, headers: { Authorization: 'Bearer valid' }, retry, onEvent: value => { seen.push(value.id); } });
  const running = resumed.start();
  await until(() => resumed.committedCursor === next.id); resumed.stop(); await running;
  assert.deepEqual(seen, [next.id]);
});

test('slow awaited handlers overflow the bounded client queue on an actual HTTP stream', async t => {
  const relay = await relayServer(); t.after(() => relay.close());
  const client = new SseRelayClient({ scope, url: relay.url, headers: { Authorization: 'Bearer valid' }, retry,
    limits: { maxQueuedEvents: 2 }, onEvent: async () => { await sleep(20); },
  });
  const running = client.start(); await until(() => client.state === 'live');
  for (let i = 0; i < 20; i++) relay.store.append(scope, String(i));
  const result = await running; assert.equal(result.state, 'resync'); assert.equal(result.reason, 'client-queue-overflow');
});

test('close and disconnect discard unread frames and detach subscriptions immediately', async () => {
  for (const disconnect of [false, true]) {
    const store = new MemoryEventStore(); store.append(scope, 'retained');
    const sub = store.subscribe(scope);
    assert.ok(sub.queuedFrames > 0); assert.ok(sub.queuedBytes > 0);
    if (disconnect) store.disconnect(scope); else sub.close();
    assert.equal(sub.queuedFrames, 0); assert.equal(sub.queuedBytes, 0);
    assert.equal(store.stats().subscribers, 0);
    assert.equal((await sub[Symbol.asyncIterator]().next()).done, true);
    assert.equal(store.stats().retainedEvents, 1);
  }
});

// Controlled socket backpressure: unlike OS send-buffer saturation this has a deterministic boundary.
async function blockedResponse(t, { blockOnHeartbeat = false, overflow = false } = {}) {
  const { EventEmitter } = await import('node:events');
  const { createNodeRelay } = await import('../dist/server/index.js');
  const store = new MemoryEventStore({ maxQueuedFrames: 3 });
  const response = new EventEmitter();
  Object.assign(response, { destroyed: false, headersSent: false, writableLength: 0, writableNeedDrain: false,
    writeHead() { this.headersSent = true; return this; }, flushHeaders() {},
    write(wire) {
      if (blockOnHeartbeat && !wire.startsWith(': heartbeat')) return true;
      this.writableLength = wire.length; this.writableNeedDrain = true;
      if (overflow) queueMicrotask(() => { for (let i = 0; i < 8; i++) store.append(scope, String(i)); });
      return false;
    },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  const handler = createNodeRelay({ store, authenticate: () => scope.accountId, stream: () => scope.streamId,
    heartbeatMs: 5, maxDrainWaitMs: 15 });
  const fallback = setTimeout(() => response.emit('close'), 100);
  t.after(() => clearTimeout(fallback));
  await handler({ method: 'GET', headers: {} }, response);
  clearTimeout(fallback);
  assert.equal(response.destroyed, true, 'an undrainable response must be destroyed');
  assert.equal(store.stats().subscribers, 0);
  assert.equal(response.listenerCount('drain'), 0); assert.equal(response.listenerCount('close'), 0);
}
test('heartbeat-only socket backpressure observes the same drain deadline', t => blockedResponse(t, { blockOnHeartbeat: true }));
test('queue overflow while socket is blocked destroys it instead of appending an undeliverable resync', t => blockedResponse(t, { overflow: true }));

test('rejected subscriptions do not consume previously unused stream capacity', () => {
  for (const limits of [{ maxQueuedFrames: 1 }, { maxQueuedBytes: 1 }]) {
    const tooSmall = new MemoryEventStore(limits);
    assert.throws(() => tooSmall.subscribe(scope), ResyncError);
    assert.equal(tooSmall.stats().streams, 0);
  }
  const store = new MemoryEventStore({ maxStreams: 2, maxSubscribers: 1 });
  const other = { ...scope, streamId: 'unowned' };
  assert.throws(() => store.subscribe(other, 'foreign-cursor'), ResyncError);
  assert.throws(() => store.subscribe(other, 'invalid cursor'), TypeError);
  assert.equal(store.stats().streams, 0);
  const active = store.subscribe(scope);
  assert.throws(() => store.subscribe(other), /Subscriber capacity/);
  assert.equal(store.stats().streams, 1);
  active.close();
  const admitted = store.subscribe(other); admitted.close();
  assert.equal(store.stats().streams, 2);
});

test('server timer options reject platform timer overflow', async () => {
  const { createNodeRelay } = await import('../dist/server/index.js');
  const options = { store: new MemoryEventStore(), authenticate: () => scope.accountId, stream: () => scope.streamId };
  for (const extra of [{ heartbeatMs: 2 ** 31 }, { maxDrainWaitMs: 2 ** 31 }]) {
    assert.throws(() => createNodeRelay({ ...options, ...extra }), /timer range/);
  }
});

test('real HTTP authorization denies streams before allocation and query account cannot change scope', async t => {
  const store = new MemoryEventStore();
  const relay = await relayServer(store, { authorize: (account, stream) => account === scope.accountId && stream === scope.streamId });
  t.after(() => relay.close());
  const headers = { Authorization: 'Bearer valid' };
  const denied = await fetch(relay.url + '?stream=private&accountId=other', { headers });
  assert.equal(denied.status, 403); await denied.body?.cancel();
  assert.equal(store.stats().streams, 0); assert.equal(store.stats().subscribers, 0);
  const allowed = await fetch(relay.url + '?accountId=other', { headers });
  assert.equal(allowed.status, 200);
  const reader = allowed.body.getReader();
  try {
    const first = await reader.read();
    const frames = decode([new TextDecoder().decode(first.value)]);
    assert.deepEqual(JSON.parse(frames[0].data).scope, scope);
  } finally { await reader.cancel(); reader.releaseLock(); }
  await until(() => store.stats().subscribers === 0);
});
