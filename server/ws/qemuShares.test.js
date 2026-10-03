// Share hot-plug: the QMP client against a fake QMP server, and the
// reference counting / ordering / rollback of HotplugShareManager against
// fake QMP, guest and virtiofsd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QmpClient, QmpError } from './qemuQmp.js';
import { HotplugShareManager, hotplugPortIds } from './qemuShares.js';

// --- QmpClient ---------------------------------------------------------------

async function withFakeQmp(handler, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qmp-'));
  const path = join(dir, 'qmp.sock');
  const server = createServer((c) => {
    c.setEncoding('utf-8');
    c.write(`${JSON.stringify({ QMP: { version: {}, capabilities: [] } })}\n`);
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        handler(msg, (obj) => c.write(`${JSON.stringify(obj)}\n`));
      }
    });
  });
  await new Promise((r) => server.listen(path, r));
  try {
    await fn(path);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('QmpClient: negotiates capabilities, matches replies by id, surfaces errors', async () => {
  const seen = [];
  await withFakeQmp((msg, send) => {
    seen.push(msg.execute);
    if (msg.execute === 'boom') send({ id: msg.id, error: { class: 'GenericError', desc: 'nope' } });
    else send({ id: msg.id, return: { echo: msg.arguments ?? null } });
  }, async (path) => {
    const qmp = await QmpClient.connect(path);
    assert.deepEqual(await qmp.execute('query-status'), { echo: null });
    assert.deepEqual(await qmp.execute('device_add', { id: 'x' }), { echo: { id: 'x' } });
    await assert.rejects(qmp.execute('boom'), (e) => e instanceof QmpError && /nope/.test(e.message) && e.qmpClass === 'GenericError');
    qmp.close();
    await assert.rejects(qmp.execute('query-status'), /closed/);
  });
  assert.deepEqual(seen, ['qmp_capabilities', 'query-status', 'device_add', 'boom']);
});

test('QmpClient: waitEvent catches an event sent together with the reply', async () => {
  await withFakeQmp((msg, send) => {
    if (msg.execute === 'device_del') {
      send({ event: 'DEVICE_DELETED', data: { device: 'other' } });
      send({ id: msg.id, return: {} });
      send({ event: 'DEVICE_DELETED', data: { device: msg.arguments.id } });
    } else {
      send({ id: msg.id, return: {} });
    }
  }, async (path) => {
    const qmp = await QmpClient.connect(path);
    const ev = qmp.waitEvent('DEVICE_DELETED', (d) => d.device === 'dev1', 2000);
    await qmp.execute('device_del', { id: 'dev1' });
    assert.deepEqual(await ev, { device: 'dev1' });
    await assert.rejects(qmp.waitEvent('NEVER', () => true, 50), /timed out/);
    qmp.close();
  });
});

// --- HotplugShareManager -----------------------------------------------------

function fakeVm({ failOn = null, neverDelete = false } = {}) {
  const log = [];
  const qmp = {
    waiters: [],
    async execute(cmd, args) {
      log.push(`qmp:${cmd}:${args?.id}${args?.bus ? `@${args.bus}` : ''}`);
      if (failOn === `qmp:${cmd}`) throw new Error(`${cmd} failed`);
      if (cmd === 'device_del' && !neverDelete) {
        setImmediate(() => {
          for (const w of this.waiters.splice(0)) if (w.match({ device: args.id })) w.resolve({ device: args.id });
        });
      }
      return {};
    },
    waitEvent(name, match, timeoutMs) {
      return new Promise((resolve, reject) => {
        this.waiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for QMP event ${name}`)), Math.min(timeoutMs, 50));
      });
    },
  };
  const guest = {
    async mount(tag, path, ro) {
      log.push(`mount:${tag}:${path}:${ro ? 'ro' : 'rw'}`);
      if (failOn === 'mount') throw new Error('mount failed');
    },
    async umount(path) { log.push(`umount:${path}`); },
  };
  const startVirtiofsd = async ({ hostPath }) => {
    log.push(`vfsd:start:${hostPath}`);
    return { async stop() { log.push(`vfsd:stop:${hostPath}`); } };
  };
  return { log, qmp, guest, startVirtiofsd };
}

function manager(vm, ports = 2) {
  return new HotplugShareManager({ runDir: '/r', ports: hotplugPortIds(ports), qmp: vm.qmp, guest: vm.guest, startVirtiofsd: vm.startVirtiofsd, log: () => {} });
}

test('shares: attached once for many users, detached after the last release', async () => {
  const vm = fakeVm();
  const m = manager(vm);
  const [a, b] = await Promise.all([m.acquire('/h/p'), m.acquire('/h/p')]);
  assert.deepEqual(vm.log, ['vfsd:start:/h/p', 'qmp:chardev-add:ccshp0-chr', 'qmp:device_add:ccshp0-dev@ccshp0', 'mount:ccshp0:/h/p:rw']);
  assert.equal(m.list()[0].refs, 2);
  await a.release();
  await a.release(); // idempotent
  assert.equal(m.list()[0].refs, 1);
  assert.ok(!vm.log.some((l) => l.startsWith('umount')));
  await b.release();
  assert.deepEqual(vm.log.slice(4), ['umount:/h/p', 'qmp:device_del:ccshp0-dev', 'qmp:chardev-remove:ccshp0-chr', 'vfsd:stop:/h/p']);
  assert.deepEqual(m.list(), []);
});

test('shares: an acquire racing the last release ends attached', async () => {
  const vm = fakeVm();
  const m = manager(vm);
  const a = await m.acquire('/h/p');
  const rel = a.release();
  const b = await m.acquire('/h/p');
  await rel;
  assert.equal(m.list().length, 1);
  assert.equal(m.list()[0].refs, 1);
  assert.equal(vm.log.filter((l) => l.startsWith('mount')).length, 2);
  await b.release();
  assert.deepEqual(m.list(), []);
});

test('shares: one guest path cannot carry two host dirs; distinct paths use distinct slots', async () => {
  const vm = fakeVm();
  const m = manager(vm);
  await m.acquire('/h/p');
  await assert.rejects(m.acquire('/h/other', { guestPath: '/h/p' }), /already shared from \/h\/p/);
  await assert.rejects(m.acquire('/h/p', { readonly: true }), /already shared/);
  await m.acquire('/h/q', { readonly: true });
  assert.deepEqual(m.list().map((e) => [e.guestPath, e.tag, e.readonly]), [['/h/p', 'ccshp0', false], ['/h/q', 'ccshp1', true]]);
  await assert.rejects(m.acquire('/h/r'), /no free hot-plug slot/);
  await assert.rejects(m.acquire('relative'), /invalid guest path/);
  await assert.rejects(m.acquire('/a\nb'), /invalid guest path/);
});

test('shares: a failed mount rolls back and frees the slot', async () => {
  const vm = fakeVm({ failOn: 'mount' });
  const m = manager(vm, 1);
  await assert.rejects(m.acquire('/h/p'), /mount failed/);
  assert.deepEqual(vm.log.slice(4), ['qmp:device_del:ccshp0-dev', 'qmp:chardev-remove:ccshp0-chr', 'vfsd:stop:/h/p']);
  assert.deepEqual(m.list(), []);
  vm.log.length = 0;
  await assert.rejects(m.acquire('/h/p'), /mount failed/);
  assert.ok(vm.log.includes('qmp:device_add:ccshp1-dev@ccshp0'), 'the slot was reused');
});

test('shares: a device the guest never ejects retires its slot', async () => {
  const vm = fakeVm({ neverDelete: true });
  const m = manager(vm, 1);
  const a = await m.acquire('/h/p');
  await a.release();
  assert.ok(vm.log.includes('vfsd:stop:/h/p'), 'virtiofsd stopped anyway');
  assert.ok(!vm.log.includes('qmp:chardev-remove:ccshp0-chr'), 'chardev still in use by the stuck device');
  await assert.rejects(m.acquire('/h/q'), /no free hot-plug slot/);
});

test('shares: close detaches everything and refuses new work', async () => {
  const vm = fakeVm();
  let closed = false;
  const m = new HotplugShareManager({ runDir: '/r', ports: hotplugPortIds(2), qmp: vm.qmp, guest: vm.guest, startVirtiofsd: vm.startVirtiofsd, onClose: () => { closed = true; }, log: () => {} });
  const a = await m.acquire('/h/p');
  await m.acquire('/h/q');
  await m.close();
  assert.ok(closed);
  assert.deepEqual(m.list(), []);
  assert.deepEqual(vm.log.filter((l) => l.startsWith('vfsd:stop')).sort(), ['vfsd:stop:/h/p', 'vfsd:stop:/h/q']);
  await a.release(); // after close: nothing left to do
  await assert.rejects(m.acquire('/h/p'), /closed/);
});
