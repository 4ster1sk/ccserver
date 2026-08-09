import { test, expect, devices } from '@playwright/test';
import { hasOpencode } from './helpers.js';

// Mobile touch scrolling: a vertical drag on the terminal must reach the app
// (opencode's TUI) as SGR wheel-mouse sequences so its internal conversation
// history scrolls — xterm.js's own buffer has no scrollback under a TUI.
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

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
  // The launch modal (7bd350b) decoupled choosing options from launching:
  // selecting the app only picks it, the explicit 起動 button starts it.
  await page.getByRole('button', { name: '起動', exact: true }).click();

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

test('touch drag over the prompt band is clamped to the log area', async ({ page, context }) => {
  test.skip(!hasOpencode(), 'opencode CLI not installed on this machine');

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
  await page.locator('.open-split-caret').click();
  await page.locator('.open-menu-item', { hasText: 'opencode' }).click();
  await page.getByRole('button', { name: '起動', exact: true }).click();

  await expect.poll(
    () => outputStream.includes('\x1b[?1006h'),
    { timeout: 45_000 }
  ).toBe(true);
  await page.waitForTimeout(3000);

  const dims = await page.evaluate(() => {
    const inner = [...document.querySelectorAll('.xterm')]
      .find((t) => t.getBoundingClientRect().height > 0);
    if (!inner) throw new Error('no visible .xterm element');
    const r = inner.getBoundingClientRect();
    const rowEls = inner.querySelectorAll('.xterm-rows > div');
    const cellH = rowEls[0] ? rowEls[0].getBoundingClientRect().height : 16;
    return { x: r.x, y: r.y, w: r.width, h: r.height, cellH, rows: rowEls.length };
  });

  const bandStart = dims.rows - 10;
  const client = await context.newCDPSession(page);
  const box = await page.locator('.terminal-container').boundingBox();
  const x = box.x + box.width / 2;

  const drag = async (dir) => {
    inputFrames.length = 0;
    const yStart = box.y + dims.h * 0.92;
    const step = dir === 'up' ? -20 : 20;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: yStart }] });
    for (let i = 1; i <= 5; i++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: yStart + step * i }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(
      () => inputFrames.some((d) => /\x1b\[<6[45];/.test(d)),
      { timeout: 5_000 }
    ).toBe(true);
    const rows = inputFrames
      .filter((d) => /\x1b\[<6[45];/.test(d))
      .map((d) => {
        const m = d.match(/<6[45];\d+;(\d+)/);
        return m ? Number(m[1]) : Infinity;
      });
    // opencode's TUI hit-tests SGR wheel events by position: a row inside the
    // prompt band (the bottom 10 rows, where the prompt input lives) scrolls
    // the prompt editor, not the conversation. TerminalView must clamp every
    // band touch drag to the log area. SGR wire rows are 1-based, so the band
    // starts at wire row rows-10+1.
    for (const row of rows) {
      expect(row).toBeLessThan(bandStart + 1);
    }
  };

  await drag('up');
  await drag('down');
});
