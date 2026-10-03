import { test, expect } from '@playwright/test';

// Settings > QEMU VM: テンプレートの作成・検証エラー表示・既定指定・削除と、
// 稼働中VM一覧の空表示。VM の起動自体は行わない (KVM 不要)。
test.describe('QEMU VM settings', () => {
  test('create, validate, set default and delete a template', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-list').getByTitle('Settings').click();
    const settings = page.locator('.settings-view');
    await settings.locator('.settings-sidebar').getByRole('tab', { name: 'QEMU VM' }).click();
    const panel = settings.locator('[role="tabpanel"]');
    await expect(panel).toContainText('VMテンプレート');
    await expect(panel).toContainText('稼働中のVMはありません。');

    await panel.getByRole('button', { name: '新規作成' }).click();
    const form = panel.locator('.vm-form');
    await form.getByLabel('名前').fill('e2e-big');
    await form.getByLabel('CPU (コア)').fill('4');
    // 禁止キーは保存時にサーバーが拒否し、フォームにエラーを出す。
    await form.locator('#vm-template-cloud-config').fill('users:\n  - name: x\n');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form.locator('.vm-form-error')).toContainText('"users" is not allowed');

    await form.locator('#vm-template-cloud-config').fill('packages:\n  - htop\n');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(panel.locator('.vm-form')).toHaveCount(0);
    const row = panel.locator('.sandbox-row', { hasText: 'e2e-big' });
    await expect(row).toContainText('4 CPU');
    await expect(row).toContainText('cloud-config あり');

    await row.getByRole('button', { name: '既定にする' }).click();
    await expect(row).toContainText('既定');
    await expect(row.getByRole('button', { name: '既定を解除' })).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'e2e-big を削除' }).click();
    await expect(panel.locator('.sandbox-row', { hasText: 'e2e-big' })).toHaveCount(0);
  });
});
