// Boot-progress probes for a qemu-backend VM, shared by the per-session
// launcher (sandbox-qemu-launcher.cjs) and the persistent VM pool
// (qemuVmPool.js).
'use strict';
const fs = require('fs');
const net = require('net');

// Reads the serial console log for the ready/fail markers. Returns 'ready',
// { fail: reason } or null.
function consoleState(plan) {
  let text;
  try { text = fs.readFileSync(plan.consoleLog, 'utf-8'); } catch { return null; }
  // FAIL first: it is always printed before READY could be, and a setup
  // failure must win even if a later stage still reached its READY line.
  const i = text.indexOf(plan.failPrefix + plan.readyToken);
  if (i >= 0) return { fail: text.slice(i + plan.failPrefix.length + plan.readyToken.length).split('\n')[0].trim() };
  if (text.includes(plan.readyPrefix + plan.readyToken)) return 'ready';
  return null;
}

// Whether the guest has started the session setup (SETUP_PREFIX, the first
// bootcmd line): progress reporting only, boot success is consoleState's.
function setupStarted(plan) {
  if (!plan.setupPrefix) return false;
  try {
    return fs.readFileSync(plan.consoleLog, 'utf-8').includes(plan.setupPrefix + plan.readyToken);
  } catch { return false; }
}

function consoleTail(plan, n = 25) {
  try {
    return fs.readFileSync(plan.consoleLog, 'utf-8').split('\n').slice(-n).join('\r\n');
  } catch { return '(no console output)'; }
}

// The broker relays guestSshSock to the guest's port 22.
function sshBanner(guestSshSock) {
  return new Promise((resolve) => {
    const s = net.connect(guestSshSock);
    let buf = '';
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) done(buf.startsWith('SSH-2.0-')); });
    s.on('error', () => done(false));
  });
}

module.exports = { consoleState, setupStarted, consoleTail, sshBanner };
