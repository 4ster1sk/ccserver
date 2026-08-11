import { test, expect } from '@playwright/test';

// The browser tab title is "<hostname> ccserver" (hostname resolved
// server-side with the same precedence as the notify footer: CCSERVER_HOSTNAME
// > notify.hostname > os.hostname()), set by the client after fetching
// /api/dirs/home on mount. The static index.html fallback is "ccserver". No
// session launch needed -- the mount fetch is enough. Served from the
// production build (client/dist) by the e2e webServer, so this also covers the
// real delivery path.
test('tab title shows "<hostname> ccserver"', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/^\S+ ccserver$/);
});
