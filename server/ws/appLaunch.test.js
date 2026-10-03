import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPS,
  isValidApp,
  appDisplayName,
  appResumeArgs,
  appModelArgs,
  appLaunchArgs,
  appSubmitKey,
  extractResumeSessionId,
  detectPermissionPrompt,
} from './appLaunch.js';

test('only Claude Code, opencode and Codex are launchable apps', () => {
  assert.deepEqual(APPS, ['claude', 'opencode', 'codex']);
  for (const app of APPS) assert.equal(isValidApp(app), true);
  for (const app of ['copilot', 'commandcode', 'unknown']) assert.equal(isValidApp(app), false);
  assert.equal(appDisplayName('claude'), 'Claude Code');
  assert.equal(appDisplayName('opencode'), 'opencode');
  assert.equal(appDisplayName('codex'), 'OpenAI Codex');
});

test('supported apps retain their resume arguments', () => {
  assert.deepEqual(appResumeArgs('claude', 'abc123'), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('claude', null, { resumeLast: true }), ['--continue']);
  assert.deepEqual(appResumeArgs('opencode', null, { resumeLast: true }), ['-c']);
  assert.deepEqual(appResumeArgs('codex', null, { resumeLast: true }), ['resume', '--last']);
});

test('model arguments are limited to supported CLIs and safe values', () => {
  assert.deepEqual(appModelArgs('opencode', 'openai/gpt-5'), ['--model', 'openai/gpt-5']);
  assert.deepEqual(appModelArgs('codex', 'gpt-5'), ['--model', 'gpt-5']);
  assert.deepEqual(appModelArgs('codex', '--dangerous'), []);
});

test('combined launch arguments contain no removed-app flags', () => {
  assert.deepEqual(appLaunchArgs('codex', { resumeLast: true, model: 'gpt-5' }), [
    'resume', '--last', '--model', 'gpt-5',
  ]);
});

test('resume ids, submit keys and permission prompts remain supported', () => {
  assert.equal(extractResumeSessionId('claude', 'claude --resume abc123'), 'abc123');
  assert.equal(extractResumeSessionId('opencode', 'opencode -c'), null);
  assert.equal(extractResumeSessionId('codex', 'codex resume --last'), null);
  assert.equal(appSubmitKey('claude'), '\r');
  assert.equal(detectPermissionPrompt('claude', 'Doyouwanttoproceed?'), true);
  assert.equal(detectPermissionPrompt('opencode', 'Permissionrequired'), true);
  assert.equal(detectPermissionPrompt('codex', 'Wouldyouliketorunthefollowingcommand?1.Yes,proceed(y)'), true);
});
