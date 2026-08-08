import { test, expect, devices } from '@playwright/test';

// Mobile touch scrolling: a vertical drag on the terminal must reach the app
// (opencode's TUI) as SGR wheel-mouse sequences so its internal conversation
// history scrolls — xterm.js's own buffer has no scrollback under a TUI.
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

test('touch drag sends SGR wheel events to the opencode TUI', async ({ page, context }) => {
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
  await page.locator('.open-split-main').click();

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
