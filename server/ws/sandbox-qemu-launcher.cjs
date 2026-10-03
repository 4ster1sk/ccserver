#!/usr/bin/env node
// Runs as the pty child of a qemu-backend session (the slot bwrap occupies
// for the bwrap backend). Given an attach plan (qemuVmPool.js), it only
// runs the session's confined ssh login into an already-running persistent
// VM. Given the plan written by sandbox-qemu.js's prepareQemuSession, it:
//
//   1. starts one virtiofsd per share and waits for its socket
//   2. starts QEMU (its NIC attaches to the already-running network broker)
//   3. waits for the guest's cloud-init to print READY-<token> (or FAIL-…)
//      on the serial console, then for sshd's banner via the broker
//   4. runs `ssh -tt` with the pty inherited, so the user's terminal is the
//      guest shell (window size and signals flow through ssh)
//   5. when ssh ends -- or this process is told to stop -- tears the VM and
//      daemons down and removes the run dir (the overlay is disposable)
//
// QEMU runs under bwrap --die-with-parent with its own pid namespace, so
// even a SIGKILLed launcher cannot leave it running; virtiofsd exits once
// QEMU disconnects. sessionManager's teardown removes the run dir.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildRemoteCommand, buildConfinedRemoteCommand, forwardedEnv } = require('./sandbox-qemu-remote.cjs');
const boot = require('./sandbox-qemu-boot.cjs');

const planPath = process.argv[2];
if (!planPath) {
  process.stderr.write('usage: sandbox-qemu-launcher.cjs <plan.json>\n');
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
const say = (msg) => process.stdout.write(`\r\x1b[2m[sandbox] ${msg}\x1b[0m\r\n`);
// Startup progress for the chat view (format: server/ws/chatStages.js). An
// unknown OSC, so a terminal session's xterm.js ignores it.
const stage = (id, state, message) => {
  const msg = message ? `;${String(message).replace(/[\x00-\x1f\x7f;]/g, ' ').slice(0, 300)}` : '';
  process.stdout.write(`\x1b]777;ccserver-stage;${id};${state}${msg}\x07`);
};
let currentStage = null;

const children = [];
let qemu = null;
let ssh = null;
let stopping = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await cond();
    if (v) return v;
    if (stopping) throw new Error('stopped');
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function spawnDaemon(bin, args, logName) {
  const log = fs.openSync(path.join(plan.runDir, logName), 'a', 0o600);
  const p = spawn(bin, args, { stdio: ['ignore', log, log] });
  fs.closeSync(log);
  children.push(p);
  return p;
}

async function teardown() {
  if (ssh && ssh.exitCode === null) { try { ssh.kill('SIGHUP'); } catch { /* gone */ } }
  // The rootfs is throwaway: no graceful guest shutdown needed.
  if (qemu && qemu.exitCode === null) {
    try { qemu.kill('SIGTERM'); } catch { /* gone */ }
    const deadline = Date.now() + 3000;
    while (qemu.exitCode === null && qemu.signalCode === null && Date.now() < deadline) await sleep(50);
    if (qemu.exitCode === null && qemu.signalCode === null) { try { qemu.kill('SIGKILL'); } catch { /* gone */ } }
  }
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  }
  await sleep(100);
  // An attach plan's VM belongs to the pool, not to this session.
  if (!plan.attach) {
    try { fs.rmSync(plan.runDir, { recursive: true, force: true }); } catch { /* sessionManager retries */ }
  }
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  await teardown();
  process.exit(code);
}

for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(sig, () => { stop(sig === 'SIGINT' ? 130 : 129); });
}

// A session of a persistent VM (qemuVmPool.js): the VM is already up and
// this session's shares mounted, so only the confined login is left. A VM
// Terminal (qemuVmPool attachShell) has no bwrapArgs and logs in unconfined.
function attach() {
  const cmd = {
    cwd: plan.remote.cwd,
    argv: plan.remote.argv,
    env: { ...plan.remote.env, ...forwardedEnv(process.env) },
    fallbackArgv: plan.remote.fallbackArgv || null,
  };
  const remoteCmd = plan.remote.bwrapArgs
    ? buildConfinedRemoteCommand({ bwrapArgs: plan.remote.bwrapArgs, preDirs: plan.remote.preDirs || [], ...cmd })
    : buildRemoteCommand(cmd);
  ssh = spawn(plan.ssh.bin, [...plan.ssh.args, remoteCmd], { stdio: 'inherit' });
  ssh.on('exit', (code, sig) => { stop(code ?? (sig ? 128 : 1)); });
}

async function main() {
  if (plan.attach) return attach();
  const t0 = Date.now();
  say('VM を起動中…');
  currentStage = 'vm_boot';
  stage('vm_boot', 'running');
  for (let i = 0; i < plan.virtiofsd.length; i++) {
    const v = plan.virtiofsd[i];
    const p = spawnDaemon(v.bin, v.args, `virtiofsd-${i}.log`);
    await waitFor(() => fs.existsSync(v.socketPath) || p.exitCode !== null, 5000, `virtiofsd socket ${i}`);
    if (p.exitCode !== null) throw new Error(`virtiofsd ${i} exited (${p.exitCode}); see ${plan.runDir}/virtiofsd-${i}.log`);
  }

  qemu = spawnDaemon(plan.qemu.bin, plan.qemu.args, 'qemu.log');
  qemu.on('exit', (code, sig) => {
    if (!stopping) {
      process.stdout.write(`\r\n[sandbox] VM が終了しました (${sig || code})\r\n`);
      stop(ssh ? (ssh.exitCode ?? 1) : 1);
    }
  });

  const state = await waitFor(() => {
    if (qemu.exitCode !== null) return { fail: `qemu exited (${qemu.exitCode}); see ${plan.runDir}/qemu.log` };
    if (currentStage === 'vm_boot' && boot.setupStarted(plan)) {
      currentStage = 'vm_setup';
      stage('vm_setup', 'running');
    }
    return boot.consoleState(plan);
  }, plan.bootTimeoutMs, 'the VM to finish booting');
  if (state !== 'ready') throw new Error(`VM setup failed: ${state.fail}`);
  await waitFor(() => boot.sshBanner(plan.guestSshSock), 15000, 'sshd');
  say(`VM 起動完了 (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
  stage('vm_setup', 'done');
  currentStage = null;

  const remoteCmd = buildRemoteCommand({
    cwd: plan.remote.cwd,
    argv: plan.remote.argv,
    env: { ...plan.remote.env, ...forwardedEnv(process.env) },
    fallbackArgv: plan.remote.fallbackArgv || null,
  });
  ssh = spawn(plan.ssh.bin, [...plan.ssh.args, remoteCmd], { stdio: 'inherit' });
  ssh.on('exit', (code, sig) => { stop(code ?? (sig ? 128 : 1)); });
}

main().catch(async (e) => {
  if (stopping) return;
  if (currentStage) stage(currentStage, 'error', e.message);
  process.stdout.write(`\r\n[sandbox] ${e.message}\r\n${plan.attach ? '' : `--- console (tail) ---\r\n${boot.consoleTail(plan)}\r\n`}`);
  await stop(1);
});
