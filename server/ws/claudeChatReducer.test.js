// The "common format" check: the chat view's live reducer
// (client/src/components/chat/chatReducer.js, written against opencode's
// events) rebuilds a Claude Code conversation from the claude-chat-adapter's
// events into the same messages the adapter itself serves from its store --
// so what streams in and what a reload shows agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { applyMessageEvent, lastAssistantRunning, toolSummary, toolText } from '../../client/src/components/chat/chatReducer.js';

const require = createRequire(import.meta.url);
const { ClaudeChatSession } = require('claude-chat-adapter');
const FIXTURES = join(dirname(require.resolve('claude-chat-adapter/package.json')), 'test', 'fixtures');

function replay(name) {
  const session = new ClaudeChatSession({ sessionID: 'ses', write: () => {} });
  let live = [];
  session.on('event', (event) => {
    // What useOpencodeChat does: delivered messages are fetched by id, the
    // rest goes through the reducer.
    if (event.type === 'session.inbox.delivered') {
      live = [...live, structuredClone(session.store.get(event.data.inboxID))];
      return;
    }
    live = applyMessageEvent(live, event);
  });
  for (const line of readFileSync(join(FIXTURES, name), 'utf-8').trim().split('\n')) session.ingest(JSON.parse(line));
  return { live, stored: session.messages() };
}

// The parts a view renders: type, text, and each tool's name/status/input/output.
function view(messages) {
  return messages.map((m) => ({
    type: m.type,
    text: m.text,
    parts: (m.content || []).filter((p) => p.type !== 'text' || p.text).map((p) => (p.type === 'tool'
      ? { tool: p.name, status: p.state.status, input: p.state.input, output: toolText(p.state.content), error: p.state.error?.message }
      : { [p.type]: p.text })),
  }));
}

for (const name of ['tool-permission.jsonl', 'ask-user-question.jsonl', 'interrupt.jsonl', 'set-model.jsonl']) {
  test(`chatReducer rebuilds the adapter's conversation: ${name}`, () => {
    const { live, stored } = replay(name);
    assert.deepEqual(view(live), view(stored));
    assert.equal(lastAssistantRunning(live), false, 'the finished turn is not shown as running');
  });
}

test('tool summaries read Claude Code\'s snake_case inputs', () => {
  assert.equal(toolSummary('Write', { file_path: '/w/a.txt', content: 'x' }), '/w/a.txt');
  assert.equal(toolSummary('Bash', { command: 'ls', description: 'list' }), 'ls');
});
