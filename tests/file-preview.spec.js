import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

// The Files tab opens .md / .txt files inline instead of forcing a download:
// clicking such a row opens a dialog that renders markdown (with a Source
// toggle) or shows plain text in a <pre>. Everything else on the row keeps
// download as its only action. Markdown goes through DOMPurify in the real
// browser, so the sanitiser is exercised here rather than in a unit test.

const ONE_MIB = 1024 * 1024;

let dir;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccserver-e2e-preview-'));
  writeFileSync(
    join(dir, 'README.md'),
    '# Preview Heading\n\nSome **bold** text and a [link](https://example.com/).\n\n<script>window.__previewXss = 1</script>\n'
  );
  writeFileSync(join(dir, 'notes.txt'), 'plain line one\nplain line two\n');
  // .txt in name only: exercises the server's NUL-byte binary guard.
  writeFileSync(join(dir, 'fake.txt'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  // Not an allow-listed extension: the row must not open a preview at all.
  writeFileSync(join(dir, 'config.json'), '{"a":1}\n');
  // Hostile markdown: every payload here must be neutralised by DOMPurify.
  writeFileSync(
    join(dir, 'xss.md'),
    [
      '# Unsafe',
      '',
      '<script>window.__previewXss = 1</script>',
      '<img src="x" onerror="window.__previewImg = 1">',
      '<iframe src="https://example.com/"></iframe>',
      '<style>body { display: none }</style>',
      '<p id="styled" style="position:fixed;inset:0;background:red">covering</p>',
      '<div onclick="window.__previewClick = 1" id="clicky">click me</div>',
      '',
      '[js link](javascript:window.__previewJs=1)',
      '',
      '[same tab](https://example.com/page)',
      '',
      '<a href="https://example.com/self" target="_self">explicit self</a>',
      '',
    ].join('\n')
  );
  // GFM features the viewer is expected to render.
  writeFileSync(
    join(dir, 'gfm.md'),
    [
      '| col a | col b |',
      '|-------|-------|',
      '| 1     | two   |',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      'https://example.com/auto',
      '',
      '~~gone~~',
      '',
    ].join('\n')
  );
  // Wide content for the narrow-viewport test: a long code line (pre keeps
  // whitespace, so it cannot wrap) and a wide table.
  writeFileSync(
    join(dir, 'wide.md'),
    '# Wide\n\n```\n' + 'const wide = "' + 'w'.repeat(400) + '";\n```\n\n| ' + 'very-long-header-cell-'.repeat(8) + ' | x |\n|---|---|\n| ' + 'y'.repeat(300) + ' | z |\n'
  );
  // Over the 1 MiB preview cap.
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(ONE_MIB + 100));
  // Deleted between listing and click in one test.
  writeFileSync(join(dir, 'gone.txt'), 'soon gone\n');
});

test.afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

const dialog = (page) => page.locator('.file-preview-dialog');
const row = (page, name) => page.locator('.file-item', { hasText: name });

async function gotoDir(page) {
  await page.goto('/');
  await page.evaluate((d) => localStorage.setItem('ccserver-last-dir', d), dir);
  await page.goto('/');
  await expect(row(page, 'README.md')).toBeVisible();
}

// Basic flows ----------------------------------------------------------------

test('markdown file renders sanitized HTML, toggles to source, and Escape closes', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'README.md').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.file-preview-title')).toHaveText('README.md');

  const body = dialog(page).locator('.markdown-body');
  await expect(body.locator('h1')).toHaveText('Preview Heading');
  await expect(body.locator('strong')).toHaveText('bold');
  const link = body.locator('a', { hasText: 'link' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);

  // The <script> in the markdown must be stripped, not executed.
  await expect(body.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__previewXss)).toBeUndefined();

  // Source view shows the raw markdown.
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(dialog(page).locator('.file-preview-text')).toContainText('# Preview Heading');
  await expect(body).toHaveCount(0);
  await page.getByRole('button', { name: 'Rendered' }).click();
  await expect(dialog(page).locator('.markdown-body h1')).toHaveText('Preview Heading');

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('text file shows as preformatted text without a view toggle; close button closes', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'notes.txt').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.file-preview-text')).toContainText('plain line two');
  await expect(dialog(page).locator('.markdown-body')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Source' })).toHaveCount(0);
  // No truncation notice for a small file.
  await expect(dialog(page).locator('.file-preview-notice')).toHaveCount(0);

  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
});

test('reopening a markdown file starts in Rendered view even if Source was chosen before', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'README.md').click();
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(dialog(page).locator('.file-preview-text')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await row(page, 'README.md').click();
  await expect(dialog(page).locator('.markdown-body h1')).toHaveText('Preview Heading');
  await expect(dialog(page).locator('.file-preview-text')).toHaveCount(0);
});

test('opening a different file replaces the dialog content', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'README.md').click();
  await expect(dialog(page).locator('.markdown-body h1')).toHaveText('Preview Heading');
  await page.keyboard.press('Escape');

  await row(page, 'notes.txt').click();
  await expect(dialog(page).locator('.file-preview-title')).toHaveText('notes.txt');
  await expect(dialog(page).locator('.file-preview-text')).toContainText('plain line one');
  await expect(dialog(page).locator('.markdown-body')).toHaveCount(0);
});

// Sanitiser and GFM ------------------------------------------------------------

test('hostile markdown is neutralised: no script/iframe/style, no inline handlers, no javascript: links', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'xss.md').click();
  const body = dialog(page).locator('.markdown-body');
  await expect(body.locator('h1')).toHaveText('Unsafe');

  await expect(body.locator('script')).toHaveCount(0);
  await expect(body.locator('iframe')).toHaveCount(0);
  await expect(body.locator('style')).toHaveCount(0);

  // Inline style attributes are dropped too (a fixed overlay would cover the UI).
  const styled = body.locator('#styled');
  await expect(styled).toHaveText('covering');
  await expect(styled).not.toHaveAttribute('style', /.*/);

  // <img> survives but its onerror handler must not.
  const img = body.locator('img');
  await expect(img).toHaveCount(1);
  await expect(img).not.toHaveAttribute('onerror', /.*/);

  // Inline handlers are stripped from any element; clicking is inert.
  const clicky = body.locator('#clicky');
  await expect(clicky).toHaveText('click me');
  await expect(clicky).not.toHaveAttribute('onclick', /.*/);
  await clicky.click();

  // javascript: URLs lose their href (and therefore never get target/rel).
  const jsLink = body.locator('a', { hasText: 'js link' });
  await expect(jsLink).toHaveCount(1);
  await expect(jsLink).not.toHaveAttribute('href', /.*/);
  await jsLink.click();

  // Every real link opens in a new tab with noopener, even an explicit _self.
  for (const text of ['same tab', 'explicit self']) {
    const a = body.locator('a', { hasText: text });
    await expect(a).toHaveAttribute('target', '_blank');
    await expect(a).toHaveAttribute('rel', /noopener/);
  }

  const flags = await page.evaluate(() => [window.__previewXss, window.__previewImg, window.__previewJs, window.__previewClick]);
  expect(flags).toEqual([undefined, undefined, undefined, undefined]);
  // The <style> payload would have hidden the whole page.
  await expect(dialog(page)).toBeVisible();
});

test('GFM tables, task lists, fenced code, autolinks and strikethrough render', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'gfm.md').click();
  const body = dialog(page).locator('.markdown-body');

  await expect(body.locator('table th')).toHaveCount(2);
  await expect(body.locator('table td', { hasText: 'two' })).toBeVisible();

  const boxes = body.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).not.toBeChecked();

  await expect(body.locator('pre code')).toContainText('const answer = 42;');
  await expect(body.locator('a[href="https://example.com/auto"]')).toBeVisible();
  await expect(body.locator('del')).toHaveText('gone');
});

// Limits and errors ------------------------------------------------------------

test('a file over 1 MiB shows only the head plus a truncation notice', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'big.txt').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.file-preview-notice')).toContainText('first 1.0 MB');
  await expect(dialog(page).locator('.file-preview-meta')).toHaveText('1.0 MB');
  const shown = await dialog(page).locator('.file-preview-text').evaluate((el) => el.textContent.length);
  expect(shown).toBe(ONE_MIB);
});

test('binary content behind a .txt name reports an error inside the dialog; overlay click closes', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'fake.txt').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.error')).toContainText('Binary file');

  // Click the overlay outside the dialog.
  await page.locator('.resume-overlay').click({ position: { x: 5, y: 5 } });
  await expect(dialog(page)).toBeHidden();
});

test('a file deleted after the listing reports "File not found" in the dialog', async ({ page }) => {
  await gotoDir(page);
  await expect(row(page, 'gone.txt')).toBeVisible();
  rmSync(join(dir, 'gone.txt'));
  await row(page, 'gone.txt').click();
  await expect(dialog(page).locator('.error')).toContainText('File not found');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('rows for other extensions are not clickable and keep only the download button', async ({ page }) => {
  await gotoDir(page);
  const json = row(page, 'config.json');
  await expect(json).toBeVisible();
  await expect(json).not.toHaveAttribute('role', 'button');
  await expect(json).not.toHaveClass(/file-item-previewable/);
  await expect(row(page, 'notes.txt')).toHaveClass(/file-item-previewable/);

  await json.click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(json.locator('.file-download-btn')).toBeVisible();
});

// Download paths ---------------------------------------------------------------

test('the download button on a row downloads without opening the preview', async ({ page }) => {
  await gotoDir(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row(page, 'notes.txt').locator('.file-download-btn').click(),
  ]);
  expect(download.suggestedFilename()).toBe('notes.txt');
  await expect(dialog(page)).toHaveCount(0);
});

test('the Download button inside the dialog downloads the same file and keeps the dialog open', async ({ page }) => {
  await gotoDir(page);
  await row(page, 'README.md').click();
  await expect(dialog(page)).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog(page).getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('README.md');
  await expect(dialog(page)).toBeVisible();
});

// Keyboard -----------------------------------------------------------------------

test('Enter on a focused row opens the preview; Enter on its download button only downloads', async ({ page }) => {
  await gotoDir(page);
  const notes = row(page, 'notes.txt');
  await notes.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await notes.locator('.file-download-btn').focus();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Enter'),
  ]);
  expect(download.suggestedFilename()).toBe('notes.txt');
  await expect(dialog(page)).toHaveCount(0);
});

// Narrow viewport ------------------------------------------------------------------

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('the dialog stays inside a 375px viewport and wide content scrolls within it', async ({ page }) => {
    await gotoDir(page);
    const pageWidthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
    await row(page, 'wide.md').click();
    await expect(dialog(page).locator('.markdown-body h1')).toHaveText('Wide');

    const box = await dialog(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(667);

    // Wide content scrolls inside its own block (pre / table), never the
    // dialog body, and opening the dialog must not widen the page.
    const overflow = await page.evaluate(() => {
      const body = document.querySelector('.file-preview-body');
      const pre = document.querySelector('.markdown-body pre');
      const table = document.querySelector('.markdown-body table');
      return {
        page: document.documentElement.scrollWidth,
        bodyScrollsSideways: body.scrollWidth > body.clientWidth,
        preScrollsInside: pre.scrollWidth > pre.clientWidth,
        tableFits: table.getBoundingClientRect().right <= body.getBoundingClientRect().right,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(pageWidthBefore);
    expect(overflow.bodyScrollsSideways).toBe(false);
    expect(overflow.preScrollsInside).toBe(true);
    expect(overflow.tableFits).toBe(true);

    // Header controls remain reachable.
    await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();
  });
});
