import { ResyncError } from './protocol.js';

/** Single-consumer queue. Failure discards queued work; it must be replayed or resynchronized. */
export class BoundedQueue<T> {
  private items: Array<{ value: T; bytes: number }> = [];
  private bytes = 0;
  private ended = false;
  private failure: unknown;
  private failed = false;
  private waiter: { resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void } | undefined;
  constructor(private readonly maxItems: number, private readonly maxBytes: number, private readonly overflowReason: string) {}
  push(value: T, bytes: number): void {
    if (this.ended || this.failed) return;
    if (bytes > this.maxBytes) { const error = new ResyncError(this.overflowReason); this.fail(error); throw error; }
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ done: false, value }); return; }
    if (this.items.length >= this.maxItems || bytes > this.maxBytes - this.bytes) {
      const error = new ResyncError(this.overflowReason); this.fail(error); throw error;
    }
    this.items.push({ value, bytes }); this.bytes += bytes;
  }
  next(): Promise<IteratorResult<T>> {
    if (this.failed) return Promise.reject(this.failure);
    const item = this.items.shift();
    if (item) { this.bytes -= item.bytes; return Promise.resolve({ done: false, value: item.value }); }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    if (this.waiter) return Promise.reject(new Error('Only one queue consumer is supported'));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  /** EOF drains queued work; explicit subscription closure discards it. */
  end(discardQueued = false): void {
    if (discardQueued) { this.items = []; this.bytes = 0; }
    this.ended = true;
    if (this.waiter) { this.waiter.resolve({ done: true, value: undefined }); this.waiter = undefined; }
  }
  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true; this.failure = error; this.items = []; this.bytes = 0;
    if (this.waiter) { this.waiter.reject(error); this.waiter = undefined; }
  }
  get size(): number { return this.items.length; }
  get queuedBytes(): number { return this.bytes; }
}
