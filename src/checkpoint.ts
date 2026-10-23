import { scopeKey, validateCursor, type StreamScope } from './protocol.js';

/** Implementations must honor cancellation before committing and settle pending operations. */
export interface CheckpointStore {
  load(scope: StreamScope, signal: AbortSignal): Promise<string | undefined>;
  save(scope: StreamScope, cursor: string, signal: AbortSignal): Promise<void>;
  clear(scope: StreamScope, signal: AbortSignal): Promise<void>;
}
/** Session-independent but process-local checkpoint map, with account/stream isolation. */
export class MemoryCheckpointStore implements CheckpointStore {
  private values = new Map<string, string>();
  async load(scope: StreamScope, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted(); return this.values.get(scopeKey(scope));
  }
  async save(scope: StreamScope, cursor: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.values.set(scopeKey(scope), validateCursor(cursor));
  }
  async clear(scope: StreamScope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.values.delete(scopeKey(scope));
  }
}
/** Small cursor-only adapter. Storage exceptions are surfaced, never silently ignored. */
export class LocalStorageCheckpointStore implements CheckpointStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly prefix = 'browser-sse-relay:v1:') {}
  async load(scope: StreamScope, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    const value = this.storage.getItem(this.prefix + scopeKey(scope));
    return value === null ? undefined : validateCursor(value);
  }
  async save(scope: StreamScope, cursor: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.storage.setItem(this.prefix + scopeKey(scope), validateCursor(cursor));
  }
  async clear(scope: StreamScope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.storage.removeItem(this.prefix + scopeKey(scope));
  }
}
