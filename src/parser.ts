import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { ResyncError } from './protocol.js';

/** Counts wire bytes between blank lines, including CRLF split across chunks. */
class FrameLimit {
  private bytes = 0;
  private lineBytes = 0;
  private pendingCR = false;
  private pendingEnd = false;
  constructor(private readonly maximum: number) {}
  feed(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.pendingCR) {
        this.pendingCR = false;
        if (byte === 10) {
          this.add();
          if (this.pendingEnd) this.bytes = 0;
          this.pendingEnd = false;
          continue;
        }
        if (this.pendingEnd) this.bytes = 0;
        this.pendingEnd = false;
      }
      this.add();
      if (byte === 13) {
        this.pendingCR = true; this.pendingEnd = this.lineBytes === 0; this.lineBytes = 0;
      } else if (byte === 10) {
        if (this.lineBytes === 0) this.bytes = 0;
        this.lineBytes = 0;
      } else { this.lineBytes++; }
    }
  }
  private add(): void { if (++this.bytes > this.maximum) throw new ResyncError('frame-too-large'); }
}

/** Bounded UTF-8 decoding plus an established SSE parser; incomplete EOF frames are discarded. */
export function createWireParser(maxFrameBytes: number, onEvent: (event: EventSourceMessage) => void,
  onRetry: (milliseconds: number) => void): { feed: (bytes: Uint8Array) => void; end: () => void } {
  const limit = new FrameLimit(maxFrameBytes);
  const decoder = new TextDecoder('utf-8');
  const parser = createParser({
    maxBufferSize: maxFrameBytes, onEvent, onRetry,
    onError(error) { if (error.type === 'max-buffer-size-exceeded') throw new ResyncError('frame-too-large'); },
  });
  return {
    feed(bytes) {
      // Keep parser feed calls bounded even when fetch returns a large buffered chunk.
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        const part = bytes.subarray(offset, offset + 4096);
        limit.feed(part); parser.feed(decoder.decode(part, { stream: true }));
      }
    },
    end() { parser.feed(decoder.decode()); parser.reset(); },
  };
}
