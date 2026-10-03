import { test, expect } from '@playwright/test';

// 旧形式のディレクトリ別記憶 ({gpg, sshAgent} のみ・tools キー不在) では
// tools 項目が未選択扱いとなり、Settings > 一般のグローバル既定値に
// フォールバックすること (一律 true にならないこと) を検証する。
// 明示保存された true/false は引き続き記憶が優先される。

const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const launchMenuBtn = (page) => page.getByRole('button', { name: '起動方法を選択' });
// Scoped to the launch dialog: Settings is now a permanent (always-mounted)
// tab, so its General section's identically-labeled checkboxes ("rtk を導入
// する" / "code-review-graph MCP を導入する") are also in the DOM and would
// otherwise make an unscoped getByLabel ambiguous.
const launchDialog = (page) => page.locator('.resume-dialog.open-dialog');
const rtkCheck = (page) => launchDialog(page).getByLabel('rtk を導入する (sandbox 内にインストール)');
const crgCheck = (page) => launchDialog(page).getByLabel('code-review-graph MCP を導入する');

// currentPath は初回 '/' (ccserver-last-dir 未設定時)。起動メニューは
// currentPath に対する sandboxOpts を表示するため、'/' への記憶で足りる。
async function seedOldFormatMemory(page) {
  await page.evaluate(() => {
    localStorage.setItem('ccserver-default-sandbox-rtk', '0');
    localStorage.setItem('ccserver-default-sandbox-code-review-graph', '0');
    localStorage.setItem('ccserver-sandbox-opts:/', JSON.stringify({ gpg: false, sshAgent: false }));
  });
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
}

test('旧形式の記憶 + グローバルOFF では tools がオフで表示される', async ({ page }) => {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
  await seedOldFormatMemory(page);

  await launchMenuBtn(page).click();
  await expect(rtkCheck(page)).not.toBeChecked();
  await expect(crgCheck(page)).not.toBeChecked();
  await page.getByRole('button', { name: 'キャンセル' }).click();
});

test('明示保存された tools=true はグローバルOFFでも記憶が優先される', async ({ page }) => {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('ccserver-default-sandbox-rtk', '0');
    localStorage.setItem('ccserver-default-sandbox-code-review-graph', '0');
    localStorage.setItem(
      'ccserver-sandbox-opts:/',
      JSON.stringify({ gpg: false, sshAgent: false, tools: { rtk: true, codeReviewGraph: true } })
    );
  });
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();

  await launchMenuBtn(page).click();
  await expect(rtkCheck(page)).toBeChecked();
  await expect(crgCheck(page)).toBeChecked();
  await page.getByRole('button', { name: 'キャンセル' }).click();
});

// サンドボックス方式 (bwrap / VM) の選択: ディレクトリ別に記憶され、VM を
// 選ぶと VMテンプレート選択が出て VM 非対応の項目が無効になる。
// KVM の無い CI でも両方式が使える前提を作るため /api/dirs/home を差し替える。
test('サンドボックス方式の選択が記憶され、VM ではテンプレート選択が出る', async ({ page }) => {
  await page.route('**/api/dirs/home', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: {
        ...body,
        sandboxAvailable: true,
        sandboxBackends: { default: 'bwrap', bwrap: { ok: true, reason: null }, qemu: { ok: true, reason: null, hint: null } },
        toolsAvailable: { rtk: true, codeReviewGraph: true },
      },
    });
  });
  await page.route('**/api/vm-templates', (route) => route.fulfill({
    json: { templates: [{ id: 't1', name: 'big', cpus: 4, memoryMiB: 8192, diskGiB: 64, bootTimeoutSec: 120, cloudConfig: '' }] },
  }));
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();

  await launchMenuBtn(page).click();
  const backendSelect = launchDialog(page).getByLabel('方式');
  await expect(backendSelect).toHaveValue('');
  await expect(launchDialog(page).getByLabel('VMテンプレート')).toHaveCount(0);

  await backendSelect.selectOption('qemu');
  const tplSelect = launchDialog(page).getByLabel('VMテンプレート');
  await expect(tplSelect).toBeVisible();
  await tplSelect.selectOption('t1');
  await expect(rtkCheck(page)).toBeDisabled();
  await expect(launchDialog(page)).toContainText('VMでは使えません');
  await page.getByRole('button', { name: 'キャンセル' }).click();

  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await launchMenuBtn(page).click();
  await expect(launchDialog(page).getByLabel('方式')).toHaveValue('qemu');
  await expect(launchDialog(page).getByLabel('VMテンプレート')).toHaveValue('t1');

  await launchDialog(page).getByLabel('方式').selectOption('bwrap');
  await expect(launchDialog(page).getByLabel('VMテンプレート')).toHaveCount(0);
  await expect(rtkCheck(page)).toBeEnabled();
  await page.getByRole('button', { name: 'キャンセル' }).click();
});
