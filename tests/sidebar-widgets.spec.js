import { test, expect } from '@playwright/test';

function mockRoutes(page, hooks = {}) {
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
          ],
        },
        updatedAt: Date.now(),
        cached: true,
      }),
    });
  });
  page.route('**/api/system-stats*', async (route) => {
    hooks.onSystemStats?.();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        uptime: 3600,
        loadAvg: [0.5, 0.4, 0.3],
        cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
        memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
        storage: [],
        temperatures: {},
        gpu: null,
        ipmi: null,
      }),
    });
  });
}

test('sidebar open state persists across a reload', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const sidebar = page.locator('.right-sidebar');
  const toggle = page.locator('.sidebar-toggle-btn');
  await expect(sidebar).toBeVisible();

  await toggle.click();
  await expect(sidebar).toBeHidden();

  await page.reload();
  await expect(page.locator('.right-sidebar')).toBeHidden();

  await page.locator('.sidebar-toggle-btn').click();
  await expect(page.locator('.right-sidebar')).toBeVisible();
});

test('hiding a widget persists across a reload', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const cpuWidget = page.locator('.widget-card', { hasText: 'CPU' });
  await expect(cpuWidget).toBeVisible();
  await cpuWidget.locator('.widget-icon-btn[title="非表示"]').click();
  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeHidden();

  await page.reload();
  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeHidden();
  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'CPU' }).click();
  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeVisible();
});

test('closing the sidebar stops system-stats polling', async ({ page }) => {
  let systemStatsHits = 0;
  mockRoutes(page, { onSystemStats: () => { systemStatsHits += 1; } });
  await page.goto('/');

  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeVisible();
  expect(systemStatsHits).toBeGreaterThanOrEqual(1);

  await page.locator('.sidebar-toggle-btn').click();
  await expect(page.locator('.right-sidebar')).toBeHidden();

  // 閉じる直前に発行済みのポーリングが到着する猶予を1回分おいてから基準値を取る
  await page.waitForTimeout(2500);
  const hitsAfterClose = systemStatsHits;
  // Default 2s interval: 4.5s of silence proves the poll stopped
  await page.waitForTimeout(4500);
  expect(systemStatsHits).toBe(hitsAfterClose);
});
