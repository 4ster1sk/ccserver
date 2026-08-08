import { test, expect, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Mobile touch scrolling: a vertical drag on the terminal must reach the app
// (opencode's TUI) as SGR wheel-mouse sequences so its internal conversation
// history scrolls — xterm.js's own buffer has no scrollback under a TUI.
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

// opencode isn't installed on every machine this suite runs on (e.g. this
// repo's plain ubuntu-latest CI runner has neither claude nor opencode) --
// the webServer this test drives runs on the same machine, so a local check
// is a valid proxy for whether the server can actually spawn it.
function hasOpencode() {
  try {
    execFileSync('which', ['opencode'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('touch drag sends SGR wheel events to the opencode TUI', async ({ page, context }) => {
  test.skip(!hasOpencode(), 'opencode CLI not installed on this machine');

  // Start in a small, fast directory.
  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });

  const inputFrames = [];
  let outputStream = '';
  page.on('websocket', (ws) => {
    ws.on('framesent', (event) => {
      try {
        const msg = JSON.parse(event.payload);
        if (msg.type === 'input') inputFrames.push(msg.data);
      } catch { /* non-JSON frame */ }
    });
    ws.on('framereceived', (event) => {
      try {
        const msg = JSON.parse(event.payload);
        if (msg.type === 'output') outputStream += msg.data;
      } catch { /* non-JSON frame */ }
    });
  });

  await page.goto('/');
  // The default launched app is now configurable (sandbox.config.json's
  // defaultApp, "claude" unless set) and no longer guaranteed to be
  // opencode, so select it explicitly via the launch modal.
  await page.locator('.open-split-caret').click();
  await page.locator('.open-menu-item', { hasText: 'opencode' }).click();

  // Wait for the TUI to enable mouse tracking (it then owns the wheel).
  await expect.poll(
    () => outputStream.includes('\x1b[?1006h'),
    { timeout: 45_000 }
  ).toBe(true);

  // Drag upward over the terminal.
  const client = await context.newCDPSession(page);
  const box = await page.locator('.terminal-container').boundingBox();
  const x = box.x + box.width / 2;
  const yStart = box.y + box.height * 0.6;
  const yEnd = yStart - 200;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: yStart }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: yEnd }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  // The drag must produce wheel-mouse input (SGR buttons 64 up / 65 down).
  await expect.poll(() =>
    inputFrames.some((d) => /\x1b\[<6[45];/.test(d)),
    { timeout: 5_000 }
  ).toBe(true);
});
