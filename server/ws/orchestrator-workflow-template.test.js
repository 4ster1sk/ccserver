// Oracle test for the orchestrator injection template and the control MCP
// tool descriptions: the read_output discipline (wait_for_handoff-first,
// anomaly-gated single reads) and the Vikunja task start report must be
// spelled out where the orchestrator actually sees them. Read-only on
// purpose: groupManager.test.js owns a runtime copy of the template and
// edits that, so this suite only asserts markers in the real repo-tracked
// files and never writes or env-swaps them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const template = readFileSync(join(import.meta.dirname, 'orchestrator-template.md'), 'utf-8');
const mcpServerSource = readFileSync(join(import.meta.dirname, 'mcpServer.js'), 'utf-8');

test('template: read_output is framed as not-a-progress-check with wait_for_handoff as the default', () => {
  assert.match(template, /read_output[^\n]*\n?[^\n]*NOT your progress check/);
  assert.match(template, /normal progress is confirmed by waiting\s*\n\s*on wait_for_handoff/);
  assert.match(template, /avoid polling it/);
});

test('template: turn pattern forbids peeking while a handoff is pending', () => {
  assert.match(template, /do not peek at the worker with read_output -- wait_for_handoff\s*\n\s+IS your progress check/);
});

test('template: handoff discipline gates read_output behind concrete anomaly signals', () => {
  assert.match(template, /anomaly-driven, single-shot confirmation justified only by a concrete\s*\n\s+signal/);
  // The three allowed triggers are all listed.
  assert.match(template, /repeated `wait_for_handoff` timeouts \(rough guide: 2-3 consecutive\)/);
  assert.match(template, /a specific anomaly from `list_group_sessions` \/ `get_tab_status`/);
  assert.match(template, /the worker itself reporting trouble\./);
  // Even when justified: one read, then act.
  assert.match(template, /When one of those fires, read ONCE:/);
  assert.match(template, /nudge it via\s*\n\s+`send_input` \("done\? call handoff_to_orchestrator"\)/);
  // The old opportunistic-read habit is explicitly retired.
  assert.match(template, /action opportunity \(a new user message, another worker's handoff, \.\.\.\)\s*\n\s+to judge whether a pending worker is idle is retired/);
  // Timeouts alone are normal and safe to retry.
  assert.match(template, /timeouts alone are not a reason\s*\n\s+to intervene/);
});

test('template: notification discipline requires exactly one start-of-task notify(info)', () => {
  assert.match(template, /- \*\*Starting\*\*: when you take on a NEW task from the human, open it with\s*\n\s+exactly ONE `notify` call BEFORE dispatching any work to the workers:/);
  assert.match(template, /level: 'info' ?\}\)/);
  assert.match(template, /once-per-task report,\s*\n\s+not a status update -- do not repeat it mid-task/);
  // Why it matters: the first info notification creates the Vikunja tracking task.
  assert.match(template, /this first `info` notification automatically creates\s*\n\s+the group's Vikunja tracking task \(labeled `status-running`\)/);
  assert.match(template, /final Done\s*\n\s+notification \(`level: 'success'`\) closes it out as done/);
  assert.match(template, /skipping\s*\n\s+the start report means the whole task goes untracked in Vikunja/);
});

test('mcpServer.js: read_output description states the discipline, status tools gate confirmation', () => {
  assert.match(mcpServerSource, /fallback for inspecting a possibly-stuck member, NOT a progress-check tool/);
  assert.match(mcpServerSource, /Justify every call with a concrete anomaly signal \(repeated wait_for_handoff timeouts/);
  assert.match(mcpServerSource, /never poll this for reassurance/);
  assert.match(mcpServerSource, /treat that as an anomaly signal only: if it piles up alongside repeated wait_for_handoff timeouts, confirm with a single read_output/);
  assert.match(mcpServerSource, /treat it as an anomaly signal and confirm with at most a single read_output/);
  // wait_for_handoff stays the once-per-turn default.
  assert.match(mcpServerSource, /Call this once per turn instead of polling read_output/);
});
