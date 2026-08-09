import { test, expect } from '@playwright/test';
import { hasOpencode } from './helpers.js';

// Desktop wheel scrolling over opencode's TUI: the TUI hit-tests SGR wheel
// events by position, so a wheel over the prompt band (the bottom rows, where
// the prompt editor lives) would scroll the prompt editor's own viewport --
// never the conversation log. TerminalView swallows band wheels entirely (no
// SGR wheel event ever reaches the TUI / the prompt input) and drives the
// conversation's scrollbox with the TUI's one-line scroll keybindings
// instead (ctrl+alt+y / ctrl+alt+e; see src/config/keybind.ts in the opencode
// repo). A desktop notch (~120px of delta) scrolls exactly one line.

test('desktop wheel over the prompt band scrolls the log via line-scroll keys', async ({ page }) => {
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

  // Wait for the TUI to enable mouse tracking (it then owns the wheel).
  await expect.poll(
    () => outputStream.includes('\x1b[?1006h'),
    { timeout: 45_000 }
  ).toBe(true);
  await page.waitForTimeout(4000);

  // Terminal geometry from the visible xterm element (hidden tabs may leave
  // stale terminals mounted in the DOM).
  const dims = await page.evaluate(() => {
    const inner = [...document.querySelectorAll('.xterm')]
      .find((t) => t.getBoundingClientRect().height > 0);
    if (!inner) throw new Error('no visible .xterm element');
    const r = inner.getBoundingClientRect();
    const rowEls = inner.querySelectorAll('.xterm-rows > div');
    const cellH = rowEls[0] ? rowEls[0].getBoundingClientRect().height : 16;
    return { x: r.x, y: r.y, w: r.width, cellH, rows: rowEls.length };
  });
  // Row 7 (1-based) must sit above the 10-row prompt band: rows - 10 > 7.
  expect(dims.rows).toBeGreaterThan(17);
  const cx = dims.x + dims.w / 2;
  const yLog = dims.y + 6.5 * dims.cellH; // center of row 7 (1-based), off the row boundary
  const yBand = dims.y + (dims.rows - 3) * dims.cellH; // inside the prompt band

  // Control: a wheel over the log area passes through unclamped -- its SGR
  // row stays where the wheel actually was (row 7 here, 1-based).
  inputFrames.length = 0;
  await page.mouse.move(cx, yLog);
  await page.mouse.wheel(0, -120);
  await expect.poll(
    () => inputFrames.some((d) => /\x1b\[<64;\d+;7M/.test(d)),
    { timeout: 5_000 }
  ).toBe(true);

  // The band wheel must never reach the TUI as an SGR wheel event (that would
  // land on the prompt editor): no <64/<65 frames may appear. Instead the
  // conversation scrolls one line per notch via the TUI's line-scroll
  // keybinding (ctrl+alt+y / ctrl+alt+e).
  inputFrames.length = 0;
  await page.mouse.move(cx, yBand);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -120);
  }
  await expect.poll(
    () => inputFrames.some((d) => d === '\x1b\x19'),
    { timeout: 5_000 }
  ).toBe(true);
  // Let any straggler SGR frame arrive over the WebSocket before asserting
  // none ever escaped (a one-shot check right after the poll could miss a
  // late frame).
  await page.waitForTimeout(1000);
  expect(inputFrames.some((d) => /\x1b\[<6[45]/.test(d))).toBe(false);

  // And the same in the other direction.
  inputFrames.length = 0;
  await page.mouse.wheel(0, 120);
  await expect.poll(
    () => inputFrames.some((d) => d === '\x1b\x05'),
    { timeout: 5_000 }
  ).toBe(true);
  await page.waitForTimeout(1000);
  expect(inputFrames.some((d) => /\x1b\[<6[45]/.test(d))).toBe(false);
});
