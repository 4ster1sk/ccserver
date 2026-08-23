import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveApp, SANDBOX_PATH } from '../server/ws/sandbox.js';

// copilot (GitHub Copilot CLI) support: single launch from the modal, and
// combo (group) refusal. copilot is not installed on every machine this suite
// runs on (plain CI runners have neither claude nor opencode), so the launch
// test skips when it can't be resolved -- same gate pattern as
// group-mcp.spec.js. The combo refusal is server-side (bwrap is a hard
// prerequisite of POST /api/groups at all).
function appResolves(app) {
  try {
    const r = resolveApp(app).command;
    if (r.startsWith('/')) return existsSync(r);
    return SANDBOX_PATH.split(':').some((dir) => dir && existsSync(join(dir, r)));
  } catch {
    return false;
  }
}
const copilotAvailable = appResolves('copilot');
const sandboxAvailable = existsSync('/usr/bin/bwrap');

test('launch modal offers GitHub Copilot and spawns a session', async ({ page }) => {
  test.skip(!copilotAvailable, 'copilot CLI not installed on this machine');
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });

  // Watch the terminal websocket from before the page loads: the session must
  // be established and either produce output (login banner / TUI / auth
  // error) or exit explicitly.
  let stream = '';
  let sawSession = false;
  let sawExit = false;
  page.on('websocket', (ws) => {
    ws.on('framereceived', (event) => {
      try {
        const msg = JSON.parse(event.payload);
        if (msg.type === 'output') stream += msg.data;
        if (msg.type === 'session') sawSession = true;
        if (msg.type === 'exit') sawExit = true;
      } catch { /* non-JSON frame */ }
    });
  });

  await page.goto('/');
  await page.locator('.open-split-caret').click();
  await page.locator('.open-menu-item', { hasText: 'GitHub Copilot' }).click();
  await page.locator('.resume-dialog .btn-primary', { hasText: '起動' }).click();

  await expect.poll(() => sawSession, { timeout: 45_000 }).toBe(true);
  // Not logged in (no ~/.config/github-copilot), the CLI prints its auth
  // instructions and exits; logged in, the TUI draws. Either way the session
  // must produce output or terminate -- never sit silently.
  await expect.poll(() => sawExit || stream.length > 0, { timeout: 45_000 }).toBe(true);
});

test('combo launch refuses copilot members', async ({ page }) => {
  test.skip(!sandboxAvailable, 'bwrap not available — sandbox cannot run');
  await page.goto('/');
  // The combo UI offers claude/opencode/codex per role -- copilot never
  // appears as a member app (single-mode items are hidden in combo mode).
  await page.locator('.open-split-caret').click();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  await expect(page.locator('.open-menu-app-btn', { hasText: 'GitHub Copilot' })).toHaveCount(0);
  await expect(page.locator('.open-menu-app-btn', { hasText: 'Claude Code' })).toHaveCount(3);
  await expect(page.locator('.open-menu-app-btn', { hasText: 'opencode' })).toHaveCount(3);
  await expect(page.locator('.open-menu-app-btn', { hasText: 'OpenAI Codex' })).toHaveCount(3);
  // The API refuses it too.
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp',
        workerA: { app: 'copilot' },
        workerB: { app: 'claude' },
        orchestrator: { app: 'claude' },
      }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/copilot is not supported in groups/);
});
