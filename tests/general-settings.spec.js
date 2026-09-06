import { test, expect } from '@playwright/test';

// Settings > 一般: テーマ・終了確認・ウィジェット重ね表示の各設定が
// 即時反映＋永続化されることを検証する。
test.describe('Settings general section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    // localStorage を初期化してデフォルト状態から始める。
    await page.evaluate(() => {
      localStorage.removeItem('ccserver-theme');
      localStorage.removeItem('ccserver-skip-close-confirm');
      localStorage.removeItem('ccserver-sidebar-overlay');
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings-view')).toBeVisible();
  });

  test('theme select changes and persists', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const select = panel.getByLabel('テーマ');
    await expect(select).toBeVisible();
    await select.selectOption('dracula');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-theme')))
      .toBe('dracula');
    // テーマCSSが即時適用される (Dracula の --bg-primary)。
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
        )
      )
      .toBe('#282a36');
  });

  test('no theme picker in terminal header', async ({ page }) => {
    // shellタブを開いても、CLI上部のテーマ切り替えは存在しない
    // (一般設定に移植済み)。
    await page.locator('.tab-item', { hasText: 'Files' }).click();
    const closeButtons = page.locator('.tab-item .tab-close');
    const before = await closeButtons.count();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(closeButtons).toHaveCount(before + 1);
    await expect(page.locator('.terminal-header')).toBeVisible();
    await expect(page.locator('.terminal-header .theme-picker')).toHaveCount(0);
  });

  test('close confirm checkbox toggles skip flag', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const check = panel.getByLabel('タブを閉じる前に確認する');
    await expect(check).toBeChecked();
    await check.uncheck();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-skip-close-confirm')))
      .toBe('1');
    await check.check();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-skip-close-confirm')))
      .toBeNull();
  });

  test('sidebar overlay checkbox toggles overlay mode', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const check = panel.getByLabel('ウィジェットをCLIの上に重ねて表示する');
    await expect(check).not.toBeChecked();
    await check.check();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay')))
      .toBe('1');
    await expect(page.locator('.main-row')).toHaveClass(/sidebar-overlay/);
    // 重ね表示中もタブバーのトグルボタンはサイドバーに覆われず、
    // クリックで閉じられる (サイドバー自体に閉じるボタンはないため)。
    const toggle = page.getByRole('button', { name: 'サイドバーを閉じる' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('.right-sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'サイドバーを開く' }).click();
    await expect(page.locator('.right-sidebar')).toBeVisible();
    await check.uncheck();
    await expect(page.locator('.main-row')).not.toHaveClass(/sidebar-overlay/);
  });
});
