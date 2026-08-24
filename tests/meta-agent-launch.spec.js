import { test, expect } from '@playwright/test';

// メタエージェント起動 UI (launch modal's third mode):
// - disabled (with an explanation tooltip) unless the server opted into
//   metaAgentMcp -- asserted here against the real e2e webServer, which runs
//   without a sandbox.config.json, so the feature is off by default;
// - when "enabled" (stubbed /api/dirs/home), launching asks for confirmation
//   every time, spawns a terminal tab whose init payload carries
//   isMetaAgent:true (asserted via a mocked /ws/terminal), and renders the
//   ⌘-prefixed tab label + key icon;
// - a second launch while another meta agent is alive adds a second confirm;
// - flipping the server flag off between opening the modal and pressing the
//   launch button must refuse (the server would silently ignore the flag).
//
// The enabled-state tests stub the HTTP/WS surface instead of pointing the
// webServer at a metaAgentMcp:true config: the webServer is shared across all
// specs in the run, so per-test config flips are not possible there.

const HOME_RESPONSE_BASE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  hostname: 'e2e-meta',
  showUsage: false,
  availableApps: { claude: true, opencode: true, copilot: true, codex: true },
};

async function stubDirsHome(page, bodyOrFn) {
  await page.route('**/api/dirs/home', async (route) => {
    const body = typeof bodyOrFn === 'function' ? await bodyOrFn() : bodyOrFn;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function stubSessions(page, sessions = []) {
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions }),
    });
  });
}

// Mock the terminal websocket: capture every init payload and answer with a
// session-established message so the tab reaches its normal connected state
// without spawning any real process. echoMeta:false omits isMetaAgent from
// the reply to exercise the silent-downgrade path.
async function stubTerminalWs(page, inits, { echoMeta = true } = {}) {
  await page.routeWebSocket(/\/ws\/terminal$/, (ws) => {
    ws.onMessage((data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type !== 'init') return;
      inits.push(msg);
      ws.send(JSON.stringify({
        type: 'session',
        sessionId: 'e2e-meta-session',
        cwd: msg.cwd,
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        isReconnect: false,
        ...(echoMeta ? { isMetaAgent: true } : {}),
      }));
      ws.send(JSON.stringify({ type: 'schedule_state', scheduled: null, error: '' }));
    });
  });
}

test('meta agent mode exists but is disabled while the feature is off server-side', async ({ page }) => {
  // The shared e2e webServer runs without sandbox.config.json -> default off.
  await page.goto('/');
  const flags = await page.evaluate(async () => {
    const res = await fetch('/api/dirs/home');
    return (await res.json()).metaAgentEnabled;
  });
  expect(flags).toBe(false);

  await page.getByRole('button', { name: '起動方法を選択' }).click();
  const metaBtn = page.locator('.resume-dialog .launch-mode-btn', { hasText: 'メタエージェント' });
  await expect(metaBtn).toBeVisible();
  await expect(metaBtn).toHaveClass(/open-menu-item-disabled/, 'disabled mode must carry the disabled class');
  await expect(metaBtn).toHaveAttribute('title', /metaAgentMcp/);

  // Clicking the disabled button must not switch modes (still 通常起動).
  await metaBtn.click();
  await expect.poll(() => page.locator('.launch-mode-btn.active').textContent()).toBe('通常起動');
});

test('enabled meta agent mode launches behind a per-launch confirm', async ({ page }) => {
  const dialogs = [];
  const inits = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    await d.accept();
  });

  // Pin the browser to a project directory (same pattern as
  // copilot-launch.spec.js): on a first visit the directory browser would
  // otherwise still sit at "/" when the launch fires.
  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });

  await stubDirsHome(page, { ...HOME_RESPONSE_BASE, metaAgentEnabled: true });
  await stubSessions(page);
  await stubTerminalWs(page, inits);

  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();

  const metaBtn = page.locator('.resume-dialog .launch-mode-btn', { hasText: 'メタエージェント' });
  await expect(metaBtn).toBeVisible();
  await expect(metaBtn).not.toHaveClass(/open-menu-item-disabled/);
  await metaBtn.click();
  await expect.poll(() => page.locator('.launch-mode-btn.active').textContent()).toBe('メタエージェント');

  // Pick an app inside the meta pane (opencode) and launch.
  // copilot must not be offered at all: shouldInjectMetaAgent structurally
  // excludes it, so offering it would only produce silent downgrades.
  await expect(page.locator('.resume-dialog .open-menu-item', { hasText: 'GitHub Copilot' })).toHaveCount(0);
  const opencodeItem = page.locator('.resume-dialog .open-menu-item', { hasText: 'opencode' });
  await opencodeItem.click();
  // The check mark moves to opencode (the item text gains "✓", so the same
  // locator keeps resolving while its content changes).
  await expect(opencodeItem.locator('.open-menu-check')).toHaveText('✓');
  await page.locator('.resume-dialog .btn-primary', { hasText: 'メタエージェントを起動' }).click();

  // Exactly one confirm (the privilege gate) was shown for this launch.
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0].type).toBe('confirm');
  expect(dialogs[0].message).toMatch(/特権/);

  // The tab opens with the ⌘ prefix and the meta key icon...
  const tab = page.locator('.tab-item', { hasText: '⌘ opencode' });
  await expect(tab).toBeVisible();
  await expect(tab.locator('.tab-icon-meta')).toHaveCount(1);

  // ...and its init asked for the meta MCP explicitly.
  await expect.poll(() => inits.length).toBe(1);
  expect(inits[0].isMetaAgent).toBe(true);
  expect(inits[0].app).toBe('opencode');
  expect(inits[0].cwd).toBe('/tmp/opencode');
});

test('launching a second meta agent while one is live asks again', async ({ page }) => {
  const dialogs = [];
  const inits = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.accept();
  });

  await stubDirsHome(page, { ...HOME_RESPONSE_BASE, metaAgentEnabled: true });
  await stubSessions(page, [{
    id: 'live-meta',
    cwd: '/somewhere',
    connected: true,
    shell: false,
    sandbox: false,
    sandboxOpts: null,
    app: 'claude',
    model: null,
    groupId: null,
    groupRole: null,
    isMetaAgent: true,
  }]);
  await stubTerminalWs(page, inits);

  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  // Wait for the flag fetch to resolve before switching modes: the toggle is
  // inert (disabled) while metaAgentEnabled is still unknown.
  const metaBtn = page.locator('.resume-dialog .launch-mode-btn', { hasText: 'メタエージェント' });
  await expect(metaBtn).not.toHaveClass(/open-menu-item-disabled/);
  await metaBtn.click();
  await page.locator('.resume-dialog .btn-primary', { hasText: 'メタエージェントを起動' }).click();

  // Double-launch guard first, privilege confirm second; both accepted ->
  // the launch proceeds.
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[0]).toMatch(/すでに稼働中のメタエージェント/);
  expect(dialogs[1]).toMatch(/特権/);
  await expect.poll(() => inits.length).toBe(1);
  expect(inits[0].isMetaAgent).toBe(true);
});

test('flag turned off after the modal opened refuses at submit time', async ({ page }) => {
  const dialogs = [];
  const inits = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.dismiss(); // alerts have only OK; dismissing records + closes
  });

  // Serves true until the test flips the variable ("config changed while the
  // modal was open"); the launch-time recheck must then see false.
  let metaEnabled = true;
  await stubDirsHome(page, async () => ({ ...HOME_RESPONSE_BASE, metaAgentEnabled: metaEnabled }));
  await stubSessions(page);
  await stubTerminalWs(page, inits);

  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  // Wait for the mount-time (true) flag before switching modes: the toggle is
  // inert while metaAgentEnabled is still unknown.
  const metaBtn = page.locator('.resume-dialog .launch-mode-btn', { hasText: 'メタエージェント' });
  await expect(metaBtn).not.toHaveClass(/open-menu-item-disabled/);
  metaEnabled = false; // the server-side config "changes" behind the open modal
  await metaBtn.click();
  await expect.poll(() => page.locator('.launch-mode-btn.active').textContent()).toBe('メタエージェント');
  await page.locator('.resume-dialog .btn-primary', { hasText: 'メタエージェントを起動' }).click();

  // An alert explains the refusal; no confirm chain, no session spawn.
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(/無効/);
  expect(inits.length).toBe(0);
});
