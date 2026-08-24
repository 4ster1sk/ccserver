// LineFramer coverage against a minimal fake socket (an EventEmitter with the
// handful of net.Socket/tls.TLSSocket members LineFramer actually touches:
// .on('data', ...), .write(), .destroyed, .writableEnded, .destroy()). No
// real TLS/network needed -- federationServer.test.js / federationClient
// integration paths cover the real-socket wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LineFramer, MAX_LINE_BYTES } from './federationProtocol.js';

function fakeSocket() {
  const emitter = new EventEmitter();
  emitter.written = [];
  emitter.destroyed = false;
  emitter.writableEnded = false;
  emitter.write = (data) => { emitter.written.push(data); return true; };
  emitter.destroy = () => { emitter.destroyed = true; };
  return emitter;
}

test('feeds one JSON object per newline-delimited line', () => {
  const socket = fakeSocket();
  const lines = [];
  new LineFramer(socket, { onLine: (l) => lines.push(l) });
  socket.emit('data', Buffer.from('{"a":1}\n{"a":2}\n'));
  assert.deepEqual(lines, [{ a: 1 }, { a: 2 }]);
});

test('reassembles a line split across multiple chunks', () => {
  const socket = fakeSocket();
  const lines = [];
  new LineFramer(socket, { onLine: (l) => lines.push(l) });
  socket.emit('data', Buffer.from('{"a":'));
  socket.emit('data', Buffer.from('1}\n'));
  assert.deepEqual(lines, [{ a: 1 }]);
});

test('a single write() can carry multiple frames spanning earlier partial data', () => {
  const socket = fakeSocket();
  const lines = [];
  new LineFramer(socket, { onLine: (l) => lines.push(l) });
  socket.emit('data', Buffer.from('{"a":1}\n{"b":'));
  socket.emit('data', Buffer.from('2}\n{"c":3}\n'));
  assert.deepEqual(lines, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('blank lines between frames are ignored', () => {
  const socket = fakeSocket();
  const lines = [];
  new LineFramer(socket, { onLine: (l) => lines.push(l) });
  socket.emit('data', Buffer.from('{"a":1}\n\n\n{"a":2}\n'));
  assert.deepEqual(lines, [{ a: 1 }, { a: 2 }]);
});

test('malformed JSON on one line is reported via onError and does not desync framing', () => {
  const socket = fakeSocket();
  const lines = [];
  const errors = [];
  new LineFramer(socket, { onLine: (l) => lines.push(l), onError: (e) => errors.push(e) });
  socket.emit('data', Buffer.from('not json\n{"a":1}\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /invalid federation frame JSON/);
  assert.deepEqual(lines, [{ a: 1 }]);
});

test('a buffered line beyond MAX_LINE_BYTES reports onError and destroys the socket', () => {
  const socket = fakeSocket();
  const errors = [];
  new LineFramer(socket, { onError: (e) => errors.push(e) });
  socket.emit('data', Buffer.alloc(MAX_LINE_BYTES + 1, 'a'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exceeded max line size/);
  assert.equal(socket.destroyed, true);
});

test('write() serializes an object as one newline-terminated JSON line', () => {
  const socket = fakeSocket();
  const framer = new LineFramer(socket, {});
  const ok = framer.write({ v: 1, kind: 'rpc', id: 'x' });
  assert.equal(ok, true);
  assert.equal(socket.written[0], '{"v":1,"kind":"rpc","id":"x"}\n');
});

test('write() is a safe no-op once the socket is destroyed', () => {
  const socket = fakeSocket();
  const framer = new LineFramer(socket, {});
  socket.destroyed = true;
  const ok = framer.write({ a: 1 });
  assert.equal(ok, false);
  assert.equal(socket.written.length, 0);
});
