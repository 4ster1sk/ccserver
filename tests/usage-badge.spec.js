import { test, expect } from '@playwright/test';

// The Usage button must always show which app's numbers it is displaying via
// a "(claude)" / "(codex)" badge next to the session percentage, and the
// badge must follow the popover's app selection. Real CLI capture is not
// needed here: both server endpoints are mocked so the fixture percentages
// (claude=10, codex=55) prove which app's data is on screen.

function mockRoutes(page) {
  page.route('**/api/dirs/home*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        home: '/home/test',
        defaultApp: 'claude',
        forceSandbox: false,
        hostname: 'test',
        showUsage: true,
        availableApps: { claude: true, codex: true },
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
let page;

test.beforeEach(async ({ page: p }) => {
  page = p;
  mockRoutes(page);
  await p.goto('/');
});

test('badge shows (claude) and the claude percentage on initial render', async () => {
  const btn = page.locator('.usage-btn');
  await expect(btn.locator('.usage-btn-pct')).toHaveText('10%');
  await expect(badge()).toHaveText('(claude)');
});

test('switching apps in the popover flips the badge and the numbers', async () => {
  await page.locator('.usage-btn').click();
  const menu = page.locator('.usage-menu');
  await expect(menu).toBeVisible();

  await menu.locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(badge()).toHaveText('(codex)');
  // The fetch is re-issued for codex, so the pct must switch to its fixture.
  await expect(page.locator('.usage-btn .usage-btn-pct')).toHaveText('55%');
});

test('the badge persists after the popover is closed', async () => {
  await page.locator('.usage-btn').click();
  await page.locator('.usage-menu').locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(badge()).toHaveText('(codex)');

  // Close via outside mousedown, then confirm the badge survives.
  await page.locator('.tab-bar-spacer').click();
  await expect(page.locator('.usage-menu')).toBeHidden();
  await expect(badge()).toHaveText('(codex)');
  await expect(page.locator('.usage-btn .usage-btn-pct')).toHaveText('55%');
});
