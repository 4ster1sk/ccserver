import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb } from './db.js';
import { setSetting } from './settingsStore.js';
import { getChatDefaultModel, normalizeChatModel, setChatDefaultModel } from './chatDefaults.js';

let tmpRoot;
const savedDbPath = process.env.CCSERVER_DB_PATH;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-chat-defaults-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
});

after(() => {
  closeDb();
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedDbPath;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().prepare('DELETE FROM settings').run();
});

test('normalizeChatModel keeps a model ref and drops anything else', () => {
  assert.deepEqual(normalizeChatModel({ providerID: 'anthropic', id: 'opus', variant: 'high', extra: 1 }), { providerID: 'anthropic', id: 'opus', variant: 'high' });
  assert.deepEqual(normalizeChatModel({ providerID: 'anthropic', id: 'opus' }), { providerID: 'anthropic', id: 'opus' });
  assert.equal(normalizeChatModel(null), null);
  assert.equal(normalizeChatModel('anthropic/opus'), null);
  assert.equal(normalizeChatModel({ providerID: '', id: 'opus' }), null);
  assert.equal(normalizeChatModel({ providerID: 'a', id: 'x'.repeat(201) }), null);
  assert.equal(normalizeChatModel({ providerID: 'a', id: 'b', variant: 3 }), null);
});

test('the default is recorded per app', () => {
  assert.equal(getChatDefaultModel('claude'), null);
  assert.equal(setChatDefaultModel('claude', { providerID: 'anthropic', id: 'sonnet', variant: 'low' }), true);
  assert.equal(setChatDefaultModel('opencode', { providerID: 'openai', id: 'gpt' }), true);
  assert.deepEqual(getChatDefaultModel('claude'), { providerID: 'anthropic', id: 'sonnet', variant: 'low' });
  assert.deepEqual(getChatDefaultModel('opencode'), { providerID: 'openai', id: 'gpt' });
  // The last pick wins.
  setChatDefaultModel('claude', { providerID: 'anthropic', id: 'opus', variant: 'high' });
  assert.deepEqual(getChatDefaultModel('claude'), { providerID: 'anthropic', id: 'opus', variant: 'high' });
});

test('invalid models and other apps record nothing', () => {
  assert.equal(setChatDefaultModel('claude', { id: 'opus' }), false);
  assert.equal(setChatDefaultModel('codex', { providerID: 'openai', id: 'gpt' }), false);
  assert.equal(getChatDefaultModel('claude'), null);
  assert.equal(getChatDefaultModel('codex'), null);
});

test('a corrupted stored value reads as no default', () => {
  setSetting('global', '', 'chat.defaultModel.claude', { id: 42 });
  assert.equal(getChatDefaultModel('claude'), null);
});
