import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { test, expect } from '@playwright/test';

// When the current directory IS $HOME, the breadcrumb renders the full path
// (root + home dir segments) instead of a lone non-navigable `~` crumb, so
// the parents of $HOME (e.g. /home) and / stay clickable. Under $HOME subdirs
// the root still renders as `~` (covered by breadcrumb-nested.spec.js).

const pathRoot = /^[a-zA-Z]:\\/.test(homedir())
  ? homedir().match(/^[a-zA-Z]:\\/)[0]
  : '/';
const parentName = basename(dirname(homedir()));
const homeName = basename(homedir());

test('breadcrumb at $HOME shows full-path crumbs and navigates to parents of home', async ({ page }) => {
  // Seed last-dir directly to $HOME (no dirs are created under it) and open
  // the browser there.
  await page.goto('/');
  await page.evaluate((d) => localStorage.setItem('ccserver-last-dir', d), homedir());
  await page.goto('/');

  // The ~ crumb must not exist; the root crumb is the literal path root.
  await expect(page.locator('.breadcrumb-item', { hasText: '~' })).not.toBeVisible();
  const rootCrumb = page.locator('.breadcrumb-item').first();
  await expect(rootCrumb).toHaveText(pathRoot);

  // Root + dirname(homedir()) basename + basename(homedir()) = 3 crumbs.
  await expect(page.locator('.breadcrumb-item')).toHaveCount(3);
  await expect(page.locator('.breadcrumb-item', { hasText: parentName })).toBeVisible();
  await expect(page.locator('.breadcrumb-item', { hasText: homeName })).toBeVisible();

  // Clicking the parent-of-home segment navigates to dirname(homedir())
  // (now outside $HOME: the root prefix stays and the home basename crumb is
  // gone). No error may appear.
  await page.locator('.breadcrumb-item', { hasText: parentName }).click();
  await expect(page.locator('.error')).not.toBeVisible();
  await expect(page.locator('.breadcrumb-item')).toHaveCount(2);
  await expect(page.locator('.breadcrumb-item').first()).toHaveText(pathRoot);
  await expect(page.locator('.breadcrumb-item', { hasText: parentName })).toBeVisible();
  await expect(page.locator('.breadcrumb-item', { hasText: homeName })).not.toBeVisible();

  // From there the root crumb navigates to "/".
  await page.locator('.breadcrumb-item').first().click();
  await expect(page.locator('.error')).not.toBeVisible();
  await expect(page.locator('.breadcrumb-item')).toHaveCount(1);
  await expect(page.locator('.breadcrumb-item').first()).toHaveText(pathRoot);
});