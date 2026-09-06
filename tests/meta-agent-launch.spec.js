import { test, expect } from '@playwright/test';

// メタエージェント起動 UI (固定ディレクトリ + 独立ボタン):
// - 「起動方法を選択」モーダルにはメタエージェントモードが存在しない (2択のみ)
// - 専用ボタン ⌘ メタエージェント は metaAgentEnabled === true でのみ有効、無効時は tooltip と disabled
// - 有効時は専用ダイアログが開き、アプリ選択→確認チェーン→固定 metaAgentDir で isMetaAgent:true の init が飛び、⌘タブが作られる
// - 二重起動ガード / 無効化後の拒否 / silent downgrade 警告は従来のロジックを移植
//
// The enabled-state tests stub the HTTP/WS surface instead of pointing the
// webServer at a metaAgentMcp:true config: the webServer is shared across all
// specs in the run, so per-test config flips are not possible there.

const META_AGENT_DIR_STUB = '/home/tester/.local/share/ccserver-sandbox/meta-agent';

const HOME_RESPONSE_BASE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  hostname: 'e2e-meta',
  showUsage: false,
  availableApps: { claude: true, opencode: true, copilot: true, codex: true },
  metaAgentDir: META_AGENT_DIR_STUB,
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

test('launch modal no longer offers meta mode as a third toggle', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE_BASE, metaAgentEnabled: true });
  await stubSessions(page);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  // Only 2 toggles remain (通常起動 / コンボ起動)
  await expect(page.locator('.launch-mode-btn')).toHaveCount(2);
  await expect(page.locator('.launch-mode-btn', { hasText: 'メタエージェント' })).toHaveCount(0);
});

test('dedicated meta button is disabled while the feature is off server-side', async ({ page }) => {
  // The shared e2e webServer runs without sandbox.config.json -> default off.
  await page.goto('/');
  const flags = await page.evaluate(async () => {
    const res = await fetch('/api/dirs/home');
    return (await res.json()).metaAgentEnabled;
  });
  expect(flags).toBe(false);

  const metaBtn = page.locator('.meta-launch-btn');
  await expect(metaBtn).toBeVisible();
  await expect(metaBtn).toBeDisabled();
  await expect(metaBtn).toHaveAttribute('title', /metaAgentMcp/);

  // Launch modal must not contain meta mode any more (2 toggles only)
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect(page.locator('.launch-mode-btn')).toHaveCount(2);
});

test('enabled dedicated button opens dialog and launches behind a per-launch confirm', async ({ page }) => {
  const dialogs = [];
  const inits = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    await d.accept();
  });

  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });

  await stubDirsHome(page, { ...HOME_RESPONSE_BASE, metaAgentEnabled: true });
  await stubSessions(page);
  await stubTerminalWs(page, inits);

  await page.goto('/');
  const metaBtn = page.locator('.meta-launch-btn');
  await expect(metaBtn).toBeVisible();
  await expect(metaBtn).toBeEnabled();
  await metaBtn.click();

  // Dialog appears
  await expect(page.locator('.resume-dialog', { hasText: 'メタエージェントを起動' })).toBeVisible();
  await expect(page.locator('.resume-dialog', { hasText: '専用ディレクトリ' })).toContainText(META_AGENT_DIR_STUB);

  // copilot must not be offered at all: shouldInjectMetaAgent structurally
  // excludes it, so offering it would only produce silent downgrades.
  await expect(page.locator('.resume-dialog .open-menu-item', { hasText: 'GitHub Copilot' })).toHaveCount(0);
  const opencodeItem = page.locator('.resume-dialog .open-menu-item', { hasText: 'opencode' });
  await opencodeItem.click();
  await expect(opencodeItem.locator('.open-menu-check')).toHaveText('✓');
  await page.locator('.resume-dialog .btn-primary', { hasText: 'メタエージェントを起動' }).click();

  // Exactly one confirm (the privilege gate) was shown for this launch.
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0].type).toBe('confirm');
  expect(dialogs[0].message).toMatch(/特権/);

  // The tab opens with the ⌘ prefix and the meta key icon...
  // (session tabs now live in the hamburger menu at the left end).
  await page.getByRole('button', { name: 'セッション一覧メニュー' }).click();
  const tab = page.locator('.session-menu [data-section="opened"] .session-menu-item', { hasText: '⌘ meta-agent' });
  await expect(tab).toBeVisible();
  await expect(tab.locator('.tab-icon-meta')).toHaveCount(1);

  // ...and its init asked for the meta MCP explicitly with fixed dir.
  await expect.poll(() => inits.length).toBe(1);
  expect(inits[0].isMetaAgent).toBe(true);
  expect(inits[0].app).toBe('opencode');
  expect(inits[0].cwd).toBe(META_AGENT_DIR_STUB);
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
  const metaBtn = page.locator('.meta-launch-btn');
  await expect(metaBtn).toBeEnabled();
  await metaBtn.click();
  await page.locator('.resume-dialog .btn-primary', { hasText: 'メタエージェントを起動' }).click();

  // Double-launch guard first, privilege confirm second; both accepted ->
  // the launch proceeds.
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[0]).toMatch(/すでに稼働中のメタエージェント/);
  expect(dialogs[1]).toMatch(/特権/);
  await expect.poll(() => inits.length).toBe(1);
  expect(inits[0].isMetaAgent).toBe(true);
  expect(inits[0].cwd).toBe(META_AGENT_DIR_STUB);
});

test('flag turned off after the dialog opened refuses at submit time', async ({ page }) => {
  const dialogs = [];
  const inits = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.dismiss(); // alerts have only OK; dismissing records + closes
  });

  // Serves true until the test flips the variable ("config changed while the
  // dialog was open"); the launch-time recheck must then see false.
  let metaEnabled = true;
  await stubDirsHome(page, async () => ({ ...HOME_RESPONSE_BASE, metaAgentEnabled: metaEnabled }));
  await stubSessions(page);
  await stubTerminalWs(page, inits);

  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });
  await page.goto('/');
  const metaBtn = page.locator('.meta-launch-btn');
  await expect(metaBtn).toBeEnabled();
  metaEnabled = false; // the server-side config "changes" behind the open dialog
  await metaBtn.click();
  await expect(page.locator('.resume-dialog', { hasText: 'メタエージェントを起動' })).toBeVisible();
  await page.locator('.resume-dialog .btn-primary', { hasText: 'メタエージェントを起動' }).click();

  // An alert explains the refusal; no confirm chain, no session spawn.
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(/無効/);
  expect(inits.length).toBe(0);
});

test('requested but ungranted meta MCP warns inside the terminal', async ({ page }) => {
  const dialogs = [];
  const inits = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.accept();
  });

  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/tmp/opencode');
  });

  await stubDirsHome(page, { ...HOME_RESPONSE_BASE, metaAgentEnabled: true });
  await stubSessions(page);
  // echoMeta=false: the session reply carries no isMetaAgent -- what a
  // broker-less / feature-disabled server produces behind a privileged
  // request. The downgrade must be written to the terminal, not stay silent.
  await stubTerminalWs(page, inits, { echoMeta: false });

  await page.goto('/');
  const metaBtn = page.locator('.meta-launch-btn');
  await expect(metaBtn).toBeEnabled();
  await metaBtn.click();
  await page.locator('.resume-dialog .btn-primary', { hasText: 'メタエージェントを起動' }).click();

  await expect.poll(() => inits.length).toBe(1);
  expect(inits[0].isMetaAgent).toBe(true);
  expect(inits[0].cwd).toBe(META_AGENT_DIR_STUB);

  const rows = page.locator('.terminal-container .xterm-rows');
  await expect(rows).toContainText(/ccserver-meta は注入されませんでした/, { timeout: 15_000 });
});
