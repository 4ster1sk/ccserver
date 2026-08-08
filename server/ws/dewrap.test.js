import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dewrapSelection } from '../../client/src/dewrap.js';

test('rejoins a hard-wrapped paragraph with 2-space continuation indent', () => {
  const raw = [
    'TCP, or Transmission Control Protocol, is one of the core protocols of the Internet',
    '  Protocol suite that governs how data is exchanged reliably between two devices over a',
    '  network; unlike the simpler UDP, it establishes a connection through a handshake process',
    '  before any data is sent, then breaks the data into ordered segments, tracks each one with',
    '  sequence numbers, waits for acknowledgments from the receiving end, and retransmits',
    '  anything that gets lost or corrupted along the way, while also managing the pace of',
    '  transmission to avoid overwhelming the network or the receiver; this makes it well suited',
    '  to applications like web browsing, email, and file transfer, where the accuracy and',
    '  completeness of the data matter more than raw speed, and it stands in contrast to protocols',
    '  that sacrifice reliability for lower latency.',
  ].join('\n');
  const result = dewrapSelection(raw, 93);
  assert.equal(result.includes('\n'), false);
  assert.ok(result.startsWith('TCP, or Transmission Control Protocol'));
  assert.ok(result.endsWith('that sacrifice reliability for lower latency.'));
  // The continuation indent must not leak into the middle of the sentence.
  assert.equal(result.includes('  '), false);
});

test('leaves box-drawing rows (banner UI) untouched', () => {
  const raw = [
    '│                                                    │ Tips for getting started             │',
    '│                 Welcome back NNKK!                 │ Run /init to create a CLAUDE.md fil… │',
  ].join('\n');
  assert.equal(dewrapSelection(raw, 93), raw);
});

test('does not merge markdown bullet list items', () => {
  const raw = [
    '- First item that is reasonably long to approach the width limit maybe not quite',
    '- Second item',
    '- Third item here',
  ].join('\n');
  assert.equal(dewrapSelection(raw, 93), raw);
});

test('does not merge numbered list items', () => {
  const raw = [
    '1. First numbered item that goes on for a while to approach the width threshold ok',
    '2. Second numbered item',
  ].join('\n');
  assert.equal(dewrapSelection(raw, 93), raw);
});

test('preserves a blank line between two separate paragraphs', () => {
  const raw = [
    'This is the first paragraph and it goes on for quite a while to reach near the width',
    '  limit before it finally ends right here.',
    '',
    'This is the second paragraph, entirely separate from the first one above it.',
  ].join('\n');
  const result = dewrapSelection(raw, 93);
  const paras = result.split('\n\n');
  assert.equal(paras.length, 2);
  assert.ok(paras[0].startsWith('This is the first paragraph'));
  assert.ok(paras[0].endsWith('right here.'));
  assert.equal(paras[1], 'This is the second paragraph, entirely separate from the first one above it.');
});

test('a short line (not pushed to the width) is treated as a deliberate break', () => {
  const raw = 'short line\n  next line';
  assert.equal(dewrapSelection(raw, 93), raw);
});

test('strips a shared leading indent across the whole selection', () => {
  const raw = '    line one\n    line two\n    line three';
  assert.equal(dewrapSelection(raw, 93), 'line one\nline two\nline three');
});

test('empty/short input passes through unchanged', () => {
  assert.equal(dewrapSelection('', 93), '');
  assert.equal(dewrapSelection('single line', 93), 'single line');
});
