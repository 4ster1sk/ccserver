import { test, expect } from '@playwright/test';

// 左セッションサイドバー (既定・サイドバーモード) の検証。
// 既存 popup 挙動は session-menu.spec.js / close-confirm.spec.js で
// popup を明示した上で検証しているため、ここでは新規挙動のみ扱う。

const SKIP_KEY = 'ccserver-skip-close-confirm';
const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const sessionToggle = (page) => page.getByRole('button', { name: /セッションサイドバー/ });
const leftSidebar = (page) => page.locator('.left-sidebar');
const tabToggleBadge = (page) => page.locator('.tab-bar .session-menu-count');
const sidebarBadge = (page) => page.locator('.left-sidebar .session-menu-count');
const openedItems = (page) => leftSidebar(page).locator('[data-section="opened"] .session-menu-item');
const unopenedItems = (page) => leftSidebar(page).locator('[data-section="unopened"] .session-menu-item');

async function gotoApp(page) {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
}

async function openShellTab(page) {
  await page.locator('.tab-list .tab-item', { hasText: 'Files' }).click();
  await openTerminalBtn(page).click();
  await expect(tabToggleBadge(page)).toHaveText('1');
}

async function closeAllUpperSidebar(page) {
  for (let i = 0; i < 5; i++) {
    if (await tabToggleBadge(page).count() === 0) break;
    await openedItems(page).first().locator('.session-menu-close').click();
    await expect.poll(async () => tabToggleBadge(page).count(), { timeout: 10_000 }).toBe(0);
  }
}

async function terminateAllLowerSidebar(page) {
  for (let i = 0; i < 15; i++) {
    const before = await unopenedItems(page).count();
    if (before === 0) break;
    page.once('dialog', (d) => d.accept());
    await unopenedItems(page).first().locator('.session-menu-close').click();
    await expect.poll(async () => unopenedItems(page).count(), { timeout: 10_000 }).toBeLessThan(before);
  }
}

test('default is sidebar: left panel visible, popup absent, toggle persists', async ({ page }) => {
  await gotoApp(page);

  // 既定 (キーなし) はサイドバー。popup の .session-menu は存在しない。
  await expect(leftSidebar(page)).toBeVisible();
  await expect(page.locator('.session-menu')).toHaveCount(0);
  await expect(sessionToggle(page)).toHaveAccessibleName('セッションサイドバーを閉じる');

  // トグルで閉じる → 永続化 → 開く → リロード後も復元。
  await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('0');

  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('1');

  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();
});

test('selecting a tab keeps the sidebar open', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);

  await openShellTab(page);
  await expect(openedItems(page)).toHaveCount(1);
  await expect(sidebarBadge(page)).toHaveText('1');

  // 選択してもサイドバーは閉じない (popup は選択で閉じる)。
  await openedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();

  // Cleanup: タブを閉じ、残った稼働セッションを終了する。
  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('settings select switches mode and persists', async ({ page }) => {
  await gotoApp(page);
  await expect(leftSidebar(page)).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-view')).toBeVisible();
  const panel = page.locator('[role="tabpanel"]');
  const select = panel.getByLabel('セッション表示');
  await expect(select).toHaveValue('sidebar');

  // popup に切替: 左パネルが消え、ハンバーガー + popup が出る。
  await select.selectOption('popup');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-mode'))).toBe('popup');
  await expect(leftSidebar(page)).toBeHidden();
  const hamburger = page.getByRole('button', { name: 'セッション一覧メニュー' });
  await expect(hamburger).toBeVisible();
  await hamburger.click();
  await expect(page.locator('.session-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // sidebar に戻す → リロード後も復元。
  await select.selectOption('sidebar');
  await expect(leftSidebar(page)).toBeVisible();
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ccserver-session-mode'))).toBe('sidebar');
});

test('session overlay is independent from widget overlay', async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => {
    localStorage.removeItem('ccserver-sidebar-overlay');
    localStorage.removeItem('ccserver-session-sidebar-overlay');
  });
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  // overlay ON時は左パネルが設定UIに重なるため (右overlayと同一設計:
  // 閉じるのはtab-barトグルのみ)、チェック操作時はパネルを閉じておく。
  // overlay設定自体は開閉と独立に永続化される。
  await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  const panel = page.locator('[role="tabpanel"]');
  const sessionCheck = panel.getByLabel('セッションをCLIの上に重ねて表示する');
  const widgetCheck = panel.getByLabel('ウィジェットをCLIの上に重ねて表示する');
  await expect(sessionCheck).not.toBeChecked();
  await expect(widgetCheck).not.toBeChecked();

  // 左のみ ON: session-overlay のみ付与、右キー・右クラスに影響なし。
  await sessionCheck.check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-overlay'))).toBe('1');
  await expect(page.locator('.main-row')).toHaveClass(/session-overlay/);
  await expect(page.locator('.main-row')).not.toHaveClass(/sidebar-overlay/);
  expect(await page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay'))).toBeNull();
  // 開き直しても表示され、前面に重なる (absolute配置)。
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await expect.poll(() => page.locator('.left-sidebar').evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  await page.getByRole('button', { name: 'セッションサイドバーを閉じる' }).click();
  await expect(leftSidebar(page)).toBeHidden();

  await sessionCheck.uncheck();
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);

  // 右のみ ON: sidebar-overlay のみ付与、左キーに影響なし。
  // (左OFF後の値は '0' 保存。右 useWidgetPrefs と同一の永続化方針)
  await widgetCheck.check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay'))).toBe('1');
  await expect(page.locator('.main-row')).toHaveClass(/sidebar-overlay/);
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);
  expect(await page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-overlay'))).toBe('0');
});
