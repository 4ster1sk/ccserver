import { test, expect } from '@playwright/test';

// 左セッションサイドバー (常時表示パネル) の検証。
// タブの選択・終了確認モーダル系は close-confirm.spec.js 側で検証している
// ため、ここではサイドバー自体の開閉・表示・重ね表示のみ扱う。

const SKIP_KEY = 'ccserver-skip-close-confirm';
const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const sessionToggle = (page) => page.getByRole('button', { name: /セッションサイドバー/ });
const leftSidebar = (page) => page.locator('.left-sidebar');
const tabToggleBadge = (page) => page.locator('.tab-bar .session-menu-count');
const sidebarBadge = (page) => page.locator('.left-sidebar .session-menu-count');
const openedItems = (page) => leftSidebar(page).locator('[data-section="opened"] .session-menu-item');
const unopenedItems = (page) => leftSidebar(page).locator('[data-section="unopened"] .session-menu-item');

// 下段 (未オープン/リモート) の ✕ はアプリ内の確認モーダルを出す。
// 「次回以降確認しない」設定済みならモーダルなしで即終了するため、
// モーダル表示か件数減少のどちらかを待ち、出ていれば「セッションを終了」を押す。
async function confirmTerminateIfPrompted(page, count, before) {
  const btn = page.locator('.resume-overlay', { hasText: 'セッションを終了しますか?' })
    .getByRole('button', { name: 'セッションを終了', exact: true });
  await expect.poll(async () => (await btn.isVisible()) || (await count()) < before, { timeout: 10_000 }).toBe(true);
  if (await btn.isVisible()) await btn.click();
}

async function gotoApp(page) {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
}

async function openShellTab(page) {
  await page.locator('.tab-list').getByTitle('Files').click();
  await openTerminalBtn(page).click();
  await expect(tabToggleBadge(page)).toHaveText('1');
  // pty確立 (サーバー側セッション生成) を待つ。直後にタブを閉じる手順では、
  // 確立前に閉じるとサーバーにセッションが残らず下段が空になる競合を避ける。
  await expect(page.locator('.terminal-container .xterm-rows')).toContainText(/[$#%>]/, { timeout: 15_000 });
}

async function closeAllUpperSidebar(page) {
  for (let i = 0; i < 5; i++) {
    if (await tabToggleBadge(page).count() === 0) break;
    await openedItems(page).first().locator('.session-menu-close').click();
    await expect.poll(async () => tabToggleBadge(page).count(), { timeout: 10_000 }).toBe(0);
  }
}

async function terminateAllLowerSidebar(page) {
  for (let i = 0; i < 15; i++) {
    const before = await unopenedItems(page).count();
    if (before === 0) break;
    await unopenedItems(page).first().locator('.session-menu-close').click();
    await confirmTerminateIfPrompted(page, () => unopenedItems(page).count(), before);
    await expect.poll(async () => unopenedItems(page).count(), { timeout: 10_000 }).toBeLessThan(before);
  }
}

test('left panel visible by default, toggle persists', async ({ page }) => {
  await gotoApp(page);

  // サイドバーが常時表示パネルとして存在する。
  await expect(leftSidebar(page)).toBeVisible();
  await expect(sessionToggle(page)).toHaveAccessibleName('セッションサイドバーを閉じる');

  // トグルで閉じる → 永続化 → 開く → リロード後も復元。
  await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('0');

  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('1');

  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();
});

test('selecting a tab keeps the sidebar open', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);

  await openShellTab(page);
  await expect(openedItems(page)).toHaveCount(1);
  await expect(sidebarBadge(page)).toHaveText('1');

  // 選択してもサイドバーは閉じない。
  await openedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();

  // Cleanup: タブを閉じ、残った稼働セッションを終了する。
  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('session overlay is independent from widget overlay', async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => {
    localStorage.removeItem('ccserver-sidebar-overlay');
    localStorage.removeItem('ccserver-session-sidebar-overlay');
  });
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  // Settingsのチェックボックスは廃止済み。各パネル自身のヘッダーにある
  // ピン留めボタンから overlay state を切り替える (ボタンはパネルが
  // 開いている間だけ存在する)。
  await expect(leftSidebar(page)).toBeVisible();
  const sessionPin = leftSidebar(page).getByRole('button', { name: 'ピン留めを解除して前面に重ねて表示' });
  const widgetPin = page.locator('.right-sidebar').getByRole('button', { name: 'ピン留めを解除して前面に重ねて表示' });
  await expect(sessionPin).toHaveAttribute('aria-pressed', 'true');
  await expect(widgetPin).toHaveAttribute('aria-pressed', 'true');

  // 左のみ ON: session-overlay のみ付与、右キー・右クラスに影響なし。
  await sessionPin.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-overlay'))).toBe('1');
  await expect(page.locator('.main-row')).toHaveClass(/session-overlay/);
  await expect(page.locator('.main-row')).not.toHaveClass(/sidebar-overlay/);
  expect(await page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay'))).toBeNull();
  // 前面に重なる (absolute配置)。
  await expect.poll(() => page.locator('.left-sidebar').evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  const sessionUnpinned = leftSidebar(page).getByRole('button', { name: 'ピン留めして固定表示' });

  // 閉じ直しても (overlayとして) 表示され、前面に重なったままであることを確認。
  await page.getByRole('button', { name: 'セッションサイドバーを閉じる' }).click();
  await expect(leftSidebar(page)).toBeHidden();
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await expect.poll(() => page.locator('.left-sidebar').evaluate((el) => getComputedStyle(el).position)).toBe('absolute');

  await sessionUnpinned.click();
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);

  // 右のみ ON: sidebar-overlay のみ付与、左キーに影響なし。
  // (左OFF後の値は '0' 保存。右 useWidgetPrefs と同一の永続化方針)
  await widgetPin.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay'))).toBe('1');
  await expect(page.locator('.main-row')).toHaveClass(/sidebar-overlay/);
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);
  expect(await page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-overlay'))).toBe('0');
});

test('overlay時は選択で閉じる (上段・下段とも)', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await page.addInitScript(() => localStorage.setItem('ccserver-session-sidebar-overlay', '1'));
  await gotoApp(page);
  await expect(page.locator('.main-row')).toHaveClass(/session-overlay/);
  // overlay中はパネルがCLI側を覆うため、タブ起動の間は閉じておく。
  await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeHidden();
  await openShellTab(page);
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();

  // 上段選択で閉じる。
  await openedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('0');

  // Closing a local tab via X now always fully terminates its session (see
  // close-confirm.spec.js) -- there is no UI path left that detaches a tab
  // while keeping its session alive. A reload is the realistic way a
  // running session ends up in the lower ("unopened") section instead.
  // 下段選択でも閉じることを確認する。
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(unopenedItems(page)).toHaveCount(1, { timeout: 10_000 });
  await unopenedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeHidden();

  // Cleanup: 開き直してタブを閉じ、残った稼働セッションを終了する。
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('in-flowでは下段選択でも開いたまま', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);
  await openShellTab(page);

  // Closing a local tab via X now always fully terminates its session (see
  // close-confirm.spec.js); a reload is the realistic way a running session
  // ends up in the lower ("unopened") section instead.
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(unopenedItems(page)).toHaveCount(1, { timeout: 10_000 });
  await unopenedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();

  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('狭幅では重ねOFFでも選択で閉じる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);
  // 狭幅の初回は閉じた状態で始まる。先にタブを開いてから (backdropに
  // 塞がれる前に) サイドバーを開け、選択で閉じることを確認する。
  await expect(leftSidebar(page)).toBeHidden();
  await openShellTab(page);
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await openedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeHidden();

  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('lower-section ✕ uses the in-app confirm modal and shares "次回以降確認しない"', async ({ page }) => {
  await gotoApp(page);
  await terminateAllLowerSidebar(page);

  // 下段の一覧と DELETE はモックで検証する (実セッションは起動しない)。
  let sessions = [
    { id: 'lo-1', cwd: '/tmp/lower-one', app: 'claude', connected: false },
    { id: 'lo-2', cwd: '/tmp/lower-two', app: 'claude', connected: false },
  ];
  const deleted = [];
  await page.route('**/api/sessions', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ json: { sessions } })
    : route.continue()));
  await page.route('**/api/sessions/*', (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    const id = route.request().url().split('/').pop();
    deleted.push(id);
    sessions = sessions.filter((s) => s.id !== id);
    return route.fulfill({ json: { ok: true } });
  });
  let nativeDialog = false;
  page.on('dialog', (d) => { nativeDialog = true; d.dismiss().catch(() => {}); });
  await page.reload();
  await expect(unopenedItems(page)).toHaveCount(2);

  const modal = page.locator('.resume-overlay', { hasText: 'セッションを終了しますか?' });

  // キャンセルでは残る。
  await unopenedItems(page).first().locator('.session-menu-close').click();
  await expect(modal).toBeVisible();
  await expect(modal.locator('.close-confirm-target')).toHaveText('/tmp/lower-one');
  await modal.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(unopenedItems(page)).toHaveCount(2);

  // 「次回以降確認しない」付きで終了 → 永続化。
  await unopenedItems(page).first().locator('.session-menu-close').click();
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'セッションを終了', exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(unopenedItems(page)).toHaveCount(1);
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), SKIP_KEY)).toBe('1');

  // 以降はモーダルなしで即終了。
  await unopenedItems(page).first().locator('.session-menu-close').click();
  await expect(unopenedItems(page)).toHaveCount(0);
  await expect(modal).toHaveCount(0);
  expect(deleted).toEqual(['lo-1', 'lo-2']);
  expect(nativeDialog).toBe(false);
});
