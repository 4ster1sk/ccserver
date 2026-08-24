// Outbound half of cross-instance federation: dialing a peer's federation
// port, running the pairing bootstrap, and proxying REST-shaped calls /
// terminal I/O to an already-'active' pair. See federationProtocol.js for
// the wire framing and its header comment for why every connection here is
// short-lived and single-purpose rather than one long-lived multiplexed
// connection per peer.
//
// Trust on first contact (TOFU) only ever applies to ONE call:
// initiatePairing(). Every other function here requires an already-pinned
// fingerprint (from paired_instances, via federationPairing.getActiveInstance
// or the row passed to reconcilePending) and refuses the connection outright
// if the live peer certificate doesn't match it exactly -- see the
// "fingerprint mismatch" throws below. This is what actually enforces "pin
// the key, not a CA" on the outbound side; federationServer.js enforces the
// same thing for inbound connections.

import { connect as tlsConnect } from 'node:tls';
import { hostname as osHostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ensureIdentity, peerCertInfo } from './federationIdentity.js';
import { LineFramer } from './federationProtocol.js';
import * as pairing from './federationPairing.js';
import { resolvedHostname } from './notify.js';
import { federationPort } from './federationServer.js';

const CONNECT_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 15_000;
const FEDERATION_KEEPALIVE_MS = 30_000;

export function parseRemoteAddr(remoteAddr) {
  if (typeof remoteAddr !== 'string' || !remoteAddr.includes(':')) {
    throw new Error('address must be host:port');
  }
  const idx = remoteAddr.lastIndexOf(':');
  const host = remoteAddr.slice(0, idx);
  const port = Number(remoteAddr.slice(idx + 1));
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('address must be host:port with a valid port number');
  }
  return { host, port };
}

function myHostnameLabel() {
  return resolvedHostname() || osHostname();
}

// The address the peer should dial to reach US back -- needed for
// reconcilePending's pairing.status polling (and, once active, for the peer
// to be able to reach us at all if the pairing is later initiated from
// their side too). Best-effort self-report: `${resolvedHostname()}:${federationPort()}`,
// using the SAME hostname resolution notify.js already uses for its own
// "_from: <host>" attribution (CCSERVER_HOSTNAME env > sandbox.config.json's
// notify.hostname > OS hostname). There is no NAT/multi-homing-proof way to
// self-report a reachable address in general -- an operator on an
// asymmetric network needs CCSERVER_HOSTNAME set to whatever the peer can
// actually resolve (a Tailscale MagicDNS name, typically). Without this, the
// peer would fall back to the ephemeral TCP source port of this one
// bootstrap connection, which is useless for any later dial-back.
function myClaimedAddr() {
  const port = federationPort();
  return port != null ? `${myHostnameLabel()}:${port}` : null;
}

// Opens one mTLS connection and resolves once the handshake is done and the
// peer's certificate has been read -- CA validation stays off
// (rejectUnauthorized: false); the caller decides whether to trust the
// fingerprint (TOFU for the very first pairing propose, exact-pin match for
// everything else -- see the header comment).
async function connectTls({ host, port }) {
  const id = await ensureIdentity();
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host, port, key: id.key, cert: id.cert, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS,
    }, () => {
      const info = peerCertInfo(socket);
      if (!info) {
        try { socket.destroy(); } catch { /* ignore */ }
        reject(new Error('peer presented no TLS certificate'));
        return;
      }
      resolve({ socket, info });
    });
    try { socket.setKeepAlive(true, FEDERATION_KEEPALIVE_MS); } catch { /* ignore: keepalive not critical */ }
    socket.once('error', reject);
    socket.once('timeout', () => {
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error(`connection to ${host}:${port} timed out`));
    });
  });
}

// One request, one response, then the connection closes -- see
// federationProtocol.js's header comment for why. Resolves with the full
// {ok, ...} response body (plus peerInfo, for callers that need the freshly
// observed fingerprint -- initiatePairing does). Throws on transport
// failure, timeout, or a fingerprint mismatch against expectFingerprint.
async function oneShotRpc({ host, port, method, params, expectFingerprint, timeoutMs = RPC_TIMEOUT_MS }) {
  const { socket, info } = await connectTls({ host, port });
  if (expectFingerprint && info.fingerprint !== expectFingerprint) {
    try { socket.destroy(); } catch { /* ignore */ }
    throw new Error('peer certificate fingerprint no longer matches the pinned one -- refusing to trust this connection');
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error(`federation rpc ${method} timed out`));
    }, timeoutMs);
    const framer = new LineFramer(socket, {
      onLine: (frame) => {
        if (settled || frame.kind !== 'rpc-response' || frame.id !== id) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...frame, peerInfo: info });
      },
      onError: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(err);
      },
    });
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('connection closed before a response arrived'));
    });
    framer.write({ v: 1, kind: 'rpc', id, method, params });
  });
}

// The one place TOFU is allowed: dial a never-before-seen address, learn its
// certificate from the handshake itself, ask it to record us as a pending
// inbound request, and record OUR side of the pair (direction
// 'outbound_initiated', status starts pending_local_approval -- see
// federationPairing.js's header comment on the symmetric approval model).
// Returns the created/refreshed public row. Throws on any failure (network,
// refusal, or a previously-revoked peer) -- the REST route turns that into a
// 4xx/5xx for the browser.
export async function initiatePairing({ remoteAddr, remoteToken, label }) {
  const { host, port } = parseRemoteAddr(remoteAddr);
  const resp = await oneShotRpc({
    host, port, method: 'pairing.propose',
    params: {
      hostnameLabel: myHostnameLabel(),
      claimedAddr: myClaimedAddr() || undefined,
      federationToken: typeof remoteToken === 'string' && remoteToken ? remoteToken : undefined,
    },
  });
  if (!resp.ok) throw new Error(resp.error || 'pairing request was refused');
  const row = pairing.recordOutboundRequest({
    fingerprint: resp.peerInfo.fingerprint,
    certPem: resp.peerInfo.pem,
    hostnameClaimed: typeof resp.myHostnameLabel === 'string' ? resp.myHostnameLabel : null,
    addr: remoteAddr,
    label: typeof label === 'string' && label ? label : null,
  });
  if (!row) throw new Error('this instance previously revoked a pairing with that fingerprint');
  return row;
}

// Asks every not-yet-active pending row's peer what THEY decided, and folds
// the answer into remote_decision (federationPairing.recordRemoteDecision),
// which may flip the row to 'active' once both sides show 'approved' (see
// federationPairing.deriveStatus). Best-effort per row: an unreachable peer
// just leaves that row unchanged for the next poll. Called from the REST
// polling path (routes/federation.js) rather than a background timer -- see
// that file's header comment.
export async function reconcilePending() {
  const rows = pairing.listPending();
  const outcomes = [];
  for (const row of rows) {
    try {
      const { host, port } = parseRemoteAddr(row.addr);
      const resp = await oneShotRpc({
        host, port, method: 'pairing.status', params: {}, expectFingerprint: row.fingerprint, timeoutMs: 5000,
      });
      if (resp.ok && (resp.myDecision === 'approved' || resp.myDecision === 'rejected')) {
        pairing.recordRemoteDecision(row.id, resp.myDecision);
      }
      outcomes.push({ id: row.id, reachable: true });
    } catch {
      outcomes.push({ id: row.id, reachable: false });
    }
  }
  return outcomes;
}

// REST-shaped call to an ALREADY-active peer (session/group list, launch,
// destroy, dir browse -- see federationServer.js's RPC_METHODS). Throws if
// the instance isn't active, is unreachable, or the peer's live certificate
// no longer matches the pinned fingerprint.
export async function callInstanceRpc(instanceId, method, params, { timeoutMs } = {}) {
  const row = pairing.getActiveInstance(instanceId);
  if (!row) throw new Error('instance is not an active paired peer');
  const { host, port } = parseRemoteAddr(row.addr);
  const resp = await oneShotRpc({ host, port, method, params, expectFingerprint: row.fingerprint, timeoutMs });
  if (!resp.ok) throw new Error(resp.error || `federation call ${method} failed`);
  pairing.touchLastSeen(row.id);
  return resp;
}

// Opens a long-lived relay connection for one browser terminal tab (see
// server/ws/remoteTerminal.js). The returned handle stays open for as long
// as the browser tab does; TerminalView.jsx's existing reconnect-on-close
// logic is what recovers from this connection dying (a fresh browser
// reconnect calls this again). TCP keepalive (FEDERATION_KEEPALIVE_MS via
// socket.setKeepAlive in connectTls) keeps the underlying TLS socket alive
// at the kernel level through NAT idle timeouts, complementing the terminal
// protocol's own ping/pong which still flows through this relay unchanged
// like every other terminal message. Kernel probes are not throttled when
// JS timers are suspended in background tabs.
export async function openTerminalChannel(instanceId) {
  const row = pairing.getActiveInstance(instanceId);
  if (!row) throw new Error('instance is not an active paired peer');
  const { host, port } = parseRemoteAddr(row.addr);
  const { socket, info } = await connectTls({ host, port });
  if (info.fingerprint !== row.fingerprint) {
    try { socket.destroy(); } catch { /* ignore */ }
    throw new Error('peer certificate fingerprint no longer matches the pinned one -- refusing to trust this connection');
  }
  pairing.touchLastSeen(row.id);

  let messageCb = null;
  let closeCb = null;
  const framer = new LineFramer(socket, {
    onLine: (frame) => { if (messageCb) messageCb(frame); },
    onError: () => { try { socket.destroy(); } catch { /* ignore */ } },
  });
  socket.once('close', () => { if (closeCb) closeCb(); });
  socket.once('error', () => { if (closeCb) closeCb(); });

  framer.write({ v: 1, kind: 'terminal-open' });

  return {
    send(obj) { framer.write(obj); },
    onMessage(cb) { messageCb = cb; },
    onClose(cb) { closeCb = cb; },
    close() { try { socket.end(); } catch { /* ignore */ } },
  };
}
