import { test, expect } from '@playwright/test';

// The Usage popover must remember the app the user last picked across page
// loads (localStorage `ccserver-usage-app`) instead of resetting to the
// active terminal tab's app every time an OpenCode (or any) terminal is
// opened/activated. Real CLI capture is not needed: both server endpoints are
// mocked with distinct fixture percentages (claude=10, codex=55) so the badge
// and pct prove which app's data is on screen.

function mockRoutes(page, { defaultApp = 'claude', availableApps = { claude: true, codex: true } } = {}) {
  page.route('**/api/dirs/home*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        home: '/home/test',
        defaultApp,
        forceSandbox: false,
        hostname: 'test',
        showUsage: true,
        availableApps,
      }),
    });
  });
  page.route('**/api/usage**', async (route) => {
    const app = new URL(route.request().url()).searchParams.get('app') || 'claude';
    const pct = app === 'codex' ? 55 : 10;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          plan: 'pro',
          limits: [
            { label: 'Current session', pct, resets: '5h', resetAt: Date.now() + 5 * 3600_000, windowMs: 5 * 3600_000 },
            { label: 'Weekly limit', pct: Math.min(90, pct + 20), resets: '3d', resetAt: Date.now() + 3 * 86400_000, windowMs: 7 * 86400_000 },
          ],
        },
        updatedAt: Date.now(),
        cached: true,
      }),
    });
  });
}

const badge = () => page.locator('.usage-btn .usage-btn-app');
const pct = () => page.locator('.usage-btn .usage-btn-pct');
let page;

test.beforeEach(async ({ page: p }) => {
  page = p;
});

test('a saved codex choice survives opening the app with a claude defaultApp', async () => {
  // Regression for the old behavior: defaultApp:'claude' (e.g. active OpenCode
  // tab) must not override the persisted codex selection.
  mockRoutes(page, { defaultApp: 'claude' });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'codex');
  });
  await page.goto('/');

  await expect(badge()).toHaveText('(codex)');
  await expect(pct()).toHaveText('55%');
});

test('the choice made in the popover persists across a reload', async () => {
  mockRoutes(page);
  await page.goto('/');

  await expect(badge()).toHaveText('(claude)');
  await page.locator('.usage-btn').click();
  const menu = page.locator('.usage-menu');
  await expect(menu).toBeVisible();
  await menu.locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(badge()).toHaveText('(codex)');
  await page.locator('.tab-bar-spacer').click();
  await expect(page.locator('.usage-menu')).toBeHidden();

  // Simulates closing/reopening or refocusing the browser on an OpenCode tab:
  // the same document reloads, but the saved pick must still win.
  await page.reload();

  await expect(badge()).toHaveText('(codex)');
  await expect(pct()).toHaveText('55%');
});

test('a saved claude choice falls back to codex when claude is unavailable', async () => {
  mockRoutes(page, { availableApps: { claude: false, codex: true } });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'claude');
  });
  await page.goto('/');

  await expect(badge()).toHaveText('(codex)');
  await expect(pct()).toHaveText('55%');
});

test('a saved codex choice falls back to claude when codex is unavailable', async () => {
  mockRoutes(page, { availableApps: { claude: true, codex: false } });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'codex');
  });
  await page.goto('/');

  await expect(badge()).toHaveText('(claude)');
  await expect(pct()).toHaveText('10%');
});

test('a saved opencode choice falls back to the defaultApp seed without Go support', async () => {
  mockRoutes(page, { defaultApp: 'claude' });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'opencode');
  });
  await page.goto('/');

  await expect(badge()).toHaveText('(claude)');
});

test('a saved opencode choice survives a reload when Go is available', async () => {
  mockRoutes(page, { availableApps: { claude: true, codex: true, opencodeGo: true } });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'opencode');
  });
  await page.goto('/');

  await expect(badge()).toHaveText('(opencode)');
});
