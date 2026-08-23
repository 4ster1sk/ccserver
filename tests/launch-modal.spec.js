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

// --- Worker presets ---------------------------------------------------------
//
// The combo modal treats preset selections as launch-time snapshots: creating/
// editing/deleting a preset only affects FUTURE selections, never rows already
// chosen or launched groups. The server expands nothing -- the UI sends the
// canonical workers[] payload with values copied at selection time.

function stubGroupLaunch(page) {
  const captured = [];
  // Only POSTs are intercepted (GET /api/groups feeds the browser's Groups
  // panel and must pass through).
  return { captured, route: async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    captured.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ groupId: 'e2e-stub-group', cwd: '/tmp', members: [], currentTurn: null, lastHandoffAt: null }),
    });
  } };
}

async function openComboModal(page) {
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
}

// The dev webServer is reused across local runs (reuseExistingServer), so the
// preset library can hold rows from a previous run -- wipe it for isolation.
async function resetPresets(page) {
  await page.evaluate(async () => {
    const res = await fetch('/api/worker-presets');
    const data = await res.json();
    for (const p of data.presets || []) {
      await fetch(`/api/worker-presets/${p.id}`, { method: 'DELETE' });
    }
  });
}

test('worker presets: create via 管理 dialog, survive a reload, launch as a workers[] snapshot', async ({ page }) => {
  const stub = stubGroupLaunch(page);
  await page.route('**/api/groups', stub.route);
  await page.goto('/');
  await resetPresets(page);

  // Opening combo mode triggers the one-time preset fetch.
  await openComboModal(page);
  await expect(page.locator('.open-menu-label', { hasText: 'Worker プリセット' })).toBeVisible();

  // Create a preset through the management dialog.
  await page.getByRole('button', { name: 'プリセット管理' }).click();
  const dialog = page.locator('.preset-manage-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('例: 実装担当').fill('実装担当');
  await dialog.getByPlaceholder('workerImplement の形 (workerで始まる識別子)').fill('workerImplement');
  await dialog.getByPlaceholder('空 = アプリ既定').fill('gpt-5.4');
  await dialog.getByRole('button', { name: '作成' }).click();
  await expect(dialog.locator('.preset-manage-item')).toHaveCount(1);
  await dialog.getByRole('button', { name: '閉じる' }).click();

  // The library survives a full reload (SQLite persistence).
  await page.reload();
  await openComboModal(page);
  await expect(page.locator('.open-menu-preset-select option', { hasText: '実装担当' })).toHaveCount(1);

  // Selecting copies name/role/app/model into an editable row...
  await page.locator('.open-menu-preset-select').selectOption({ index: 1 });
  const row = page.locator('.open-menu-selected-worker');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.open-menu-selected-worker-name')).toHaveText('実装担当');

  // ...with a per-launch app override.
  await row.getByRole('button', { name: 'opencode', exact: true }).click();

  // Launching sends the canonical snapshot -- no workerA/workerB keys.
  await page.locator('.resume-dialog .btn-primary', { hasText: 'コンボ起動' }).click();
  await expect.poll(() => stub.captured.length).toBe(1);
  const body = stub.captured[0];
  expect(body.workers).toHaveLength(1);
  expect(body.workers[0]).toEqual({ name: '実装担当', role: 'workerImplement', app: 'opencode', model: 'gpt-5.4' });
  expect(body.workerA).toBeUndefined();
  expect(body.workerB).toBeUndefined();
});

test('worker presets: deleting a preset leaves the selected snapshot and legacy drafts intact', async ({ page }) => {
  await page.goto('/');
  await resetPresets(page);
  // Seed the library directly.
  await page.evaluate(async () => {
    await fetch('/api/worker-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'レビュー担当', role: 'workerReview', app: 'claude', model: null }),
    });
  });
  await page.reload();
  await openComboModal(page);

  await page.locator('.open-menu-preset-select').selectOption({ index: 1 });
  await expect(page.locator('.open-menu-selected-worker')).toHaveCount(1);

  // Delete the preset while its row is selected (accept the confirm dialog).
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'プリセット管理' }).click();
  const dialog = page.locator('.preset-manage-dialog');
  await dialog.locator('.preset-manage-delete').click();
  await expect(dialog.locator('.preset-manage-empty')).toBeVisible();
  await dialog.getByRole('button', { name: '閉じる' }).click();

  // The already-selected row is untouched (snapshot semantics).
  await expect(page.locator('.open-menu-selected-worker')).toHaveCount(1);
});

test('worker presets: an unavailable preset API falls back to the classic workerA/B drafts', async ({ page }) => {
  const stub = stubGroupLaunch(page);
  await page.route('**/api/groups', stub.route);
  await page.route('**/api/worker-presets*', (route) => route.abort());
  await page.goto('/');
  await openComboModal(page);

  // The classic draft UI stays fully usable; a note explains the fallback.
  await expect(page.locator('.open-menu-label', { hasText: 'ワーカーA' })).toBeVisible();
  await expect(page.getByText('プリセット一覧を取得できませんでした')).toBeVisible();

  // Launching still works through the exact legacy payload shape.
  await page.locator('.resume-dialog .btn-primary', { hasText: 'コンボ起動' }).click();
  await expect.poll(() => stub.captured.length).toBe(1);
  const body = stub.captured[0];
  expect(body.workerA).toBeDefined();
  expect(body.workerB).toBeDefined();
  expect(body.workers).toBeUndefined();
});
