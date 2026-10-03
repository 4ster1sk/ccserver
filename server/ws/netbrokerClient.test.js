// Host-side control of the Go broker (ccs-netbroker) used by the qemu
// backend: real binary, real unix sockets, no VM. Skipped when the
// binary has not been fetched (npm run fetch:netbroker).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  startGoNetworkBroker, setGoBrokerMode, setGoBrokerLists, setGoBrokerOpMode, netbrokerBuilt,
  brokerArmed, setSessionBrokerMode,
} from './netbrokerClient.js';

const skip = netbrokerBuilt() ? false : 'netbroker binary not fetched (npm run fetch:netbroker)';
const started = [];
after(() => {
  for (const b of started) {
    try { b.proc.kill('SIGKILL'); } catch { /* gone */ }
    try { rmSync(b.dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function start(opts) {
  const b = startGoNetworkBroker({ session: `test-${started.length}-00000000`, ...opts });
  started.push(b);
  return b;
}

test('startGoNetworkBroker: sockets ready on return; live mode and lists via admin socket', { skip }, async () => {
  const b = start({ allowedHosts: ['example.com'], advanced: { mitm: { enabled: false } } });
  for (const p of [b.vnetSock, b.guestSshSock, b.adminSock]) assert.ok(existsSync(p), p);
  assert.equal(b.caPem, null, 'no CA when mitm is explicitly disabled');
  assert.equal(await setGoBrokerMode(b.adminSock, 'open'), true);
  assert.equal(await setGoBrokerMode(b.adminSock, 'audit'), false, 'not a live state');
  assert.equal(await setGoBrokerLists(b.adminSock, { allowedHosts: ['a.example', '.b.example'] }), true);
  assert.equal(await setGoBrokerLists(b.adminSock, { allowedHosts: ['https://bad'] }), false);
  assert.equal(await setGoBrokerOpMode(b.adminSock, 'audit'), true);
  assert.equal(await setGoBrokerOpMode(b.adminSock, 'enforce'), true);
  assert.equal(await setGoBrokerOpMode(b.adminSock, 'open'), false, 'a live state, not an operating mode');
});

test('startGoNetworkBroker: MITM is on by default and returns the session CA (public cert only)', { skip }, () => {
  const b = start({});
  assert.match(b.caPem, /^-----BEGIN CERTIFICATE-----/);
  assert.ok(!/PRIVATE KEY/.test(b.caPem));
});

test('startGoNetworkBroker: an invalid policy refuses to start (fail closed) and cleans up', { skip }, () => {
  assert.throws(
    () => startGoNetworkBroker({ session: 'bad-00000000', advanced: { mitm: { enabled: false }, rules: [{ host: 'a.example' }] } }),
    /network broker failed to start: .*rules require mitm\.enabled/,
  );
  assert.throws(
    () => startGoNetworkBroker({ session: 'bad-00000001', advanced: { mitm: { enabled: true, bogusKey: 1 } } }),
    /network broker failed to start/,
    'unknown keys are rejected, not ignored',
  );
});

test('startGoNetworkBroker: services reach the broker config; malformed ones refuse to start', { skip }, () => {
  const services = [{ name: 'git-broker', addr: '10.0.2.100:7001', unix: '/run/ccs-test/broker.sock' }];
  const b = start({ advanced: { mitm: { enabled: false } }, services });
  assert.deepEqual(JSON.parse(readFileSync(join(b.dir, 'config.json'), 'utf-8')).services, services);
  const none = start({ advanced: { mitm: { enabled: false } } });
  assert.equal(JSON.parse(readFileSync(join(none.dir, 'config.json'), 'utf-8')).services, undefined);
  assert.throws(
    () => startGoNetworkBroker({ session: 'bad-00000002', advanced: { mitm: { enabled: false } }, services: [{ ...services[0], addr: '10.0.2.2:7001' }] }),
    /network broker failed to start: .*must be 10\.0\.2\.100/,
  );
  assert.throws(
    () => startGoNetworkBroker({ session: 'bad-00000003', advanced: { mitm: { enabled: false } }, services: [{ ...services[0], unix: 'rel.sock' }] }),
    /network broker failed to start: .*absolute path/,
  );
});

test('session dispatch: armed iff the Go broker admin socket is present', { skip }, async () => {
  assert.equal(brokerArmed({ networkIsolateArmed: false, networkBrokerAdminSock: '/x' }), false);
  assert.equal(brokerArmed({ networkIsolateArmed: true, networkBrokerAdminSock: '/x' }), true);
  assert.equal(brokerArmed({ networkIsolateArmed: true }), false);
  const b = start({});
  assert.equal(await setSessionBrokerMode({ networkIsolateArmed: true, networkBrokerAdminSock: b.adminSock }, 'open'), true);
});
