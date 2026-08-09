import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Desktop wheel scrolling over opencode's TUI: the TUI hit-tests SGR wheel
// events by position, so a wheel over the prompt band (the bottom rows, where
// the prompt editor lives) would scroll the prompt editor's own viewport --
// never the conversation log. TerminalView swallows band wheels entirely (no
// SGR wheel event ever reaches the TUI / the prompt input) and drives the
// conversation's scrollbox with the TUI's message-scroll keybindings instead
// (the same PageUp/PageDown the scroll buttons send).

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

test('desktop wheel over the prompt band is clamped to the log rows', async ({ page, context }) => {
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
    const r = inner.getBoundingClientRect();
    const rowEls = inner.querySelectorAll('.xterm-rows > div');
    const cellH = rowEls[0] ? rowEls[0].getBoundingClientRect().height : 16;
    return { x: r.x, y: r.y, w: r.width, cellH, rows: rowEls.length };
  });
  expect(dims.rows).toBeGreaterThan(10);
  const cx = dims.x + dims.w / 2;
  const yLog = dims.y + 6 * dims.cellH; // deep in the log area
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
  // conversation scrolls via the TUI's PageUp keybinding, accumulated over
  // ~360px of wheel delta -- 3 notches here (3 * -120) emit exactly one
  // PageUp.
  inputFrames.length = 0;
  await page.mouse.move(cx, yBand);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -120);
  }
  await expect.poll(
    () => inputFrames.some((d) => d === '\x1b[5~'),
    { timeout: 5_000 }
  ).toBe(true);
  const sgrBand = inputFrames.filter((d) => /\x1b\[<6[45]/.test(d));
  expect(sgrBand).toEqual([]);
});
