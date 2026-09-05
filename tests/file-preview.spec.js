import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

// The Files tab opens text files inline instead of forcing a download: the
// file name is a button that opens a native modal <dialog> rendering markdown
// (with a Source toggle), pretty-printing JSON (with a Source toggle), or
// showing other text in a <pre>. The download button on the row stays a
// separate sibling button. Markdown goes through DOMPurify in the real
// browser, so the sanitiser -- including the "opening a preview fetches
// nothing" policy -- is exercised here rather than in a unit test.

const ONE_MIB = 1024 * 1024;
const HUNDRED_KIB = 100 * 1024;

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
  // application/json: pretty-printed with a Source toggle.
  writeFileSync(join(dir, 'config.json'), '{"b":2,"a":1}\n');
  // Invalid JSON: no toggle, raw source only.
  writeFileSync(join(dir, 'broken.json'), '{"a":1,\n');
  // JSONC with a comment: not valid JSON, so raw source only.
  writeFileSync(join(dir, 'app.jsonc'), '{\n// comment\n"a": 1\n}\n');
  // Non-text MIME: the row must not open a preview at all.
  writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  // Over the 100 KiB confirm threshold but small enough to open quickly.
  writeFileSync(join(dir, 'medium.txt'), 'm'.repeat(HUNDRED_KIB + 100));
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
  // Everything here would make the browser fetch a URL just by rendering.
  writeFileSync(
    join(dir, 'remote.md'),
    [
      '# Remote',
      '',
      '![pic](https://example.invalid/track.png)',
      '',
      '<img src="https://example.invalid/raw.png" alt="raw">',
      '<img srcset="https://example.invalid/set.png 1x">',
      '<picture><source srcset="https://example.invalid/pic.png"><img src="https://example.invalid/pic-fallback.png"></picture>',
      '<video src="https://example.invalid/v.mp4" poster="https://example.invalid/p.png"></video>',
      '<audio src="https://example.invalid/a.mp3"></audio>',
      '<iframe src="https://example.invalid/frame"></iframe>',
      '<embed src="https://example.invalid/e.swf">',
      '<object data="https://example.invalid/o.pdf"></object>',
      '<link rel="stylesheet" href="https://example.invalid/s.css">',
      '<meta http-equiv="refresh" content="0;url=https://example.invalid/">',
      '<input type="image" src="https://example.invalid/btn.png">',
      '<table background="https://example.invalid/bg.png"><tr><td id="bgcell" background="http://127.0.0.1:9/cell.png">cell</td></tr></table>',
      '<img src="http://127.0.0.1:9/lan.png">',
      '',
      '[still a link](https://example.invalid/page)',
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
const openBtn = (page, name) => row(page, name).locator('.file-open-btn');

// Whether keyboard focus currently sits inside the preview dialog.
const focusInsideDialog = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return !!(a && a.closest('.file-preview-dialog'));
});

async function gotoDir(page) {
  await page.goto('/');
  await page.evaluate((d) => localStorage.setItem('ccserver-last-dir', d), dir);
  await page.goto('/');
  await expect(row(page, 'README.md')).toBeVisible();
}

// Basic flows ----------------------------------------------------------------

test('markdown file renders sanitized HTML, toggles to source, and Escape closes', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'README.md').click();
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
  await openBtn(page, 'notes.txt').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.file-preview-text')).toContainText('plain line two');
  await expect(dialog(page).locator('.markdown-body')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Source' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pretty' })).toHaveCount(0);
  // No truncation notice for a small file.
  await expect(dialog(page).locator('.file-preview-notice')).toHaveCount(0);

  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
});

test('reopening a markdown file starts in Rendered view even if Source was chosen before', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'README.md').click();
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(dialog(page).locator('.file-preview-text')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await openBtn(page, 'README.md').click();
  await expect(dialog(page).locator('.markdown-body h1')).toHaveText('Preview Heading');
  await expect(dialog(page).locator('.file-preview-text')).toHaveCount(0);
});

test('opening a different file replaces the dialog content', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'README.md').click();
  await expect(dialog(page).locator('.markdown-body h1')).toHaveText('Preview Heading');
  await page.keyboard.press('Escape');

  await openBtn(page, 'notes.txt').click();
  await expect(dialog(page).locator('.file-preview-title')).toHaveText('notes.txt');
  await expect(dialog(page).locator('.file-preview-text')).toContainText('plain line one');
  await expect(dialog(page).locator('.markdown-body')).toHaveCount(0);
});

// JSON ---------------------------------------------------------------------

test('json file pretty-prints by default and toggles to source', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'config.json').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.file-preview-title')).toHaveText('config.json');
  await expect(dialog(page).locator('.markdown-body')).toHaveCount(0);

  // 2-space pretty view, not the single-line source.
  await expect(dialog(page).locator('.file-preview-text')).toHaveText('{\n  "b": 2,\n  "a": 1\n}');
  await expect(page.getByRole('button', { name: 'Pretty' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Source' }).click();
  await expect(dialog(page).locator('.file-preview-text')).toHaveText('{"b":2,"a":1}');
  await page.getByRole('button', { name: 'Pretty' }).click();
  await expect(dialog(page).locator('.file-preview-text')).toHaveText('{\n  "b": 2,\n  "a": 1\n}');

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('invalid JSON and JSONC with comments show raw source without a toggle', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'broken.json').click();
  await expect(dialog(page).locator('.file-preview-text')).toContainText('{"a":1,');
  await expect(page.getByRole('button', { name: 'Pretty' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Source' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openBtn(page, 'app.jsonc').click();
  await expect(dialog(page).locator('.file-preview-text')).toContainText('// comment');
  await expect(page.getByRole('button', { name: 'Pretty' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

// Sanitiser and GFM ------------------------------------------------------------

test('hostile markdown is neutralised: no script/iframe/style/img, no inline handlers, no javascript: links', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'xss.md').click();
  const body = dialog(page).locator('.markdown-body');
  await expect(body.locator('h1')).toHaveText('Unsafe');

  await expect(body.locator('script')).toHaveCount(0);
  await expect(body.locator('iframe')).toHaveCount(0);
  await expect(body.locator('style')).toHaveCount(0);
  // Raw <img> is dropped outright (it would fetch, and it carried onerror).
  await expect(body.locator('img')).toHaveCount(0);

  // Inline style attributes are dropped too (a fixed overlay would cover the UI).
  const styled = body.locator('#styled');
  await expect(styled).toHaveText('covering');
  await expect(styled).not.toHaveAttribute('style', /.*/);

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

test('opening a markdown preview fetches nothing from the file: no images, media, frames or stylesheets', async ({ page }) => {
  // Anything that reaches the network for the file's hosts is a failure.
  const external = [];
  await page.route(/example\.invalid|127\.0\.0\.1:9\//, (route) => {
    external.push(route.request().url());
    route.abort();
  });
  await gotoDir(page);
  const origin = new URL(page.url()).origin;
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));

  await openBtn(page, 'remote.md').click();
  const body = dialog(page).locator('.markdown-body');
  await expect(body.locator('h1')).toHaveText('Remote');

  // Markdown image syntax becomes an inert placeholder that still tells the
  // reader what was there; raw fetching elements vanish.
  const placeholder = body.locator('.md-image-placeholder');
  await expect(placeholder).toHaveText('[image: pic]');
  await expect(placeholder).toHaveAttribute('title', 'https://example.invalid/track.png');
  for (const sel of ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'embed', 'object', 'link', 'meta', 'input[type="image"]']) {
    await expect(body.locator(sel), sel).toHaveCount(0);
  }
  await expect(body.locator('table')).not.toHaveAttribute('background', /.*/);
  await expect(body.locator('#bgcell')).not.toHaveAttribute('background', /.*/);
  // Plain links survive: they only load on an explicit click.
  await expect(body.locator('a', { hasText: 'still a link' })).toHaveAttribute('href', 'https://example.invalid/page');

  // Give any stray subresource load a moment to show up, then check the wire:
  // nothing left the app origin, and nothing image/media/style-like was
  // requested at all while the preview was open.
  await page.waitForTimeout(500);
  expect(external).toEqual([]);
  expect(requests.filter((r) => !r.url.startsWith(origin))).toEqual([]);
  expect(requests.filter((r) => ['image', 'media', 'stylesheet', 'font'].includes(r.type))).toEqual([]);
  expect(page.url().startsWith(origin)).toBe(true);
});

test('GFM tables, task lists, fenced code, autolinks and strikethrough render', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'gfm.md').click();
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

// Auto-accept the 100 KiB "really open?" confirm when the test intends to
// open a big file; the dismiss path has its own test below.
test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept().catch(() => {}));
});

test('a file over 1 MiB shows only the head plus a truncation notice', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'big.txt').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.file-preview-notice')).toContainText('first 1.0 MB');
  await expect(dialog(page).locator('.file-preview-meta')).toHaveText('1.0 MB');
  const shown = await dialog(page).locator('.file-preview-text').evaluate((el) => el.textContent.length);
  expect(shown).toBe(ONE_MIB);
});

test('binary content behind a .txt name reports an error inside the dialog; backdrop click closes', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'fake.txt').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.error')).toContainText('Binary file');

  // Click the backdrop outside the dialog box.
  await page.mouse.click(5, 5);
  await expect(dialog(page)).toBeHidden();
});

test('a file deleted after the listing reports "File not found" in the dialog', async ({ page }) => {
  await gotoDir(page);
  await expect(row(page, 'gone.txt')).toBeVisible();
  rmSync(join(dir, 'gone.txt'));
  await openBtn(page, 'gone.txt').click();
  await expect(dialog(page).locator('.error')).toContainText('File not found');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('a file over 100 KiB asks for confirmation: dismiss keeps it closed, accept opens it', async ({ page }) => {
  await gotoDir(page);
  await expect(row(page, 'medium.txt')).toBeVisible();

  // Dismiss: no dialog opens. The auto-accept hook only fires when accept is
  // wanted, so remove it here and handle the confirm manually.
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => d.dismiss().catch(() => {}));
  await openBtn(page, 'medium.txt').click();
  await expect(dialog(page)).toHaveCount(0);

  // Accept: the preview opens normally.
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await openBtn(page, 'medium.txt').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.file-preview-text')).toContainText('m');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  // Keyboard (Enter on the focused button) goes through the same confirm.
  page.once('dialog', (d) => d.dismiss().catch(() => {}));
  await openBtn(page, 'medium.txt').focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
});

test('rows for non-text extensions have no preview button and keep only the download button', async ({ page }) => {
  await gotoDir(page);
  const img = row(page, 'image.png');
  await expect(img).toBeVisible();
  await expect(img.locator('.file-open-btn')).toHaveCount(0);
  await expect(img.locator('.file-label')).toHaveCount(1);
  await expect(openBtn(page, 'notes.txt')).toHaveCount(1);
  // A MIME-text extension now opens inline: json rows have a preview button.
  await expect(openBtn(page, 'config.json')).toHaveCount(1);

  await img.locator('.file-label').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(img.locator('.file-download-btn')).toBeVisible();
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
  await openBtn(page, 'README.md').click();
  await expect(dialog(page)).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog(page).getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('README.md');
  await expect(dialog(page)).toBeVisible();
});

// Keyboard and accessibility -----------------------------------------------------

test('file rows are two sibling buttons (preview, download): nothing nests and no div plays button', async ({ page }) => {
  await gotoDir(page);
  const r = row(page, 'notes.txt');
  await expect(r.locator('button.file-open-btn')).toHaveCount(1);
  await expect(r.locator('button.file-download-btn')).toHaveCount(1);
  await expect(r.locator('.file-open-btn .file-download-btn')).toHaveCount(0);
  await expect(page.locator('.file-item[role="button"], .file-item [role="button"]')).toHaveCount(0);
  await expect(r.locator('.file-open-btn')).toHaveAccessibleName(/notes\.txt/);
  await expect(r.getByRole('button', { name: 'Download notes.txt' })).toBeVisible();
});

test('Enter and Space on the preview button open the dialog; Enter on the download button only downloads', async ({ page }) => {
  await gotoDir(page);
  const btn = openBtn(page, 'notes.txt');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await btn.focus();
  await page.keyboard.press('Space');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await row(page, 'notes.txt').locator('.file-download-btn').focus();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Enter'),
  ]);
  expect(download.suggestedFilename()).toBe('notes.txt');
  await expect(dialog(page)).toHaveCount(0);
});

test('closing the dialog returns focus to the preview button that opened it', async ({ page }) => {
  await gotoDir(page);
  const btn = openBtn(page, 'notes.txt');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(btn).toBeFocused();

  // Same via the Close button and via the backdrop.
  await btn.click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(btn).toBeFocused();

  await btn.click();
  await expect(dialog(page)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog(page)).toBeHidden();
  await expect(btn).toBeFocused();
});

test('the dialog is modal: aria-modal, initial focus inside, Tab and Shift+Tab cycle within it, page behind is inert', async ({ page }) => {
  await gotoDir(page);
  await openBtn(page, 'README.md').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute('aria-modal', 'true');
  await expect(d).toHaveAttribute('aria-labelledby', /.+/);
  await expect(d).toHaveAccessibleName('README.md');
  expect(await focusInsideDialog(page)).toBe(true);

  // Forward: more presses than there are controls, so we wrap at least once.
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInsideDialog(page), `Tab #${i + 1}`).toBe(true);
    seen.add(await page.evaluate(() => document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim()));
  }
  expect([...seen]).toEqual(expect.arrayContaining(['Rendered', 'Source', 'Download', 'Close', 'File content']));

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focusInsideDialog(page), `Shift+Tab #${i + 1}`).toBe(true);
  }

  // The page behind the modal cannot take focus.
  const toolbarTookFocus = await page.evaluate(() => {
    const b = document.querySelector('.browser-toolbar button');
    b.focus();
    return document.activeElement === b;
  });
  expect(toolbarTookFocus).toBe(false);
});

// Narrow viewport ------------------------------------------------------------------

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('the dialog stays inside a 375px viewport and wide content scrolls within it', async ({ page }) => {
    await gotoDir(page);
    const pageWidthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
    await openBtn(page, 'wide.md').click();
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
