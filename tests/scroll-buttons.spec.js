import { test, expect } from '@playwright/test';
import { hasOpencode } from './helpers.js';

// The scroll buttons (up/down/Top/Btm) scroll xterm.js's own buffer, which is
// frozen under opencode's TUI (alt screen + mouse tracking). For opencode
// sessions they must instead drive the TUI's internal conversation scroll via
// its message-scroll keybindings: pageup/pagedown (half page), ctrl+g
// (first message), ctrl+alt+g (last message).

test('scroll buttons send opencode\'s message-scroll keys', async ({ page }) => {
  test.skip(!hasOpencode(), 'opencode CLI not installed on this machine');

  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });

  const inputFrames = [];
  let stream = '';
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
        if (msg.type === 'output') stream += msg.data;
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

  // Wait for the opencode TUI to come up (mouse tracking = it owns scrolling).
  await expect.poll(
    () => stream.includes('\x1b[?1006h'),
    { timeout: 45_000 }
  ).toBe(true);

  // The console's own scrollbar is meaningless for the TUI (its buffer is
  // frozen in the alternate screen): the container hides it and pins the
  // viewport to the bottom.
  await expect(page.locator('.terminal-container')).toHaveClass(/tui-scroll/);
  const viewportOverflow = await page.evaluate(() => {
    const vp = document.querySelector('.terminal-container.tui-scroll .xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  });
  expect(viewportOverflow).toBe('hidden');

  const hasInput = (seq) => inputFrames.some((d) => d === seq);
  const mark = (seq) => {
    const before = inputFrames.length;
    return () => hasInput(seq) || inputFrames.length > before;
  };

  const up = mark('\x1b[5~');
  await page.locator('.scroll-btn[title="Scroll up"]').click();
  await expect.poll(up, { timeout: 5_000 }).toBe(true);

  const top = mark('\x07');
  await page.locator('.scroll-btn[title="Top"]').click();
  await expect.poll(top, { timeout: 5_000 }).toBe(true);

  const down = mark('\x1b[6~');
  await page.locator('.scroll-btn[title="Scroll down"]').click();
  await expect.poll(down, { timeout: 5_000 }).toBe(true);

  const btm = mark('\x1b\x07');
  await page.locator('.scroll-btn[title="Bottom"]').click();
  await expect.poll(btm, { timeout: 5_000 }).toBe(true);
});
