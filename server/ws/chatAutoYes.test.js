import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoApproveChatPermission, autoApprovePendingChatPermissions } from './sessionManager.js';

function fakeSession({ autoYes = true } = {}) {
  const sent = [];
  return {
    id: 's1',
    autoYes,
    autoYesLog: [],
    chat: { ready: true, ocSessionId: 'ses1' },
    socket: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) },
    viewers: new Set(),
    sent,
  };
}

test('an auto-approved chat request is logged and broadcast', async () => {
  const session = fakeSession();
  const replies = [];
  const ok = await autoApproveChatPermission(session, { id: 'p1', action: 'bash', resources: ['ls'] }, {
    reply: async (_chat, id, decision) => { replies.push([id, decision]); return true; },
  });
  assert.equal(ok, true);
  assert.deepEqual(replies, [['p1', 'once']]);
  assert.equal(session.autoYesLog.length, 1);
  assert.equal(session.autoYesLog[0].prompt, 'bash ls');
  assert.equal(session.sent.at(-1).type, 'auto_yes');
});

test('a failed reply is not logged', async () => {
  const session = fakeSession();
  const ok = await autoApproveChatPermission(session, { id: 'p1' }, { reply: async () => false });
  assert.equal(ok, false);
  assert.equal(session.autoYesLog.length, 0);
});

test('turning Auto-Y on answers waiting tool requests but not a plan approval', async () => {
  const session = fakeSession();
  const replied = [];
  const n = await autoApprovePendingChatPermissions(session, {
    pending: async () => [{ id: 'p1', action: 'bash' }, { id: 'plan', plan: '# plan' }],
    reply: async (_chat, id) => { replied.push(id); return true; },
  });
  assert.equal(n, 1);
  assert.deepEqual(replied, ['p1']);
});

test('nothing is answered while Auto-Y is off', async () => {
  const session = fakeSession({ autoYes: false });
  const n = await autoApprovePendingChatPermissions(session, {
    pending: async () => [{ id: 'p1' }],
    reply: async () => { throw new Error('must not reply'); },
  });
  assert.equal(n, 0);
});
