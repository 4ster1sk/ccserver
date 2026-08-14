import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Narrow viewports: the directory browser must never render wider than the
// viewport. #root/body carry overflow:hidden, so anything that sticks out
// past the right edge is clipped and unreachable (no page scroll to reach
// it). The regression this guards is `.directory-browser`'s
// `margin: 0 auto` collapsing it to a fit-content width inside the flex
// wrapper -- at 480px and below the toolbar/long names then blew out past
// the right edge, cutting off the size column, download buttons and the
// launch split button.
test.use({ viewport: { width: 320, height: 667 }, isMobile: true, hasTouch: true });

const KEY_SELECTORS = [
  '.directory-browser',
  '.browser-toolbar',
  '.open-split',
  '.dir-item',
  '.file-item',
  '.file-download-btn',
  '.file-size',
  '.session-status',
];

for (const width of [480, 375, 320, 280]) {
  test(`directory browser stays inside the ${width}px viewport`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ccserver-narrow-'));
    const longDir = join(dir, 'very-long-directory-name-that-goes-on-and-on-archive');
    const longFile = join(dir, 'very-long-file-name-with-many-words-documentation-notes.txt');
    mkdirSync(longDir);
    writeFileSync(longFile, '');
    await page.setViewportSize({ width, height: 667 });
    await page.addInitScript((d) => localStorage.setItem('ccserver-last-dir', d), dir);
    await page.goto('/');
    await page.waitForSelector('.dir-list');
    await expect(page.locator('.dir-item').first()).toBeVisible();

    for (const sel of KEY_SELECTORS) {
      for (const el of await page.locator(sel).all()) {
        const box = await el.boundingBox();
        expect(box, `${sel} should have a box`).not.toBeNull();
        // The right edge of every key element must stay inside the viewport.
        expect(box.x + box.width, `${sel} right edge clipped at ${width}px`).toBeLessThanOrEqual(width + 0.5);
      }
    }
  });
}
