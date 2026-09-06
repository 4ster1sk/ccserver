import { test, expect } from '@playwright/test';

// Settings 左メニュー: 3項目の表示と切り替えを検証する。
// サンドボックス/ペアリングの実データには依存しない (見出しと空表示の
// いずれかが現れればよい) ため、bwrap 等の環境条件は不要。
test.describe('Settings left menu', () => {
  test('menus switch sections', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();

    // Settings タブを開く (DirectoryBrowser のギアボタン)。
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-view');
    await expect(settings).toBeVisible();

    // 左メニューの3項目がタブとして表示される。
    const sidebar = settings.locator('.settings-sidebar');
    await expect(sidebar.getByRole('tab', { name: '作成済みサンドボックス' })).toBeVisible();
    await expect(sidebar.getByRole('tab', { name: 'ペアリング済みインスタンス' })).toBeVisible();
    await expect(sidebar.getByRole('tab', { name: '一般' })).toBeVisible();
    const panel = settings.locator('[role="tabpanel"]');
    await expect(panel).toBeVisible();

    // 初期選択はサンドボックス。
    await expect(sidebar.getByRole('tab', { name: '作成済みサンドボックス' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('作成済みサンドボックス');

    // ペアリングに切り替え。
    await sidebar.getByRole('tab', { name: 'ペアリング済みインスタンス' }).click();
    await expect(sidebar.getByRole('tab', { name: 'ペアリング済みインスタンス' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('ペアリング済みインスタンス');

    // 一般 (プレースホルダ) に切り替え。
    await sidebar.getByRole('tab', { name: '一般' }).click();
    await expect(sidebar.getByRole('tab', { name: '一般' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('一般設定は準備中です');

    // サンドボックスに戻れる。
    await sidebar.getByRole('tab', { name: '作成済みサンドボックス' }).click();
    await expect(panel).toContainText('作成済みサンドボックス');
  });
});
