import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNodeRelay, MemoryEventStore } from '../dist/server/index.js';
import { encodeFrame, controlFrame } from '../dist/protocol.js';

export const scope = Object.freeze({ accountId: 'account-a', streamId: 'events' });
export const encoder = new TextEncoder();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate, message = 'condition', timeout = 2500) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error(`Timed out: ${message}`); await sleep(5); }
}
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export function hello(after = 'origin', watermark = after, identity = scope) { return controlFrame('relay-hello', { protocol: 1, scope: identity, after, watermark }); }
export function ready(watermark = 'origin', identity = scope) { return controlFrame('relay-ready', { scope: identity, watermark }); }
export function event(id, data = id, type = 'message') { return encodeFrame(type, data, id); }
export function sse(wire, { chunks, keepOpen = false, headers = {} } = {}) {
  const bytes = encoder.encode(wire); let position = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (position >= bytes.length) { if (!keepOpen) controller.close(); return; }
      const end = chunks ? Math.min(bytes.length, position + chunks) : bytes.length;
      controller.enqueue(bytes.slice(position, end)); position = end;
    },
  }), { headers: { 'Content-Type': 'text/event-stream', 'X-Relay-Protocol': '1', ...headers } });
}
export async function relayServer(store = new MemoryEventStore(), extra = {}) {
  const relay = createNodeRelay({ store, authenticate: req => req.headers.authorization === 'Bearer valid' ? scope.accountId : undefined,
    stream: req => new URL(req.url, 'http://localhost').searchParams.get('stream') ?? 'events', heartbeatMs: 100, ...extra });
  const server = createServer((req, res) => { void relay(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { store, server, url: `http://127.0.0.1:${server.address().port}/events`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
