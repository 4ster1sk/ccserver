import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStage, chatStageIds, failCurrentStage, formatStageMarker, initialChatStages, parseStageMarkers } from './chatStages.js';

test('chatStageIds: VM stages only for a qemu VM booted for the session', () => {
  assert.deepEqual(chatStageIds({ sandboxed: false, backend: null }), ['agent', 'session']);
  assert.deepEqual(chatStageIds({ sandboxed: true, backend: 'bwrap' }), ['sandbox', 'agent', 'session']);
  assert.deepEqual(chatStageIds({ sandboxed: true, backend: 'qemu' }), ['sandbox', 'vm_boot', 'vm_setup', 'agent', 'session']);
  assert.deepEqual(chatStageIds({ sandboxed: true, backend: 'qemu', pooled: true }), ['sandbox', 'agent', 'session']);
});

test('applyStage: a running stage closes every earlier unfinished one', () => {
  const stages = initialChatStages(['sandbox', 'vm_boot', 'vm_setup', 'agent']);
  assert.equal(applyStage(stages, 'vm_boot', 'running', null, 1000), true);
  assert.equal(stages[0].state, 'done');
  assert.equal(stages[1].state, 'running');
  assert.equal(stages[1].startedAt, 1000);
  applyStage(stages, 'agent', 'running', null, 5000);
  assert.deepEqual(stages.map((s) => s.state), ['done', 'done', 'done', 'running']);
  assert.equal(stages[1].endedAt, 5000);
});

test('applyStage: unknown ids and repeats are no-ops', () => {
  const stages = initialChatStages(['agent']);
  assert.equal(applyStage(stages, 'vm_boot', 'running'), false);
  assert.equal(applyStage(stages, 'agent', 'running'), true);
  assert.equal(applyStage(stages, 'agent', 'running'), false);
  assert.equal(applyStage(stages, 'agent', 'bogus'), false);
});

test('failCurrentStage marks the first unfinished stage, and nothing once all are done', () => {
  const stages = initialChatStages(['sandbox', 'agent', 'session']);
  applyStage(stages, 'sandbox', 'done');
  assert.equal(failCurrentStage(stages, 'boom'), true);
  assert.equal(stages[1].state, 'error');
  assert.equal(stages[1].message, 'boom');
  const done = initialChatStages(['agent']);
  applyStage(done, 'agent', 'done');
  assert.equal(failCurrentStage(done, 'late'), false);
});

test('parseStageMarkers round-trips formatStageMarker, ignoring other output', () => {
  const text = `log line\r\n${formatStageMarker('vm_boot', 'running')}more${formatStageMarker('vm_setup', 'error', 'mount;failed\nhere')}\x1b]777;notify;t;b\x07`;
  const markers = parseStageMarkers(text);
  assert.deepEqual(markers.map(({ id, state, message }) => ({ id, state, message })), [
    { id: 'vm_boot', state: 'running', message: null },
    { id: 'vm_setup', state: 'error', message: 'mount failed here' },
  ]);
});
