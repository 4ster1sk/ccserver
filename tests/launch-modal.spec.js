import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveApp, SANDBOX_PATH } from '../server/ws/sandbox.js';

// The launch modal's combo-mode state must not persist across closes: a
// user who glances at combo mode, cancels, and later opens the modal for a
// different project must be back in plain single mode -- otherwise the
// "起動" button silently fires a full combo spawn (3 sandboxed sessions)
// with the previous project's orchestrator instructions.
test('launch modal resets to single mode after cancel', async ({ page }) => {
  await page.goto('/');
  const openLaunchModal = async () => {
    await page.getByRole('button', { name: '起動方法を選択' }).click();
  };
  const activeMode = () => page.locator('.launch-mode-btn.active').textContent();

  await openLaunchModal();
  await expect.poll(activeMode).toBe('通常起動');

  // Enter combo mode and write some instructions.
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  await expect.poll(activeMode).toBe('コンボ起動');
  const instructions = page.locator('.open-menu-instructions');
  await instructions.fill('do the thing for project X');

  // Cancel closes the modal.
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('.resume-overlay')).toHaveCount(0);

  // Reopening must show single mode with a clean instructions box.
  await openLaunchModal();
  await expect.poll(activeMode).toBe('通常起動');
  await expect(page.locator('.resume-dialog .btn-primary', { hasText: '起動' })).toBeVisible();
  await expect(page.locator('.resume-dialog .btn-primary', { hasText: 'コンボ起動' })).toHaveCount(0);

  // The instructions field only renders in combo mode -- flip back into it
  // and confirm the previous project's text is gone.
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  await expect(page.locator('.open-menu-instructions')).toHaveValue('');
});

test('launch modal resets to single mode after an overlay-click close', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  await expect.poll(() => page.locator('.launch-mode-btn.active').textContent()).toBe('コンボ起動');

  // Overlay click (outside the dialog) closes too.
  await page.locator('.resume-overlay').click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.resume-overlay')).toHaveCount(0);

  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect.poll(() => page.locator('.launch-mode-btn.active').textContent()).toBe('通常起動');
});

// Combo mode's per-role app picks are remembered in localStorage
// (ccserver-combo-apps): they survive modal closes and full reloads, so the
// next combo launch starts with the previous selections instead of the
// claude/opencode defaults.
function appResolves(app) {
  try {
    const r = resolveApp(app).command;
    if (r.startsWith('/')) return existsSync(r);
    return SANDBOX_PATH.split(':').some((dir) => dir && existsSync(join(dir, r)));
  } catch {
    return false;
  }
}

// The test switches every role to opencode, so it only makes sense where
// opencode is actually installable (plain CI runners have neither CLI).
test.skip(!appResolves('opencode'), 'opencode not installed — nothing to persist');

test('combo role app picks persist across a reload', async ({ page }) => {
  await page.goto('/');
  const openLaunchModal = async () => {
    await page.getByRole('button', { name: '起動方法を選択' }).click();
  };
  const roleAppRow = (label) =>
    page.locator('.open-menu-label', { hasText: label }).locator('xpath=following-sibling::div[1]');
  const activeApp = (label) => roleAppRow(label).locator('.open-menu-app-btn.active');

  await openLaunchModal();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  await expect.poll(() => page.locator('.launch-mode-btn.active').textContent()).toBe('コンボ起動');

  // Switch every role to opencode.
  for (const label of ['ワーカーA', 'ワーカーB', 'オーケストレーター']) {
    await roleAppRow(label).getByRole('button', { name: 'opencode', exact: true }).click();
    await expect(activeApp(label)).toHaveText('opencode');
  }

  // A plain modal close must not forget the picks...
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('.resume-overlay')).toHaveCount(0);

  // ...and neither must a full reload: the next combo launch reopens with
  // all three roles still on opencode.
  await page.reload();
  await openLaunchModal();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  await expect.poll(() => page.locator('.launch-mode-btn.active').textContent()).toBe('コンボ起動');
  for (const label of ['ワーカーA', 'ワーカーB', 'オーケストレーター']) {
    await expect(activeApp(label)).toHaveText('opencode');
  }
});
