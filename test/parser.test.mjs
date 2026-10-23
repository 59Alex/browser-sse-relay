import test from 'node:test';
import assert from 'node:assert/strict';
import { createWireParser } from '../dist/parser.js';
import { ResyncError } from '../dist/index.js';

const encoder = new TextEncoder();
test('UTF-8 fragments, BOM, CRLF split, CR, multiline, comments, retry and unknown fields', () => {
  const messages = [], retries = [];
  const parser = createWireParser(1024, frame => messages.push(frame), value => retries.push(value));
  const bytes = encoder.encode('\ufeff: heartbeat\r\nretry: 17\r\nretry: nope\r\nunknown: ignored\r\nid: opaque/A\r\nevent: update\r\ndata: Привет 🌍\r\ndata: second\r\n\r\ndata: third\rid: next\r\r');
  for (const byte of bytes) parser.feed(Uint8Array.of(byte));
  parser.end();
  assert.deepEqual(messages, [{ id: 'opaque/A', event: 'update', data: 'Привет 🌍\nsecond' }, { id: 'next', event: undefined, data: 'third' }]);
  assert.deepEqual(retries, [17]);
});
test('EOF without a blank line never creates an application event', () => {
  const messages = []; const parser = createWireParser(100, value => messages.push(value), () => {});
  parser.feed(encoder.encode('id: x\ndata: unfinished')); parser.end();
  assert.deepEqual(messages, []);
});
test('wire limits include unrecognized lines, comments, and partial frames', () => {
  for (const input of [': ' + 'x'.repeat(64), 'unknown: ' + 'x'.repeat(64), 'data: ' + 'x'.repeat(64)]) {
    const parser = createWireParser(32, () => {}, () => {});
    assert.throws(() => parser.feed(encoder.encode(input)), ResyncError);
  }
});
test('CRLF wire bytes count correctly at the exact frame bound across chunks', () => {
  const frame = encoder.encode('id: x\r\ndata: y\r\n\r\n');
  const events = []; const exact = createWireParser(frame.length, item => events.push(item), () => {});
  for (const byte of frame) exact.feed(Uint8Array.of(byte));
  assert.equal(events.length, 1);
  const tooSmall = createWireParser(frame.length - 1, () => {}, () => {});
  assert.throws(() => { for (const byte of frame) tooSmall.feed(Uint8Array.of(byte)); }, ResyncError);
});
test('id-only blocks do not leak transport positions into the next application message', () => {
  const events = []; const parser = createWireParser(1024, item => events.push(item), () => {});
  parser.feed(encoder.encode('id: ignored\n\ndata: missing-own-id\n\n')); parser.end();
  assert.equal(events[0].id, undefined);
});
