import type { EventSourceMessage } from 'eventsource-parser';
import type { CheckpointStore } from './checkpoint.js';
import { createWireParser } from './parser.js';
import { BoundedQueue } from './queue.js';
import { encoder, positiveInteger, timerDuration, ProtocolError, ResyncError, sameScope, scopeKey, validateCursor,
  type RelayEvent, type StreamScope } from './protocol.js';

export type RelayState = 'idle' | 'connecting' | 'replaying' | 'live' | 'waiting' | 'authenticating' | 'resync' | 'failed' | 'closed';
export interface RelayContext { readonly scope: StreamScope; readonly signal: AbortSignal; readonly attempt: number; isCurrent(): boolean }
export interface RelayResult {
  readonly state: 'resync' | 'failed' | 'closed'; readonly reason: string;
  readonly cursor: string | undefined; readonly error?: unknown;
}
export interface RelayOptions {
  scope: StreamScope;
  url: string | ((context: RelayContext) => string | Promise<string>);
  onEvent: (event: RelayEvent, context: RelayContext) => void | Promise<void>;
  headers?: HeadersInit | ((context: RelayContext) => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
  checkpoint?: CheckpointStore;
  /** Position of an already-applied application snapshot; overrides a loaded checkpoint. */
  initialCursor?: string;
  signal?: AbortSignal;
  onState?: (state: RelayState, detail: { attempt: number; cursor: string | undefined }) => void;
  refreshAuth?: (context: RelayContext) => boolean | Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  /** Timeout waiting for HTTP response headers. */
  connectTimeoutMs?: number;
  /** Timeout without incoming bytes; server heartbeats keep a healthy idle stream alive. */
  idleTimeoutMs?: number;
  retry?: { maxAttempts?: number; minDelayMs?: number; maxDelayMs?: number; jitter?: number };
  limits?: { maxFrameBytes?: number; maxQueuedEvents?: number; maxQueuedBytes?: number; dedupEntries?: number };
  /** Injectable only to make jitter deterministic in tests. Must return a number in [0, 1]. */
  random?: () => number;
}
class RetryableError extends Error {
  constructor(message: string, readonly hint?: number, options?: ErrorOptions) { super(message, options); }
}
class AuthenticationError extends Error {}
class ServerClosed extends Error {}

/** A one-shot account-scoped SSE recovery session. Create a new instance after a terminal result. */
export class SseRelayClient {
  readonly scope: StreamScope;
  private readonly controller = new AbortController();
  private readonly options: RelayOptions;
  private readonly limits: Required<NonNullable<RelayOptions['limits']>>;
  private readonly retry: Required<NonNullable<RelayOptions['retry']>>;
  private runPromise: Promise<RelayResult> | undefined;
  private currentState: RelayState = 'idle';
  private cursor: string | undefined;
  private attempt = 0;
  private retryHint: number | undefined;
  private readonly committedIds = new Set<string>();
  private externalAbort: (() => void) | undefined;

  constructor(options: RelayOptions) {
    scopeKey(options.scope);
    if (typeof options.onEvent !== 'function') throw new TypeError('onEvent is required');
    if (options.initialCursor !== undefined) validateCursor(options.initialCursor);
    this.scope = Object.freeze({ ...options.scope });
    this.options = { ...options, scope: this.scope };
    this.limits = { maxFrameBytes: 65536, maxQueuedEvents: 128, maxQueuedBytes: 1048576, dedupEntries: 1024, ...options.limits };
    this.retry = { maxAttempts: 8, minDelayMs: 250, maxDelayMs: 10000, jitter: 0.2, ...options.retry };
    for (const [key, value] of Object.entries(this.limits)) positiveInteger(value, key, key === 'dedupEntries');
    timerDuration(options.connectTimeoutMs ?? 10000, 'connectTimeoutMs');
    timerDuration(options.idleTimeoutMs ?? 45000, 'idleTimeoutMs');
    positiveInteger(this.retry.maxAttempts, 'maxAttempts');
    timerDuration(this.retry.minDelayMs, 'minDelayMs', true);
    timerDuration(this.retry.maxDelayMs, 'maxDelayMs', true);
    if (this.retry.maxDelayMs < this.retry.minDelayMs || this.retry.jitter < 0 || this.retry.jitter > 1 || !Number.isFinite(this.retry.jitter)) {
      throw new TypeError('Invalid retry range');
    }
    if (options.signal) {
      this.externalAbort = () => this.stop();
      if (options.signal.aborted) this.stop();
      else options.signal.addEventListener('abort', this.externalAbort, { once: true });
    }
  }

  get state(): RelayState { return this.currentState; }
  get committedCursor(): string | undefined { return this.cursor; }
  get dedupSize(): number { return this.committedIds.size; }

  /** Resolves with a terminal result; ordinary network/handler/checkpoint failures consume retry budget. */
  start(): Promise<RelayResult> {
    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }
  /** Stops transport and future callbacks. A running handler must cooperate with its signal. */
  stop(): void {
    this.controller.abort();
    if (this.options.signal && this.externalAbort) {
      this.options.signal.removeEventListener('abort', this.externalAbort);
      this.externalAbort = undefined;
    }
  }
  /** Waits for in-flight work to settle, then removes this account/stream checkpoint. Await before reusing its scope. */
  async logout(): Promise<void> {
    this.stop();
    if (this.runPromise) await this.runPromise;
    this.committedIds.clear(); this.cursor = undefined;
    await this.options.checkpoint?.clear(this.scope, new AbortController().signal);
  }
  private check(): void { this.controller.signal.throwIfAborted(); }
  private context(): RelayContext {
    return { scope: this.scope, signal: this.controller.signal, attempt: this.attempt,
      isCurrent: () => !this.controller.signal.aborted && !['closed', 'failed', 'resync'].includes(this.currentState) };
  }
  private stateTo(state: RelayState): void {
    this.currentState = state;
    try { this.options.onState?.(state, { attempt: this.attempt, cursor: this.cursor }); }
    catch { /* Observability callbacks do not participate in processing or cursor commits. */ }
  }
  private finish(state: RelayResult['state'], reason: string, error?: unknown): RelayResult {
    this.stateTo(state);
    return { state, reason, cursor: this.cursor, ...(error === undefined ? {} : { error }) };
  }
  private async run(): Promise<RelayResult> {
    try {
      this.check();
      if (this.options.initialCursor !== undefined) {
        await this.options.checkpoint?.save(this.scope, this.options.initialCursor, this.controller.signal);
        this.check(); this.cursor = this.options.initialCursor;
      } else {
        const loaded = await this.options.checkpoint?.load(this.scope, this.controller.signal);
        this.check(); this.cursor = loaded === undefined ? undefined : validateCursor(loaded);
      }
      while (this.attempt < this.retry.maxAttempts) {
        this.check(); this.attempt++; this.stateTo('connecting');
        try {
          await this.connect();
          throw new RetryableError('stream-ended');
        } catch (error) {
          if (this.controller.signal.aborted) return this.finish('closed', 'stopped');
          if (error instanceof ServerClosed) return this.finish('closed', 'server-closed');
          if (error instanceof ResyncError) return this.finish('resync', error.reason, error);
          if (error instanceof ProtocolError) return this.finish('failed', 'protocol-error', error);
          if (error instanceof AuthenticationError) return this.finish('failed', 'authentication-failed', error);
          if (this.attempt >= this.retry.maxAttempts) return this.finish('failed', 'retry-exhausted', error);
          const hint = error instanceof RetryableError ? error.hint : undefined;
          this.stateTo('waiting');
          await this.wait(this.delay(hint ?? this.retryHint));
        }
      }
      return this.finish('failed', 'retry-exhausted');
    } catch (error) {
      return this.controller.signal.aborted ? this.finish('closed', 'stopped') : this.finish('failed', 'initialization-failed', error);
    } finally {
      if (this.options.signal && this.externalAbort) this.options.signal.removeEventListener('abort', this.externalAbort);
    }
  }
  private delay(hint?: number): number {
    const base = Math.min(this.retry.maxDelayMs, Math.max(this.retry.minDelayMs,
      hint ?? this.retry.minDelayMs * 2 ** Math.min(this.attempt - 1, 30)));
    const sample = (this.options.random ?? Math.random)();
    const random = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
    return Math.round(Math.min(this.retry.maxDelayMs, Math.max(this.retry.minDelayMs,
      base * (1 - this.retry.jitter + 2 * this.retry.jitter * random))));
  }
  private wait(milliseconds: number): Promise<void> {
    this.check();
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  private async connect(): Promise<void> {
    this.check();
    const context = this.context();
    const url = typeof this.options.url === 'function' ? await this.options.url(context) : this.options.url;
    this.check();
    const supplied = typeof this.options.headers === 'function' ? await this.options.headers(context) : this.options.headers;
    this.check();
    const headers = new Headers(supplied);
    headers.set('Accept', 'text/event-stream');
    // A caller-supplied header must never override the processing checkpoint.
    headers.delete('Last-Event-ID');
    if (this.cursor !== undefined) headers.set('Last-Event-ID', this.cursor);
    const request = new AbortController();
    const abort = () => request.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener('abort', abort, { once: true });
    let response: Response | undefined;
    const connectTimer = setTimeout(() => request.abort(new RetryableError('connection-timeout')), this.options.connectTimeoutMs ?? 10000);
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        method: 'GET', headers, signal: request.signal, redirect: 'error', cache: 'no-store',
        credentials: this.options.credentials ?? 'same-origin',
      });
      clearTimeout(connectTimer);
      this.check();
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 204) throw new ServerClosed();
        if (response.status === 409 || response.status === 410) throw new ResyncError('cursor-unavailable');
        if (response.status === 401) {
          if (!this.options.refreshAuth) throw new AuthenticationError('Authentication required');
          this.stateTo('authenticating');
          this.check();
          let refreshed: boolean;
          try { refreshed = await this.options.refreshAuth(this.context()); }
          catch (error) { throw new AuthenticationError('Token refresh failed', { cause: error }); }
          this.check();
          if (!refreshed) throw new AuthenticationError('Token refresh rejected');
          throw new RetryableError('authentication-refreshed', 0);
        }
        if (response.status === 403) throw new AuthenticationError('Forbidden');
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new RetryableError(`http-${response.status}`, retryAfter(response.headers.get('Retry-After')));
        }
        throw new ProtocolError(`Unexpected HTTP status ${response.status}`);
      }
      if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream'
        || response.headers.get('X-Relay-Protocol') !== '1' || !response.body) {
        throw new ProtocolError('Expected text/event-stream with X-Relay-Protocol: 1');
      }
      await this.consume(response.body, request);
    } finally {
      clearTimeout(connectTimer);
      request.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      this.controller.signal.removeEventListener('abort', abort);
    }
  }
  private async consume(body: ReadableStream<Uint8Array>, request: AbortController): Promise<void> {
    const queue = new BoundedQueue<EventSourceMessage>(this.limits.maxQueuedEvents, this.limits.maxQueuedBytes, 'client-queue-overflow');
    const reader = body.getReader();
    const abort = () => { queue.fail(this.controller.signal.reason); void reader.cancel().catch(() => undefined); };
    this.controller.signal.addEventListener('abort', abort, { once: true });
    const parser = createWireParser(this.limits.maxFrameBytes,
      frame => queue.push(frame, encoder.encode(frame.data).byteLength + encoder.encode(frame.id ?? '').byteLength + encoder.encode(frame.event ?? '').byteLength),
      milliseconds => { if (Number.isFinite(milliseconds)) this.retryHint = Math.min(this.retry.maxDelayMs, Math.max(this.retry.minDelayMs, milliseconds)); });
    const idle = () => {
      queue.fail(new RetryableError('idle-timeout'));
      void reader.cancel().catch(() => undefined);
    };
    let idleTimer = setTimeout(idle, this.options.idleTimeoutMs ?? 45000);
    const pump = (async () => {
      try {
        while (!request.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) { parser.end(); queue.end(); return; }
          clearTimeout(idleTimer);
          idleTimer = setTimeout(idle, this.options.idleTimeoutMs ?? 45000);
          parser.feed(chunk.value);
        }
        queue.end();
      } catch (error) { queue.fail(error); }
      finally { clearTimeout(idleTimer); }
    })();
    let hello = false, ready = false, watermark = '', lastReceived = '';
    try {
      while (true) {
        this.check();
        const item = await queue.next();
        this.check();
        if (item.done) return;
        const frame = item.value;
        const type = frame.event ?? 'message';
        if (type.startsWith('relay-')) {
          if (frame.id !== undefined) throw new ProtocolError('Control frames cannot carry application ids');
          const data = parseObject(frame.data);
          if (type === 'relay-resync') {
            if (!hello || typeof data.reason !== 'string') throw new ProtocolError('Invalid resync control');
            throw new ResyncError(data.reason);
          }
          if (type === 'relay-hello') {
            if (hello || data.protocol !== 1) throw new ProtocolError('Invalid hello control');
            validateScope(data.scope, this.scope);
            watermark = protocolCursor(data.watermark); lastReceived = protocolCursor(data.after);
            if (this.cursor !== undefined && this.cursor !== lastReceived) throw new ProtocolError('Server changed resume position');
            hello = true; this.stateTo('replaying'); continue;
          }
          if (type === 'relay-ready') {
            validateScope(data.scope, this.scope);
            if (!hello || ready || data.watermark !== watermark || lastReceived !== watermark) throw new ProtocolError('Invalid replay/live boundary');
            ready = true; this.stateTo('live'); continue;
          }
          throw new ProtocolError('Unknown relay control');
        }
        if (!hello) throw new ProtocolError('Application event before hello');
        if (!ready && lastReceived === watermark) throw new ProtocolError('Application event before replay-ready boundary');
        const id = protocolCursor(frame.id);
        if (!type || type.length > 128 || /[\r\n\u0000]/u.test(type)) throw new ProtocolError('Invalid event type');
        lastReceived = id;
        if (this.committedIds.has(id)) continue;
        const event = Object.freeze({ id, event: type, data: frame.data });
        try { await this.options.onEvent(event, this.context()); }
        catch (error) { throw new RetryableError('handler-failed', undefined, { cause: error }); }
        this.check();
        try { await this.options.checkpoint?.save(this.scope, id, this.controller.signal); }
        catch (error) { throw new RetryableError('checkpoint-failed', undefined, { cause: error }); }
        this.check();
        this.cursor = id;
        if (this.limits.dedupEntries > 0) {
          this.committedIds.add(id);
          while (this.committedIds.size > this.limits.dedupEntries) this.committedIds.delete(this.committedIds.values().next().value!);
        }
      }
    } finally {
      clearTimeout(idleTimer);
      request.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
      reader.releaseLock();
      this.controller.signal.removeEventListener('abort', abort);
    }
  }
}
function parseObject(text: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>; }
  catch { /* Convert JSON syntax and shape failures to one protocol error. */ }
  throw new ProtocolError('Invalid control JSON');
}
function protocolCursor(value: unknown): string {
  try { if (typeof value === 'string') return validateCursor(value); } catch { /* Report a protocol failure, not a retry. */ }
  throw new ProtocolError('Missing or invalid event cursor');
}
function validateScope(value: unknown, expected: StreamScope): void {
  if (typeof value !== 'object' || value === null || !sameScope(value as StreamScope, expected)) throw new ProtocolError('Server scope mismatch');
}
function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/u.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
