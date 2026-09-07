import { test, expect } from '@playwright/test';

// bwrap missing on the server host (/api/dirs/home's sandboxAvailable):
// the sandbox choice (and combo mode, which always requires it) must be
// unselectable instead of failing at launch time. Missing field = older
// server: everything stays enabled (same fallback as availableApps).
//
// /api/dirs/home is fully stubbed so this suite is independent of the
// machine running it -- same pattern as hidden-apps.spec.js.

const HOME_RESPONSE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  hostname: 'e2e-no-bwrap',
  showUsage: true,
  availableApps: { claude: true, opencode: true, copilot: true, codex: true },
  hiddenApps: [],
  metaAgentEnabled: false,
  metaAgentDir: null,
  sandboxAvailable: false,
};

async function stubDirsHome(page, body = HOME_RESPONSE) {
  await page.route('**/api/dirs/home', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('sandbox choice is disabled and a remembered sandbox default is corrected', async ({ page }) => {
  await stubDirsHome(page);
  // A stale 'prefer sandbox' memory from a host that had bwrap must not
  // survive: the fetch reconciliation forces 通常起動.
  await page.addInitScript(() => localStorage.setItem('ccserver-sandbox-default', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();

  const sandboxItem = page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });
  await expect(sandboxItem).toHaveClass(/open-menu-item-disabled/);
  await expect(sandboxItem).toHaveAttribute('title', /bwrap/);

  // Clicking the disabled choice must not check it -- 通常起動 stays checked.
  await sandboxItem.click();
  const normalItem = page.locator('.open-menu-item', { hasText: '通常起動' });
  await expect(normalItem.locator('.open-menu-check')).toHaveText('✓');
  await expect(sandboxItem.locator('.open-menu-check')).toHaveText('');

  // The explanatory note names the cause (scoped to the modal: the same
  // message also shows in the browser header box).
  await expect(page.locator('.resume-dialog .open-menu-note', { hasText: 'bwrapがインストールされていないため' })).toBeVisible();
});

test('toolbar quick-launch drops the lock icon when bwrap is missing', async ({ page }) => {
  await stubDirsHome(page);
  await page.addInitScript(() => localStorage.setItem('ccserver-sandbox-default', '1'));
  await page.goto('/');
  const main = page.locator('.open-split-main');
  await expect(main).not.toContainText('🔒');
  await expect(main).toHaveAttribute('title', '通常起動');
});

test('combo mode is disabled when bwrap is missing', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  const comboBtn = page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' });
  await expect(comboBtn).toBeDisabled();
  await comboBtn.click({ force: true });
  // Still in single mode: the combo-only launch button must not appear.
  await expect(page.locator('.resume-dialog .btn-primary', { hasText: 'コンボ起動' })).toHaveCount(0);
  await expect(page.locator('.launch-mode-btn.active')).toHaveText('通常起動');
});

test('forceSandbox without bwrap shows a warning instead of a dead locked toggle', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE, forceSandbox: true });
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect(page.locator('.resume-dialog .open-menu-note', { hasText: 'bwrapが無いため起動できません' })).toBeVisible();
  // The toggle stays locked on sandbox (no misleading check on 通常起動).
  const sandboxItem = page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });
  await expect(sandboxItem.locator('.open-menu-check')).toHaveText('✓');
});

test('browser header shows a warning box under the subtitle when bwrap is missing', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  const banner = page.locator('.directory-warning-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText('サンドボックス起動・コンボ起動はできません');
  await expect(banner).not.toHaveClass(/is-error/);
});

test('browser header shows an error box when forceSandbox contradicts the missing bwrap', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE, forceSandbox: true });
  await page.goto('/');
  const banner = page.locator('.directory-warning-banner.is-error');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('bwrapが無いため起動できません');
});

test('no header box while the capability is unknown or present', async ({ page }) => {
  const { sandboxAvailable: _dropped, ...legacy } = HOME_RESPONSE;
  await stubDirsHome(page, legacy);
  await page.goto('/');
  await expect(page.locator('.directory-warning-banner')).toHaveCount(0);
});

test('forceSandbox without bwrap disables the launch buttons', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE, forceSandbox: true, metaAgentEnabled: true });
  await page.goto('/');
  // Toolbar quick-launch, Terminal, and meta buttons: nothing can succeed.
  await expect(page.locator('.open-split-main')).toBeDisabled();
  await expect(page.locator('.toolbar-launch-group .launch-btn', { hasText: 'Terminal' })).toBeDisabled();
  await expect(page.locator('.meta-launch-btn')).toBeDisabled();
  // In-modal single-launch button too.
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect(page.locator('.resume-dialog .btn-primary', { hasText: '起動' })).toBeDisabled();
});

test('missing sandboxAvailable (older server) keeps the sandbox choice enabled', async ({ page }) => {
  const { sandboxAvailable: _dropped, ...legacy } = HOME_RESPONSE;
  await stubDirsHome(page, legacy);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  const sandboxItem = page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });
  await expect(sandboxItem).not.toHaveClass(/open-menu-item-disabled/);
  await sandboxItem.click();
  await expect(sandboxItem.locator('.open-menu-check')).toHaveText('✓');
});
