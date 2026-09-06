import { test, expect } from '@playwright/test';

// サイドバー（ウィジェット）開閉で Select a Directory (.directory-browser) の
// 内容サイズが不連続に変わらないことを検証する。回帰対象は
// `.main-row.sidebar-open .directory-browser { max-width: none; }` で、
// 開いた瞬間に中央寄せ800px → 残幅いっぱいのストレッチへ切り替わり、
// 閉時より広がることさえあった。サイドバー分だけ狭くなるのは許容し、
// 「開時が閉時より広がらない」「開時も800pxを超えない」ことを assert する。
test.use({ viewport: { width: 1280, height: 800 } });

test('directory browser keeps its width when the sidebar opens/closes', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ccserver-sidebar-open', '1');
    // in-flow配置での幅検証のため重ね表示は明示OFF (既定はON)。
    localStorage.setItem('ccserver-sidebar-overlay', '0');
  });
  await page.goto('/');
  const browser = page.locator('.directory-browser');
  await expect(browser).toBeVisible();
  await expect(page.locator('.right-sidebar')).toBeVisible();

  const widthOpen = (await browser.boundingBox()).width;
  // 開時も max-width: 800px が効いていること（解除ルールの再発防止）。
  expect(widthOpen).toBeLessThanOrEqual(800.5);
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.directory-browser')).maxWidth))
    .toBe('800px');

  const toggle = page.locator('.sidebar-toggle-btn');
  await toggle.click();
  await expect(page.locator('.right-sidebar')).toBeHidden();
  const widthClosed = (await browser.boundingBox()).width;

  await toggle.click();
  await expect(page.locator('.right-sidebar')).toBeVisible();
  const widthReopened = (await browser.boundingBox()).width;

  // 開時は閉時より広がらない（狭くなる分は許容）。
  expect(widthReopened).toBeLessThanOrEqual(widthClosed + 1);
  // 開閉でサイズが変わらない（再現性）。
  expect(Math.abs(widthReopened - widthOpen)).toBeLessThanOrEqual(1);
});
