// Host side of the Go network broker (`ccs-netbroker`, separate repository
// git.tomadoi.com/4sterisk/ccserver-netbroker; fetched into netbrokerBinDir()
// by npm run fetch:netbroker at the version pinned in
// server/netbroker.version.json) used by
// the qemu backend: spawn one per session, wait for it synchronously
// (buildSandboxSpawn is synchronous), relay its audit log, and drive its
// admin API over a unix socket.
//
// Also hosts the session dispatch for the running-session controls
// (live enforce/open toggle, allow-list and operating-mode push): sessions
// carry the Go broker's admin socket. Callers use brokerArmed /
// setSessionBrokerMode / setSessionBrokerLists / setSessionBrokerOpMode.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRuntimeDir, ensureHostRuntimeDir } from './git-broker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function netbrokerBinDir() {
  return process.env.CCSERVER_NETBROKER_BIN_DIR || join(__dirname, '..', '..', '.netbroker', 'bin');
}
export const netbrokerBin = () => join(netbrokerBinDir(), 'ccs-netbroker');

export function netbrokerBuilt() {
  return existsSync(netbrokerBin());
}

// One audit event -> console. Allowed connections/requests are routine and
// stay out of the server log; denials, DLP findings and control-plane
// changes are what an operator needs to see.
function relayAuditLine(tag, line) {
  let ev;
  try { ev = JSON.parse(line); } catch {
    if (line.trim()) process.stdout.write(`[netbroker ${tag}] ${line}\n`);
    return;
  }
  const interesting = ev.verdict === 'deny' || ev.detector || ev.kind === 'admin' || ev.kind === 'broker' || ev.error;
  if (!interesting) return;
  const what = [ev.kind, ev.event, ev.method, ev.host && `${ev.host}${ev.port ? `:${ev.port}` : ''}`, ev.path, ev.verdict, ev.reason, ev.detector && `dlp=${ev.detector}`, ev.mode && `mode=${ev.mode}`, ev.state && `state=${ev.state}`, ev.error && `error=${ev.error}`]
    .filter(Boolean).join(' ');
  process.stdout.write(`[netbroker ${tag}] ${what}\n`);
}

// Spawns a broker and blocks (<= 3s) until its sockets exist. Returns
// { proc, dir, adminSock, vnetSock, guestSshSock, caPem, mode, state }.
//
// The broker runs the VM's whole network (vnet: QEMU attaches its NIC to
// vnetSock) and relays guestSshSock to the guest's sshd.
// Throws on any failure after cleaning up after itself.
//
//   advanced: the qemu-only policy keys from sandbox.config.json network
//             (mitm, rules, dlp, inject, log), passed through verbatim --
//             the Go side validates them and refuses to start on errors.
//   services: [{ name, addr: '10.0.2.100:<port>', unix }] host sockets the
//             guest reaches at addr WITHOUT network policy (see
//             ccserver-netbroker's README.md). Only ccserver's own brokers belong
//             here -- never anything from sandbox.config.json.
//   env:      extra environment for the broker process: the secrets its
//             inject entries name (valueFromEnv), kept out of the config
//             file.
export function startGoNetworkBroker({ session, mode = 'enforce', state = 'enforce', allowedHosts = [], deniedHosts = [], advanced = {}, services = [], env = {} }) {
  if (!netbrokerBuilt()) {
    throw new Error(`network broker binaries are missing in ${netbrokerBinDir()} (run: npm run fetch:netbroker)`);
  }
  ensureHostRuntimeDir();
  // Short path on purpose: unix socket paths are limited to ~108 bytes.
  const dir = join(hostRuntimeDir(), `ccs-nb-${randomUUID().slice(0, 13)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = {
    vnetSock: join(dir, 'vnet.sock'),
    guestSshSock: join(dir, 'ssh.sock'),
    adminSock: join(dir, 'a.sock'),
    caCert: join(dir, 'ca.pem'),
  };
  // HTTPS interception is on unless explicitly disabled: without it the
  // broker only sees TLS SNI, which a malicious guest can front (allowed
  // SNI, disallowed Host on the same CDN), and rules/DLP cannot apply.
  const mitm = { enabled: true, ...(advanced.mitm || {}) };
  const mitmEnabled = mitm.enabled === true;
  const config = {
    session,
    mode,
    state,
    allowedHosts,
    deniedHosts,
    listen: { vnet: paths.vnetSock, guestSsh: paths.guestSshSock, admin: paths.adminSock },
    ...(services.length ? { services } : {}),
    mitm: { ...mitm, ...(mitmEnabled ? { caCertPath: paths.caCert } : {}) },
    ...(advanced.rules ? { rules: advanced.rules } : {}),
    ...(advanced.dlp ? { dlp: advanced.dlp } : {}),
    ...(advanced.inject ? { inject: advanced.inject } : {}),
    ...(advanced.log ? { log: advanced.log } : {}),
  };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const procEnv = { ...process.env, ...env };

  // Validate synchronously first: the busy-wait below blocks the event
  // loop, so a broker that exits on a bad policy could not report why.
  try {
    execFileSync(netbrokerBin(), ['--config', configPath, '--check'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000, env: procEnv });
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    const msg = (e.stderr?.toString() || e.message).trim().replace(/^ccs-netbroker: /, '');
    throw new Error(`network broker failed to start: ${msg} -- check the network.* settings in sandbox.config.json`);
  }

  const tag = session.slice(0, 8);
  const proc = spawn(netbrokerBin(), ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'], env: procEnv });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      relayAuditLine(tag, buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  proc.stderr.on('data', (d) => { process.stderr.write(`[netbroker ${tag}] ${d}`); });
  let spawnError = null;
  proc.on('error', (e) => { spawnError = e; });

  const fail = (reason) => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`network broker failed to start: ${reason}`);
  };
  // The admin socket is bound last (after transparent and dns), so its
  // existence means all three listeners are up.
  const deadline = Date.now() + 3000;
  while (!existsSync(paths.adminSock) && Date.now() < deadline) {
    if (spawnError || proc.exitCode !== null || proc.signalCode !== null) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (spawnError) fail(spawnError.message);
  if (proc.exitCode !== null || proc.signalCode !== null) fail(`exited (${proc.exitCode ?? proc.signalCode})`);
  if (!existsSync(paths.adminSock)) fail('sockets not ready within 3s');
  let caPem = null;
  if (mitmEnabled) {
    try { caPem = readFileSync(paths.caCert, 'utf-8'); } catch { fail('MITM CA certificate was not written'); }
  }
  return { proc, dir, ...paths, caPem, mode, state };
}

function adminCall(sockPath, method, path, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request({
      socketPath: sockPath, method, path,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON error body */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function setGoBrokerMode(adminSock, mode) {
  if (mode !== 'enforce' && mode !== 'open') return false;
  const r = await adminCall(adminSock, 'POST', '/mode', { mode });
  return r.status === 200;
}

// The operating mode (sandbox.config.json network.mode: enforce/audit), as
// opposed to setGoBrokerMode's live enforce/open state.
export async function setGoBrokerOpMode(adminSock, mode) {
  if (mode !== 'enforce' && mode !== 'audit') return false;
  const r = await adminCall(adminSock, 'POST', '/opmode', { mode });
  return r.status === 200;
}

export async function setGoBrokerLists(adminSock, { allowedHosts, deniedHosts } = {}) {
  const body = {};
  if (allowedHosts !== undefined) body.hosts = allowedHosts;
  if (deniedHosts !== undefined) body.deniedHosts = deniedHosts;
  const r = await adminCall(adminSock, 'POST', '/allowlist', body);
  return r.status === 200;
}

// --- session dispatch ----------------------------------------------------------

export function brokerArmed(session) {
  if (!session?.networkIsolateArmed) return false;
  return !!session.networkBrokerAdminSock;
}

export async function setSessionBrokerMode(session, mode) {
  return setGoBrokerMode(session.networkBrokerAdminSock, mode);
}

export async function setSessionBrokerLists(session, lists) {
  return setGoBrokerLists(session.networkBrokerAdminSock, lists);
}

export async function setSessionBrokerOpMode(session, mode) {
  return setGoBrokerOpMode(session.networkBrokerAdminSock, mode);
}
