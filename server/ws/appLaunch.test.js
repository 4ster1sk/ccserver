import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPS,
  isValidApp,
  appDisplayName,
  appResumeArgs,
  extractResumeSessionId,
  detectPermissionPrompt,
} from './appLaunch.js';

const noSpace = (s) => s.replace(/\s+/g, '');

test('APPS covers both agents', () => {
  assert.deepEqual(APPS, ['claude', 'opencode']);
});

test('isValidApp accepts only known apps', () => {
  assert.ok(isValidApp('claude'));
  assert.ok(isValidApp('opencode'));
  assert.ok(!isValidApp('bogus'));
  assert.ok(!isValidApp(undefined));
  assert.ok(!isValidApp(null));
});

test('appDisplayName maps apps to labels', () => {
  assert.equal(appDisplayName('opencode'), 'opencode');
  assert.equal(appDisplayName('claude'), 'Claude Code');
  assert.equal(appDisplayName('bogus'), 'Claude Code');
});

test('appResumeArgs: claude resumes by id only', () => {
  assert.deepEqual(appResumeArgs('claude', null), []);
  assert.deepEqual(appResumeArgs('claude', 'abc123'), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('claude', 'abc123', { resumeLast: true }), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('claude', null, { resumeLast: true }), []);
});

test('appResumeArgs: opencode resumes by id or -c', () => {
  assert.deepEqual(appResumeArgs('opencode', null), []);
  assert.deepEqual(appResumeArgs('opencode', 'ses_abc'), ['--session', 'ses_abc']);
  assert.deepEqual(appResumeArgs('opencode', null, { resumeLast: true }), ['-c']);
  assert.deepEqual(appResumeArgs('opencode', 'ses_abc', { resumeLast: true }), ['--session', 'ses_abc']);
});

test('extractResumeSessionId: claude extracts the last resume id', () => {
  assert.equal(extractResumeSessionId('claude', 'Use: claude --resume abc123'), 'abc123');
  assert.equal(extractResumeSessionId('claude', 'claude -r xyz789'), 'xyz789');
  assert.equal(extractResumeSessionId('claude', 'claude --resume abc123\nclaude --resume def456'), 'def456');
  assert.equal(extractResumeSessionId('claude', 'resume with: claude --resume !@# $%^'), null);
  assert.equal(extractResumeSessionId('claude', 'nothing to see here'), null);
});

test('extractResumeSessionId: strips ANSI before matching', () => {
  const raw = '\x1b[1m\x1b[32mclaude\x1b[0m --resume \x1b[33mabc123\x1b[0m';
  assert.equal(extractResumeSessionId('claude', raw), 'abc123');
});

test('extractResumeSessionId: opencode never exposes a stream id', () => {
  assert.equal(extractResumeSessionId('opencode', 'claude --resume abc123'), null);
  assert.equal(extractResumeSessionId('opencode', 'opencode --session ses_abc'), null);
  assert.equal(extractResumeSessionId('opencode', ''), null);
});

test('detectPermissionPrompt: claude Ink prompts', () => {
  const buf = (s) => noSpace(s);
  assert.ok(detectPermissionPrompt('claude', buf('Do you want to proceed?')));
  assert.ok(detectPermissionPrompt('claude', buf('Do you want to make this edit?')));
  assert.ok(detectPermissionPrompt('claude', buf('Do you want to use the Bash tool?')));
  assert.ok(detectPermissionPrompt('claude', buf('Yes, allow')));
  assert.ok(detectPermissionPrompt('claude', buf('Claude wants to fetch content from example.com')));
  assert.ok(detectPermissionPrompt('claude', buf('Claude wants to search the web for: x')));
  assert.ok(detectPermissionPrompt('claude', buf('Claude wants to call a tool')));
  assert.ok(!detectPermissionPrompt('claude', buf('just some normal output')));
});

test('detectPermissionPrompt: opencode permission box', () => {
  const buf = (s) => noSpace(s);
  assert.ok(detectPermissionPrompt('opencode', buf('Permission required')));
  assert.ok(detectPermissionPrompt('opencode', buf('Permission required Bash(...)')));
  assert.ok(detectPermissionPrompt('opencode', buf('Allow once')));
  assert.ok(detectPermissionPrompt('opencode', buf('Allow always')));
  assert.ok(!detectPermissionPrompt('opencode', buf('just some normal output')));
});
