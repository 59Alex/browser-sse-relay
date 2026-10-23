/** Identity and checkpoint namespace. The account must come from authenticated application state. */
export interface StreamScope { readonly accountId: string; readonly streamId: string }
export interface RelayEvent { readonly id: string; readonly event: string; readonly data: string }
export const PROTOCOL_VERSION = 1;
export const encoder = new TextEncoder();

export function scopeKey(scope: StreamScope): string {
  for (const value of [scope.accountId, scope.streamId]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f]/u.test(value)) {
      throw new TypeError('Scope identifiers must contain 1..256 non-control characters');
    }
  }
  return JSON.stringify([scope.accountId, scope.streamId]);
}
export function sameScope(a: StreamScope, b: StreamScope): boolean {
  return a.accountId === b.accountId && a.streamId === b.streamId;
}
/** Printable ASCII is required for the HTTP Last-Event-ID header; contents remain opaque. */
export function validateCursor(cursor: string): string {
  if (typeof cursor !== 'string' || !/^[\x21-\x7e]{1,1024}$/u.test(cursor)) {
    throw new TypeError('Cursor must be 1..1024 printable ASCII characters without spaces');
  }
  return cursor;
}
export function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError(`Invalid ${name}`);
  return value;
}
export class ResyncError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'ResyncError'; }
}
export class ProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'ProtocolError'; }
}
export function encodeFrame(event: string, data: string, id?: string): string {
  if (!event || event.length > 128 || /[\r\n\u0000]/u.test(event)) throw new TypeError('Invalid event type');
  if (id !== undefined) validateCursor(id);
  // Normalize all newline forms into separate data fields, preserving trailing and empty lines.
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\n${data.split(/\r\n|\r|\n/u).map(line => `data: ${line}\n`).join('')}\n`;
}
export function controlFrame(event: string, data: unknown): string { return encodeFrame(event, JSON.stringify(data)); }
