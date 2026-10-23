import type { IncomingMessage, ServerResponse } from 'node:http';
import { controlFrame, positiveInteger, ResyncError, scopeKey } from '../protocol.js';
import { MemoryEventStore, type HistorySubscription } from './history.js';

export interface NodeRelayOptions {
  store: MemoryEventStore;
  /** Return the authenticated account ID; never trust a request's account query/header as authentication. */
  authenticate: (request: IncomingMessage) => string | undefined | Promise<string | undefined>;
  stream: (request: IncomingMessage) => string;
  authorize?: (accountId: string, streamId: string, request: IncomingMessage) => boolean | Promise<boolean>;
  heartbeatMs?: number;
  maxDrainWaitMs?: number;
}
/** Reference Node HTTP handler. Routing, TLS, CORS allowlists and production authentication belong to the host. */
export function createNodeRelay(options: NodeRelayOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const heartbeatMs = positiveInteger(options.heartbeatMs ?? 15000, 'heartbeatMs');
  const maxDrainWaitMs = positiveInteger(options.maxDrainWaitMs ?? 5000, 'maxDrainWaitMs');
  return async (request, response) => {
    let subscription: HistorySubscription | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const closed = new AbortController();
    const onClose = () => { closed.abort(); subscription?.close(); };
    response.on('close', onClose);
    response.on('error', onClose);
    try {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end(); return; }
      const accountId = await options.authenticate(request);
      if (closed.signal.aborted) return;
      if (!accountId) { response.writeHead(401); response.end(); return; }
      const streamId = options.stream(request);
      scopeKey({ accountId, streamId });
      if (options.authorize && !await options.authorize(accountId, streamId, request)) { response.writeHead(403); response.end(); return; }
      if (closed.signal.aborted) return;
      const header = request.headers['last-event-id'];
      if (Array.isArray(header)) throw new TypeError('Multiple Last-Event-ID values');
      subscription = options.store.subscribe({ accountId, streamId }, header);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Relay-Protocol': '1',
        'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      heartbeat = setInterval(() => {
        // Do not append heartbeats behind buffered data: the stream loop owns drain/overflow recovery.
        if (!response.destroyed && response.writableLength === 0) response.write(': heartbeat\n\n');
      }, heartbeatMs);
      heartbeat.unref();
      for await (const wire of subscription) {
        if (closed.signal.aborted) break;
        if (!response.write(wire)) await waitForDrain(response, subscription, closed.signal, maxDrainWaitMs);
      }
      if (!response.destroyed) response.end();
    } catch (error) {
      if (response.destroyed || closed.signal.aborted) return;
      if (!response.headersSent) {
        const status = error instanceof ResyncError ? 409 : error instanceof TypeError ? 400 : 503;
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ reason: error instanceof ResyncError ? error.reason : status === 400 ? 'invalid-request' : 'relay-unavailable' }));
      } else if (error instanceof ResyncError) {
        response.end(controlFrame('relay-resync', { reason: error.reason }));
      } else {
        // Once the socket cannot drain, no control frame can be guaranteed. Reconnect validates retention.
        response.destroy();
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      subscription?.close();
      response.removeListener('close', onClose);
      response.removeListener('error', onClose);
    }
  };
}
function waitForDrain(response: ServerResponse, subscription: HistorySubscription, signal: AbortSignal, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let offFailure: () => void = () => undefined;
    const cleanup = () => { clearTimeout(timer); response.off('drain', drain); response.off('error', fail); signal.removeEventListener('abort', abort); offFailure(); };
    const drain = () => { cleanup(); resolve(); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(new Error('Socket drain timeout')), timeout);
    response.once('drain', drain); response.once('error', fail); signal.addEventListener('abort', abort, { once: true });
    offFailure = subscription.onFailure(fail);
    if (signal.aborted) abort();
  });
}
