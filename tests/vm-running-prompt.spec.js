import { test, expect } from '@playwright/test';

// VM (qemu) launches skip the "前回利用したサンドボックスがあります" reuse
// dialog and keep the previous HOME; when they would boot a new VM while
// others already run they warn first ("起動中のVMがあります": continue /
// cancel) -- joining a running persistent VM does not. bwrap launches keep
// the reuse dialog.
//
// Everything the decision depends on is stubbed (/api/dirs/home for the
// backend availability, /api/sessions for the duplicate check,
// /api/sandbox/status for the running VMs), so neither KVM nor bwrap nor an
// agent CLI is needed on the runner. Only the `init` frame the launch sends
// is asserted -- whether the server can actually start it doesn't matter.

const CWD = '/tmp/ccserver-e2e-vm-running';

const RUNNING_VMS = [
  { kind: 'pool', id: 'vm-a', templateName: 'dev', sessionCount: 2, idle: false },
  { kind: 'session', id: 's1', templateName: null, cwd: '/srv/other', app: 'claude' },
];

function sentInits(page) {
  const frames = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (e) => {
      try {
        const m = JSON.parse(e.payload);
        if (m.type === 'init') frames.push(m);
      } catch { /* not JSON */ }
    });
  });
  return frames;
}

async function setup(page, { backend, status, vmTemplateId = null }) {
  await page.route('**/api/dirs/home', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({
      response,
      json: {
        ...json,
        availableApps: null,
        hiddenApps: [],
        sandboxAvailable: true,
        sandboxBackends: { default: 'bwrap', bwrap: { ok: true, reason: null }, qemu: { ok: true, reason: null, hint: null } },
      },
    });
  });
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { sessions: [] } });
  });
  const statusUrls = [];
  await page.route('**/api/sandbox/status?*', (route) => {
    statusUrls.push(route.request().url());
    return route.fulfill({ json: status });
  });
  await page.addInitScript(({ dir, backend, vmTemplateId }) => {
    localStorage.setItem('ccserver-last-dir', dir);
    localStorage.setItem('ccserver-sandbox-default', '1');
    localStorage.setItem(`ccserver-sandbox-opts:${dir}`, JSON.stringify({ backend, vmTemplateId, sshAgent: false }));
  }, { dir: CWD, backend, vmTemplateId });
  await page.goto('/');
  await expect(page.locator('.open-split-main')).toBeEnabled();
  return statusUrls;
}

const launch = (page) => page.locator('.open-split-main').click();

test('VM launch with other VMs running warns, and "そのまま起動する" launches', async ({ page }) => {
  const inits = sentInits(page);
  const statusUrls = await setup(page, {
    backend: 'qemu',
    status: { enabled: true, exists: true, path: '/x', inUse: 0, backend: 'qemu', runningVms: RUNNING_VMS },
  });

  await launch(page);
  await expect(page.getByText('起動中のVMがあります')).toBeVisible();
  await expect(page.getByText('前回利用したサンドボックスがあります')).toHaveCount(0);
  await expect(page.locator('.vm-running-list li')).toHaveText([
    'VM dev（常駐・2セッション）',
    'VM 既定設定（/srv/other）',
  ]);
  expect(statusUrls[0]).toContain('backend=qemu');
  await page.waitForTimeout(300);
  expect(inits.length).toBe(0);

  await page.getByRole('button', { name: 'そのまま起動する' }).click();
  await expect(page.locator('.resume-overlay')).toHaveCount(0);
  await expect.poll(() => inits.length).toBeGreaterThan(0);
  expect(inits[0]).toMatchObject({ cwd: CWD, sandbox: true });
  expect(inits[0].reuseSandboxHome).not.toBe(false);
});

test('cancelling the running-VM warning launches nothing', async ({ page }) => {
  const inits = sentInits(page);
  await setup(page, {
    backend: 'qemu',
    status: { enabled: true, exists: true, path: '/x', inUse: 0, backend: 'qemu', runningVms: RUNNING_VMS },
  });

  await launch(page);
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('.resume-overlay')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(inits.length).toBe(0);
});

test('VM launch with no VM running opens without any dialog', async ({ page }) => {
  const inits = sentInits(page);
  await setup(page, {
    backend: 'qemu',
    status: { enabled: true, exists: true, path: '/x', inUse: 0, backend: 'qemu', runningVms: [] },
  });

  await launch(page);
  await expect.poll(() => inits.length).toBeGreaterThan(0);
  await expect(page.getByText('前回利用したサンドボックスがあります')).toHaveCount(0);
  await expect(page.getByText('起動中のVMがあります')).toHaveCount(0);
  expect(inits[0].reuseSandboxHome).not.toBe(false);
});

test('VM launch that joins a running persistent VM opens without the warning', async ({ page }) => {
  const inits = sentInits(page);
  const statusUrls = await setup(page, {
    backend: 'qemu',
    vmTemplateId: 't-test',
    status: {
      enabled: true, exists: true, path: '/x', inUse: 0, backend: 'qemu', joinsRunningVm: true,
      runningVms: [{ kind: 'pool', id: 'vm-a', templateName: 'test', sessionCount: 1, idle: false }],
    },
  });

  await launch(page);
  await expect.poll(() => inits.length).toBeGreaterThan(0);
  await expect(page.getByText('起動中のVMがあります')).toHaveCount(0);
  await expect(page.getByText('前回利用したサンドボックスがあります')).toHaveCount(0);
  expect(statusUrls[0]).toContain('vmTemplateId=t-test');
});

test('bwrap launch with a previous sandbox still shows the reuse dialog', async ({ page }) => {
  await setup(page, {
    backend: 'bwrap',
    status: { enabled: true, exists: true, path: '/x', inUse: 0, backend: 'bwrap' },
  });

  await launch(page);
  await expect(page.getByText('前回利用したサンドボックスがあります')).toBeVisible();
  await expect(page.getByText('起動中のVMがあります')).toHaveCount(0);
});
