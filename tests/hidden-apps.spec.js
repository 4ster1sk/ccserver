import { test, expect } from '@playwright/test';

// hiddenApps (sandbox.config.json, issue #105): agent CLI ids the operator
// hasn't contracted for. Unlike an app the server just can't find (still
// shown greyed out with a "サーバーに未インストール" tooltip), a hidden app
// must be removed ENTIRELY -- no partial/greyed hide mode -- from all 4
// launch surfaces: the single-launch modal and Usage widget app tabs.
//
// /api/dirs/home is fully stubbed so this suite is independent of what's
// actually installed/configured on the machine running it: the e2e
// webServer is shared across the whole run, so a per-test
// sandbox.config.json flip isn't possible there.

const HOME_RESPONSE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  hostname: 'e2e-hidden-apps',
  showUsage: true,
  availableApps: { claude: true, opencode: true, codex: true },
  hiddenApps: ['codex'],
};

async function stubDirsHome(page, body = HOME_RESPONSE) {
  await page.route('**/api/dirs/home', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('single-launch modal hides the configured app and keeps the others', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect(page.locator('.open-menu-item', { hasText: 'Claude Code' })).toHaveCount(1);
  await expect(page.locator('.open-menu-item', { hasText: 'opencode' })).toHaveCount(1);
  await expect(page.locator('.open-menu-item', { hasText: 'OpenAI Codex' })).toHaveCount(0);
});

test('toolbar quick-launch button is disabled (not silently sent) when the remembered default app is hidden with nothing to fall back to', async ({ page }) => {
  // Second self-review pass edge case: unlike the picker items (which block
  // their own click via chooseApp), the toolbar's quick-launch button and
  // the in-modal single-launch 起動 button fire onOpen directly with
  // whatever appDefault currently holds. The reconciliation effect corrects
  // a stale/hidden default to the first available app -- but only when one
  // exists; hiding every app at once leaves it stuck on the hidden value,
  // and without a launch-time guard this button would silently launch it.
  await page.addInitScript(() => {
    localStorage.setItem('ccserver-app-default', 'claude');
  });
  await stubDirsHome(page, { ...HOME_RESPONSE, hiddenApps: ['claude', 'opencode', 'codex'] });
  await page.goto('/');
  await expect(page.locator('.open-split-main')).toBeDisabled();
});

test('Usage widget drops the codex tab entirely when codex is hidden', async ({ page }) => {
  await stubDirsHome(page);
  await page.route('**/api/usage**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ usage: { plan: 'pro', limits: [] }, updatedAt: Date.now() }),
    });
  });
  await page.goto('/');
  const widget = page.locator('.usage-widget');
  await expect(widget).toBeVisible();
  // The tab switcher only renders when more than one app is selectable -- with
  // codex hidden, only claude is left, so it must be entirely absent (and the
  // header label is the only way to tell which app is showing).
  await expect(widget.locator('.usage-menu-header span')).toHaveText('Claude 使用量');
  await expect(widget.locator('.usage-tabs')).toHaveCount(0);
  await expect(widget.locator('.usage-tab', { hasText: 'Codex' })).toHaveCount(0);
});

test('Usage widget is fully hidden, not just tab-restricted, when hiddenApps hides every usable source and availableApps is unknown', async ({ page }) => {
  // availableApps 不明 (未フェッチ/旧サーバ相当) の状態で hiddenApps が
  // claude/codex/opencode 全部を隠した場合の回帰チェック。usageHidden の
  // 計算に `!!availableApps` ゲートが入っていると、availableApps===null の
  // ときだけ nothingUsable=true が usageHidden に反映されず、設定で隠した
  // はずの Usage ウィジェットが表示されたまま残ってしまっていた。
  await stubDirsHome(page, {
    ...HOME_RESPONSE,
    availableApps: undefined,
    hiddenApps: ['claude', 'codex', 'opencode'],
  });
  await page.goto('/');
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Usage' }),
  })).toHaveCount(0);
  await expect(page.locator('.usage-widget')).toHaveCount(0);
  await expect(page.locator('.usage-empty')).toHaveCount(0);
});
