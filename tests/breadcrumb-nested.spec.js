import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { test, expect } from '@playwright/test';

// Regression test: breadcrumb clicks under $HOME must rebuild the full real
// path. The root crumb renders as `~` (homeBase = $HOME), so joining the
// remaining segments onto it without a leading separator glued the first
// segment onto the home path: /home/ast + "dev" became
// /home/astdev (Error: Directory not found). Every segment crumb is
// covered -- the intermediate one AND the deepest, exactly like the reported
// /home/ast/ccserver case.

let base;
let cwd;

async function openAtNestedDir(page) {
  await page.goto('/');
  // Seed last-dir to the nested dir so the browser opens there.
  await page.evaluate((d) => localStorage.setItem('ccserver-last-dir', d), cwd);
  await page.goto('/');
}

async function expectAtHomeCrumbs(page, ...segments) {
  // Still under $HOME: root is "~" with the real home in its title, and the
  // expected segment crumbs are present.
  const rootCrumb = page.locator('.breadcrumb-item', { hasText: '~' }).first();
  await expect(rootCrumb).toBeVisible();
  await expect(rootCrumb).toHaveAttribute('title', homedir());
  for (const seg of segments) {
    await expect(page.locator('.breadcrumb-item', { hasText: seg })).toBeVisible();
  }
}

test.beforeEach(() => {
  base = mkdtempSync(join(homedir(), 'ccserver-bc-'));
  cwd = join(base, 'child', 'deep');
  mkdirSync(cwd, { recursive: true });
});

test.afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test('clicking an intermediate breadcrumb under $HOME navigates to the real path', async ({ page }) => {
  await openAtNestedDir(page);
  await expectAtHomeCrumbs(page, basename(base), 'child', 'deep');

  // Clicking the "child" crumb must resolve to base/child, not a glued path
  // like /home/<user><base>/child (which 404s and drops out of $HOME).
  await page.locator('.breadcrumb-item', { hasText: 'child' }).click();
  await expect(page.locator('.error')).not.toBeVisible();
  await expectAtHomeCrumbs(page, basename(base), 'child');
  await expect(page.locator('.breadcrumb-item', { hasText: 'deep' })).not.toBeVisible();
});

test('clicking the deepest breadcrumb under $HOME navigates to the real path', async ({ page }) => {
  await openAtNestedDir(page);
  await expectAtHomeCrumbs(page, basename(base), 'child', 'deep');

  // Clicking the deepest crumb must resolve to cwd itself (still under
  // $HOME): the `~` root must remain and no error may appear. The broken
  // build glued the first segment onto the home path and fell out of
  // $HOME, which surfaced as "Error: Directory not found".
  await page.locator('.breadcrumb-item', { hasText: 'deep' }).click();
  await expect(page.locator('.error')).not.toBeVisible();
  await expectAtHomeCrumbs(page, basename(base), 'child', 'deep');
});
