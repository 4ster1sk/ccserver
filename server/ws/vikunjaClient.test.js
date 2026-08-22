// vikunjaClient.js -- Vikunja task tracking for ccserver-notify. Tests the
// config parsing precedence and the createOrUpdateTask lifecycle against a
// mocked global.fetch (same pattern as notify.test.js), plus the retry/
// no-retry contract and the "never log the token" requirement from
// tmp/notify-vikunja-integration-plan.md section 3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vikunjaEnabled, vikunjaConfig, createOrUpdateTask } from './vikunjaClient.js';

const VIKUNJA_ENV_KEYS = [
  'CCSERVER_VIKUNJA_BASE_URL',
  'CCSERVER_VIKUNJA_API_TOKEN',
  'CCSERVER_VIKUNJA_PROJECT_ID',
  'CCSERVER_VIKUNJA_TIMEOUT_SECONDS',
  'CCSERVER_VIKUNJA_VERIFY_TLS',
  'CCSERVER_VIKUNJA_STATUS_LABEL_PREFIX',
];

// Points CCSERVER_SANDBOX_CONFIG + CCSERVER_VIKUNJA_TASKS_PATH at temp files
// and clears any CCSERVER_VIKUNJA_* env leak, mirroring notify.test.js's
// withNotifyConfig.
async function withVikunjaConfig(vikunjaJson, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-vikunja-'));
  const cfgPath = join(dir, 'sandbox.config.json');
  const tasksPath = join(dir, 'vikunja-tasks.json');
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  const prevTasksPath = process.env.CCSERVER_VIKUNJA_TASKS_PATH;
  const prevEnv = Object.fromEntries(VIKUNJA_ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    writeFileSync(cfgPath, JSON.stringify({ notify: { vikunja: vikunjaJson } }));
    process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
    process.env.CCSERVER_VIKUNJA_TASKS_PATH = tasksPath;
    for (const k of VIKUNJA_ENV_KEYS) delete process.env[k];
    await fn(tasksPath);
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    if (prevTasksPath === undefined) delete process.env.CCSERVER_VIKUNJA_TASKS_PATH;
    else process.env.CCSERVER_VIKUNJA_TASKS_PATH = prevTasksPath;
    for (const k of VIKUNJA_ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function fakeRes(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// A fetch mock that understands the fixed set of Vikunja endpoints this
// client calls (see vikunjaClient.js's header comment for the verified
// paths). `onRequest` can intercept any call before the default handling to
// inject failures.
function makeMock({ onRequest } = {}) {
  const calls = [];
  let nextTaskId = 100;
  let nextLabelId = 1;
  const fn = async (url, opts) => {
    const u = String(url);
    const method = opts.method;
    const path = new URL(u).pathname;
    const record = { url: u, method, path, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(record);
    if (onRequest) {
      const custom = onRequest(record, calls);
      if (custom) return custom;
    }
    if (method === 'GET' && path === '/api/v1/labels') return fakeRes(200, []);
    if (method === 'PUT' && path === '/api/v1/labels') return fakeRes(201, { id: nextLabelId++, title: record.body.title });
    if (method === 'PUT' && /^\/api\/v1\/projects\/\d+\/tasks$/.test(path)) return fakeRes(201, { id: nextTaskId++ });
    if (method === 'PUT' && /^\/api\/v1\/tasks\/\d+\/comments$/.test(path)) return fakeRes(201, { id: 1 });
    if (method === 'PUT' && /^\/api\/v1\/tasks\/\d+\/labels$/.test(path)) return fakeRes(201, {});
    if (method === 'DELETE' && /^\/api\/v1\/tasks\/\d+\/labels\/\d+$/.test(path)) return fakeRes(200, {});
    if (method === 'POST' && /^\/api\/v1\/tasks\/\d+$/.test(path)) return fakeRes(200, { id: Number(path.split('/').pop()), done: true });
    throw new Error(`unexpected fetch: ${method} ${path}`);
  };
  return { fn, calls };
}

test('vikunjaEnabled: baseUrl and apiToken both/one/neither', async () => {
  await withVikunjaConfig({}, async () => {
    assert.equal(vikunjaEnabled(), false, 'nothing configured -> disabled');
  });
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example' }, async () => {
    assert.equal(vikunjaEnabled(), false, 'baseUrl alone is not enough');
  });
  await withVikunjaConfig({ apiToken: 'tok' }, async () => {
    assert.equal(vikunjaEnabled(), false, 'apiToken alone is not enough');
  });
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok' }, async () => {
    assert.equal(vikunjaEnabled(), true, 'both present -> enabled');
  });
  await withVikunjaConfig({ baseUrl: 'http://insecure.example', apiToken: 'tok' }, async () => {
    assert.equal(vikunjaEnabled(), false, 'non-https baseUrl is rejected, same as discordWebhook');
  });
});

test('vikunja env vars override the config file (same precedence as CCSERVER_DISCORD_WEBHOOK)', async () => {
  await withVikunjaConfig({ baseUrl: 'https://file.example', apiToken: 'file-tok', projectId: 1 }, async () => {
    process.env.CCSERVER_VIKUNJA_BASE_URL = 'https://env.example';
    process.env.CCSERVER_VIKUNJA_API_TOKEN = 'env-tok';
    process.env.CCSERVER_VIKUNJA_PROJECT_ID = '2';
    try {
      const cfg = vikunjaConfig();
      assert.equal(cfg.baseUrl, 'https://env.example');
      assert.equal(cfg.apiToken, 'env-tok');
      assert.equal(cfg.projectId, '2');
    } finally {
      delete process.env.CCSERVER_VIKUNJA_BASE_URL;
      delete process.env.CCSERVER_VIKUNJA_API_TOKEN;
      delete process.env.CCSERVER_VIKUNJA_PROJECT_ID;
    }
  });
});

test('createOrUpdateTask: create -> comment update -> success terminates tracking -> next call re-creates', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 7 }, async (tasksPath) => {
    const { fn, calls } = makeMock();
    const realFetch = global.fetch;
    global.fetch = fn;
    const identity = { sessionId: 'sess-1', groupId: null, cwd: '/srv/proj', projectName: 'proj' };
    try {
      const r1 = await createOrUpdateTask({ key: 'sess-1', title: 'Working', body: 'starting', level: 'info', identity });
      assert.equal(r1.ok, true);
      assert.equal(r1.action, 'created');
      const firstTaskId = r1.taskId;

      const createCall = calls.find((c) => c.method === 'PUT' && /\/projects\/7\/tasks$/.test(c.path));
      assert.equal(createCall.body.title, 'Working');
      assert.ok(createCall.body.description.includes('starting'));
      assert.ok(createCall.body.description.includes('_from:'), 'description carries the attribution footer');

      const saved1 = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      assert.equal(saved1['sess-1'].taskId, firstTaskId);
      assert.equal(saved1['sess-1'].lastLevel, 'info');

      const r2 = await createOrUpdateTask({ key: 'sess-1', title: 'Still going', body: 'more', level: 'warning', identity });
      assert.equal(r2.ok, true);
      assert.equal(r2.action, 'updated');
      assert.equal(r2.taskId, firstTaskId, 'the same task is reused for the same key');

      const commentCall = calls.find((c) => c.method === 'PUT' && c.path === `/api/v1/tasks/${firstTaskId}/comments`);
      assert.ok(commentCall.body.comment.includes('Still going'));
      assert.ok(commentCall.body.comment.includes('more'));

      const r3 = await createOrUpdateTask({ key: 'sess-1', title: 'Done', body: 'finished', level: 'success', identity });
      assert.equal(r3.ok, true);
      assert.equal(r3.action, 'updated');
      assert.equal(r3.taskId, firstTaskId);

      const markDoneCall = calls.find((c) => c.method === 'POST' && c.path === `/api/v1/tasks/${firstTaskId}`);
      assert.ok(markDoneCall, 'a terminal (success) level marks the underlying task done');
      assert.equal(markDoneCall.body.done, true);

      const saved3 = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      assert.equal(saved3['sess-1'], undefined, 'a terminal (success) level clears the tracked entry');

      const r4 = await createOrUpdateTask({ key: 'sess-1', title: 'New round', body: 'again', level: 'info', identity });
      assert.equal(r4.action, 'created');
      assert.notEqual(r4.taskId, firstTaskId, 'tracking was cleared, so a fresh task is created');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('createOrUpdateTask is a no-op without a tracking key, and never calls fetch', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async () => {
    let called = false;
    const realFetch = global.fetch;
    global.fetch = async () => { called = true; return fakeRes(200, {}); };
    try {
      const r = await createOrUpdateTask({ key: null, title: 't', body: 'b', level: 'info' });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'skipped');
      assert.equal(called, false);
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('task creation is skipped (not attempted) without a configured projectId', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok' }, async () => {
    let called = false;
    const realFetch = global.fetch;
    global.fetch = async () => { called = true; return fakeRes(200, {}); };
    try {
      const r = await createOrUpdateTask({ key: 'k-no-project', title: 't', body: 'b', level: 'info', identity: {} });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'error');
      assert.equal(called, false, 'no request is attempted without a projectId');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('a 4xx response is not retried', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async () => {
    const { fn, calls } = makeMock({
      onRequest: (record) => (
        record.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(record.path) ? fakeRes(400, { message: 'bad' }) : null
      ),
    });
    const realFetch = global.fetch;
    global.fetch = fn;
    try {
      const r = await createOrUpdateTask({ key: 'k-4xx', title: 't', body: 'b', level: 'info', identity: {} });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'error');
      const taskCreateCalls = calls.filter((c) => c.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(c.path));
      assert.equal(taskCreateCalls.length, 1, '4xx fails immediately, no retry');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('a 2xx response with an unparseable body is treated as success, not retried', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async () => {
    const { fn, calls } = makeMock({
      onRequest: (record) => (
        record.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(record.path)
          ? { ok: true, status: 200, text: async () => 'not json' }
          : null
      ),
    });
    const realFetch = global.fetch;
    global.fetch = fn;
    try {
      const r = await createOrUpdateTask({ key: 'k-badjson', title: 't', body: 'b', level: 'info', identity: {} });
      const taskCreateCalls = calls.filter((c) => c.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(c.path));
      assert.equal(taskCreateCalls.length, 1, 'a successful HTTP response is never retried, even if its body fails to parse');
      assert.equal(r.action, 'error', 'without a parsed body.id the task is untracked, but no duplicate was created');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('a 5xx response retries up to 3 attempts total, then fails without throwing', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async () => {
    const { fn, calls } = makeMock({
      onRequest: (record) => (
        record.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(record.path) ? fakeRes(503, { message: 'down' }) : null
      ),
    });
    const realFetch = global.fetch;
    global.fetch = fn;
    try {
      const r = await createOrUpdateTask({ key: 'k-5xx', title: 't', body: 'b', level: 'info', identity: {} });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'error');
      const taskCreateCalls = calls.filter((c) => c.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(c.path));
      assert.equal(taskCreateCalls.length, 3, '5xx is retried up to 3 total attempts');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('a network error (fetch throws) retries the same as 5xx, then fails without throwing', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async () => {
    let taskCreateAttempts = 0;
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const path = new URL(String(url)).pathname;
      if (opts.method === 'PUT' && /^\/api\/v1\/projects\/\d+\/tasks$/.test(path)) {
        taskCreateAttempts++;
        throw new Error('connection reset');
      }
      throw new Error(`unexpected fetch: ${opts.method} ${path}`);
    };
    try {
      const r = await createOrUpdateTask({ key: 'k-net', title: 't', body: 'b', level: 'info', identity: {} });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'error');
      assert.equal(taskCreateAttempts, 3, 'a connection error is retried up to 3 total attempts');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('failures never log the API token or the base URL', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'super-secret-token', projectId: 1 }, async () => {
    const { fn } = makeMock({
      onRequest: (record) => (
        record.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(record.path) ? fakeRes(500, { message: 'down' }) : null
      ),
    });
    const realFetch = global.fetch;
    global.fetch = fn;
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await createOrUpdateTask({ key: 'k-secret', title: 't', body: 'b', level: 'info', identity: {} });
      assert.ok(warnings.length > 0, 'a warning was logged for the failed delivery');
      for (const w of warnings) {
        assert.ok(!w.includes('super-secret-token'), `warning must not include the token: ${w}`);
        assert.ok(!w.includes('https://vikunja.example'), `warning must not include the base URL: ${w}`);
      }
    } finally {
      console.warn = realWarn;
      global.fetch = realFetch;
    }
  });
});

test('createOrUpdateTask: a first notify that is already "success" marks the task done and leaves no tracking entry, so the next notify for the same key starts fresh', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async (tasksPath) => {
    const { fn, calls } = makeMock();
    const realFetch = global.fetch;
    global.fetch = fn;
    try {
      const r1 = await createOrUpdateTask({ key: 'k-fresh-success', title: 't', body: 'b', level: 'success', identity: {} });
      assert.equal(r1.ok, true);
      assert.equal(r1.action, 'created');

      const markDoneCall = calls.find((c) => c.method === 'POST' && c.path === `/api/v1/tasks/${r1.taskId}`);
      assert.ok(markDoneCall, 'a "success" level on the very first notify still marks the task done');
      assert.equal(markDoneCall.body.done, true);

      let saved;
      try { saved = JSON.parse(readFileSync(tasksPath, 'utf-8')); } catch { saved = {}; }
      assert.equal(saved['k-fresh-success'], undefined, 'no tracking entry is left for an immediately-successful key');

      const r2 = await createOrUpdateTask({ key: 'k-fresh-success', title: 't2', body: 'b2', level: 'info', identity: {} });
      assert.equal(r2.action, 'created', 'no tracking entry -> treated as a brand new task, not reopening the done one');
      assert.notEqual(r2.taskId, r1.taskId);
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('createOrUpdateTask: info/warning/error levels never mark the task done', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async () => {
    const { fn, calls } = makeMock();
    const realFetch = global.fetch;
    global.fetch = fn;
    try {
      await createOrUpdateTask({ key: 'k-non-terminal', title: 't', body: 'b', level: 'info', identity: {} });
      await createOrUpdateTask({ key: 'k-non-terminal', title: 't', body: 'b', level: 'warning', identity: {} });
      await createOrUpdateTask({ key: 'k-non-terminal', title: 't', body: 'b', level: 'error', identity: {} });
      const markDoneCalls = calls.filter((c) => c.method === 'POST');
      assert.equal(markDoneCalls.length, 0, 'only a terminal (success) level should ever POST to mark a task done');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('createOrUpdateTask: a failed mark-done does not affect the overall result (existing-task path)', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async (tasksPath) => {
    const { fn } = makeMock({
      onRequest: (record) => (record.method === 'POST' ? fakeRes(400, { message: 'cannot mark done' }) : null),
    });
    const realFetch = global.fetch;
    global.fetch = fn;
    try {
      const r1 = await createOrUpdateTask({ key: 'k-markdone-fails', title: 't', body: 'b', level: 'info', identity: {} });
      assert.equal(r1.action, 'created');

      const r2 = await createOrUpdateTask({ key: 'k-markdone-fails', title: 't2', body: 'b2', level: 'success', identity: {} });
      assert.equal(r2.ok, true, 'the add-comment succeeded, so ok is true regardless of the mark-done failure');
      assert.equal(r2.action, 'updated');

      let saved;
      try { saved = JSON.parse(readFileSync(tasksPath, 'utf-8')); } catch { saved = {}; }
      assert.equal(saved['k-markdone-fails'], undefined, 'tracking is still cleared even though mark-done failed');
    } finally {
      global.fetch = realFetch;
    }
  });
});

test('createOrUpdateTask: a failed mark-done does not affect the overall result (new-task path)', async () => {
  await withVikunjaConfig({ baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 1 }, async () => {
    const { fn } = makeMock({
      onRequest: (record) => (record.method === 'POST' ? fakeRes(400, { message: 'cannot mark done' }) : null),
    });
    const realFetch = global.fetch;
    global.fetch = fn;
    try {
      const r = await createOrUpdateTask({ key: 'k-markdone-fails-fresh', title: 't', body: 'b', level: 'success', identity: {} });
      assert.equal(r.ok, true, 'task creation succeeded, so ok is true regardless of the mark-done failure');
      assert.equal(r.action, 'created');
    } finally {
      global.fetch = realFetch;
    }
  });
});
