import { randomUUID } from 'node:crypto';
import { BoundedQueue } from '../queue.js';
import { controlFrame, encodeFrame, encoder, positiveInteger, ResyncError, scopeKey, validateCursor,
  type RelayEvent, type StreamScope } from '../protocol.js';

interface StoredEvent extends RelayEvent { readonly createdAt: number; readonly bytes: number; readonly wire: string }
interface Stream {
  readonly scope: StreamScope; readonly origin: string; floor: string; head: string;
  history: StoredEvent[]; subscriptions: Set<HistorySubscription>;
}
export interface HistoryOptions {
  maxEventsPerStream?: number; retentionMs?: number; maxRetainedBytes?: number; maxStreams?: number;
  maxSubscribers?: number; maxQueuedFrames?: number; maxQueuedBytes?: number; maxEventBytes?: number;
  now?: () => number;
}
export interface StoreStats { streams: number; retainedEvents: number; retainedBytes: number; subscribers: number }

/** A bounded subscription containing hello, ordered replay, ready, then live frames. */
export class HistorySubscription implements AsyncIterable<string> {
  readonly watermark: string;
  readonly after: string;
  private closed = false;
  private failure: unknown;
  private listeners = new Set<(error: unknown) => void>();
  constructor(watermark: string, after: string, private readonly queue: BoundedQueue<string>, private readonly detach: () => void) {
    this.watermark = watermark; this.after = after;
  }
  /** Internal append notification. A failed slow subscriber never fails the producer's committed append. */
  enqueue(wire: string): void {
    if (this.closed) return;
    try { this.queue.push(wire, encoder.encode(wire).byteLength); }
    catch (error) { this.fail(error); }
  }
  get error(): unknown { return this.failure; }
  get queuedFrames(): number { return this.queue.size; }
  get queuedBytes(): number { return this.queue.queuedBytes; }
  onFailure(listener: (error: unknown) => void): () => void {
    if (this.failure !== undefined) listener(this.failure);
    else this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error; this.closed = true; this.queue.fail(error); this.detach();
    for (const listener of this.listeners) { try { listener(error); } catch { /* A failed observer cannot undo an already committed publication. */ } }
    this.listeners.clear();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.queue.end(); this.detach(); this.listeners.clear();
  }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return { next: () => this.queue.next(), return: async () => { this.close(); return { done: true, value: undefined }; } };
  }
}

/**
 * Reference retained log. Atomicity relies on synchronous operations in one JS process.
 * Sharing this object across two HTTP handlers is not cross-process persistence.
 */
export class MemoryEventStore {
  private readonly streams = new Map<string, Stream>();
  private retainedBytes = 0;
  private subscribers = 0;
  private readonly options: Required<HistoryOptions>;
  constructor(options: HistoryOptions = {}) {
    this.options = { maxEventsPerStream: 256, retentionMs: 300000, maxRetainedBytes: 16777216,
      maxStreams: 64, maxSubscribers: 64, maxQueuedFrames: 1024, maxQueuedBytes: 1048576,
      maxEventBytes: 65536, now: Date.now, ...options };
    for (const [key, value] of Object.entries(this.options)) if (key !== 'now') positiveInteger(value as number, key);
  }
  /** Commit one event and synchronously notify subscribers in the same per-scope order. */
  append(scope: StreamScope, data: string, event = 'message'): RelayEvent {
    if (typeof data !== 'string' || event.startsWith('relay-')) throw new TypeError('String data and a non-reserved event type are required');
    if (data.length > this.options.maxEventBytes) throw new RangeError('Event exceeds retained event size limit');
    const id = randomUUID();
    const wire = encodeFrame(event, data, id);
    const bytes = encoder.encode(wire).byteLength;
    if (bytes > this.options.maxEventBytes || bytes > this.options.maxRetainedBytes) throw new RangeError('Event exceeds retained event size limit');
    const stream = this.getStream(scope);
    const stored = Object.freeze({ id, event, data, wire, bytes, createdAt: this.options.now() });
    stream.history.push(stored); stream.head = id; this.retainedBytes += bytes;
    this.prune();
    for (const subscriber of stream.subscriptions) subscriber.enqueue(wire);
    return Object.freeze({ id, event, data });
  }
  /**
   * Capture the log position for an application snapshot inside the SAME synchronous critical section
   * that reads application state. Merely calling this after an asynchronous snapshot is not atomic.
   */
  currentCursor(scope: StreamScope): string { this.prune(); return this.getStream(scope).head; }
  /** Atomically capture replay and register for all later events; no await occurs in this operation. */
  subscribe(scope: StreamScope, cursor?: string): HistorySubscription {
    this.prune();
    const stream = this.getStream(scope);
    const after = cursor === undefined ? stream.origin : validateCursor(cursor);
    let index: number;
    if (after === stream.floor) index = 0;
    else {
      const found = stream.history.findIndex(event => event.id === after);
      if (found < 0) throw new ResyncError('cursor-unavailable');
      index = found + 1;
    }
    if (this.subscribers >= this.options.maxSubscribers) throw new Error('Subscriber capacity reached');
    const frames = [controlFrame('relay-hello', { protocol: 1, scope: stream.scope, after, watermark: stream.head }),
      ...stream.history.slice(index).map(event => event.wire),
      controlFrame('relay-ready', { scope: stream.scope, watermark: stream.head })];
    if (frames.length > this.options.maxQueuedFrames || frames.reduce((sum, frame) => sum + encoder.encode(frame).byteLength, 0) > this.options.maxQueuedBytes) {
      throw new ResyncError('replay-too-large');
    }
    const queue = new BoundedQueue<string>(this.options.maxQueuedFrames, this.options.maxQueuedBytes, 'server-queue-overflow');
    const subscription = new HistorySubscription(stream.head, after, queue, () => {
      if (stream.subscriptions.delete(subscription)) this.subscribers--;
    });
    stream.subscriptions.add(subscription); this.subscribers++;
    for (const frame of frames) subscription.enqueue(frame);
    return subscription;
  }
  /** Close active transports without deleting retained history, useful for a failure demonstration. */
  disconnect(scope?: StreamScope): void {
    for (const [key, stream] of this.streams) {
      if (scope && key !== scopeKey(scope)) continue;
      for (const subscriber of [...stream.subscriptions]) subscriber.close();
    }
  }
  stats(): StoreStats {
    this.prune();
    return { streams: this.streams.size, retainedBytes: this.retainedBytes, subscribers: this.subscribers,
      retainedEvents: [...this.streams.values()].reduce((sum, stream) => sum + stream.history.length, 0) };
  }
  private getStream(scope: StreamScope): Stream {
    const key = scopeKey(scope);
    let stream = this.streams.get(key);
    if (!stream) {
      if (this.streams.size >= this.options.maxStreams) throw new Error('Stream capacity reached');
      const origin = randomUUID();
      stream = { scope: Object.freeze({ ...scope }), origin, floor: origin, head: origin, history: [], subscriptions: new Set() };
      this.streams.set(key, stream);
    }
    return stream;
  }
  private evict(stream: Stream): void {
    const event = stream.history.shift();
    if (event) { this.retainedBytes -= event.bytes; stream.floor = event.id; }
  }
  private prune(): void {
    const cutoff = this.options.now() - this.options.retentionMs;
    for (const stream of this.streams.values()) {
      while (stream.history.length > this.options.maxEventsPerStream || (stream.history[0]?.createdAt ?? Infinity) <= cutoff) this.evict(stream);
    }
    while (this.retainedBytes > this.options.maxRetainedBytes) {
      let oldest: Stream | undefined;
      for (const stream of this.streams.values()) {
        if (stream.history[0] && (!oldest || stream.history[0].createdAt < oldest.history[0]!.createdAt)) oldest = stream;
      }
      if (!oldest) break;
      this.evict(oldest);
    }
  }
}
