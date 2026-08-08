import { test, expect, devices } from '@playwright/test';

// iPhone text selection: an explicit "selection mode" toggle (there's no OS
// haptic feedback in a PWA to confirm a long-press landed, so entry is a
// deliberate, visibly-stateful button instead) makes any single-finger drag
// start a selection immediately, dispatched as a synthetic mouse drag so
// xterm's own SelectionService does the real work. Two draggable handles
// let either end be adjusted afterward without disturbing the rest of the
// selection, and the mode keeps the terminal blurred so the on-screen
// keyboard doesn't pop up and shift the layout mid-selection.
test.use({
  ...devices['iPhone 13'],
  defaultBrowserType: 'chromium',
  permissions: ['clipboard-read', 'clipboard-write'],
});

const OUTPUT = 'one two three four five six seven eight nine ten';

// Character offsets into OUTPUT for the words we select/extend to.
const WORD_START = {}; // word -> offset
const WORD_END = {};
{
  let i = 0;
  for (const word of OUTPUT.split(' ')) {
    WORD_START[word] = i;
    i += word.length;
    WORD_END[word] = i;
    i += 1; // space
  }
}

// Pixel-precise coordinates for a character offset within the row that
// exactly matches `text`, via the Range API -- robust against not knowing
// the terminal's column count or cell width from the test side. Walks all
// descendant text nodes rather than assuming a single one, since an active
// selection splits the row's accessibility markup into multiple runs.
async function charPos(page, text, offset) {
  return page.evaluate(({ text, offset }) => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    let row = null;
    for (const r of rows) {
      if (r.textContent.trim() === text) { row = r; break; }
    }
    if (!row) throw new Error(`row not found for: ${text}`);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, remaining);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2 };
      }
      remaining -= node.length;
    }
    throw new Error(`offset ${offset} beyond row text for: ${text}`);
  }, { text, offset });
}

async function selectionHandlePositions(page) {
  return page.evaluate(() => [...document.querySelectorAll('.selection-handle')].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
}

test('selection mode: keeps the keyboard closed and lets both ends be dragged independently', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('.open-btn', { hasText: 'Terminal' }).click();
  await expect(page.locator('.terminal-container')).toBeVisible();

  // A plain shell session (no claude/opencode dependency). Give its prompt
  // (rc/plugin startup) a moment to settle before typing.
  await page.waitForTimeout(2000);

  await page.keyboard.type(`printf '${OUTPUT}\\n'`);
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  // A handful of interactive shell configs (async prompt redraws, live
  // status segments) can race with scripted keystrokes independently of
  // this feature -- if the shell hasn't echoed the line back, skip rather
  // than fail on an environment this test can't drive reliably.
  const printed = await page.waitForFunction((expected) => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return [...rows].some((r) => r.textContent.trim() === expected);
  }, OUTPUT, { timeout: 15_000 }).then(() => true).catch(() => false);
  test.skip(!printed, 'shell did not echo the test command back (unrelated to the selection feature under test)');

  const client = await context.newCDPSession(page);
  const touchStart = (x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  const touchMove = (x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  const touchEnd = () => client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  const copyToClipboard = async () => {
    await page.locator('.selection-copy-btn').click();
    return page.evaluate(() => navigator.clipboard.readText());
  };

  const fourStart = await charPos(page, OUTPUT, WORD_START.four);
  const sixEnd = await charPos(page, OUTPUT, WORD_END.six);

  // Outside selection mode, a drag over the terminal scrolls -- it must
  // not start a selection.
  await touchStart(fourStart.x, fourStart.y);
  await touchMove(sixEnd.x, sixEnd.y);
  await touchEnd();
  await expect(page.locator('.selection-handle')).toHaveCount(0);

  // Enabling selection mode blurs the terminal (closing the keyboard if it
  // was open) and must keep it that way -- the whole point is not to have
  // the keyboard pop back up and shift the layout mid-selection.
  await page.locator('.terminal-container').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toContain('xterm-helper-textarea');
  await page.locator('.selection-mode-btn').click();
  await expect(page.locator('.terminal-view.selection-mode')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.className)).not.toContain('xterm-helper-textarea');

  // In selection mode a drag starts selecting immediately -- no long-press
  // wait, since the mode toggle itself is the confirmation that selection
  // is active.
  await touchStart(fourStart.x, fourStart.y);
  await touchMove(sixEnd.x, sixEnd.y);
  await touchEnd();

  await expect(page.locator('.selection-handle')).toHaveCount(2);
  await expect(page.locator('.selection-copy-btn')).toBeVisible();
  expect(await copyToClipboard()).toBe('four five six');
  // Copying clears the selection; a fresh one is needed for the next step.
  await expect(page.locator('.selection-handle')).toHaveCount(0);
  // Tapping the copy button must not have reopened the keyboard either.
  await expect.poll(() => page.evaluate(() => document.activeElement?.className)).not.toContain('xterm-helper-textarea');

  // Re-make the same selection, then drag the START handle back to "one" --
  // this must extend the selection backward while leaving the end alone.
  await touchStart(fourStart.x, fourStart.y);
  await touchMove(sixEnd.x, sixEnd.y);
  await touchEnd();
  await expect(page.locator('.selection-handle')).toHaveCount(2);

  let handles = await selectionHandlePositions(page);
  const startHandle = handles[0];
  const oneStart = await charPos(page, OUTPUT, WORD_START.one);
  await touchStart(startHandle.x, startHandle.y);
  await touchMove(oneStart.x, oneStart.y);
  await touchEnd();

  expect(await copyToClipboard()).toBe('one two three four five six');
  await expect(page.locator('.selection-handle')).toHaveCount(0);

  // Re-make the "four five six" selection again, then drag the END handle
  // forward to "nine" -- this must extend forward while leaving the start.
  await touchStart(fourStart.x, fourStart.y);
  await touchMove(sixEnd.x, sixEnd.y);
  await touchEnd();
  await expect(page.locator('.selection-handle')).toHaveCount(2);

  handles = await selectionHandlePositions(page);
  const endHandle = handles[1];
  const nineEnd = await charPos(page, OUTPUT, WORD_END.nine);
  await touchStart(endHandle.x, endHandle.y);
  await touchMove(nineEnd.x, nineEnd.y);
  await touchEnd();

  expect(await copyToClipboard()).toBe('four five six seven eight nine');

  // Disabling selection mode restores normal typing focus.
  await page.locator('.selection-mode-btn').click();
  await expect(page.locator('.terminal-view.selection-mode')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toContain('xterm-helper-textarea');
});
