// Wire framing for the federation TLS transport (server/ws/federationServer.js
// / server/ws/federationClient.js): newline-delimited JSON, one object per
// line, both directions.
//
// Deliberate simplification vs. the plan's section 5.3 sketch (one
// multiplexed mTLS connection per peer carrying many rpc/stream channels by
// channelId): here every federation TLS connection carries exactly ONE
// purpose for its entire lifetime -- either a single RPC request/response
// (then it closes) or one long-lived terminal relay (reusing the existing
// /ws/terminal message vocabulary verbatim, one JSON message per line). This
// gives up connection reuse for RPC calls (each one pays a fresh mTLS
// handshake) in exchange for a much smaller surface: there is no
// channel-multiplexing state machine to get wrong, and -- more importantly --
// every connection independently re-runs the full fingerprint+status
// authorization check (see federationServer.js's onConnection), so a
// revocation takes effect on the very next connection attempt with no extra
// "kill live channels" bookkeeping. Given the plan explicitly left the exact
// wire protocol to the implementer, this trade favors the security-review
// surface over saving TLS handshakes for what are, in Phase 1, low-frequency
// admin calls (session/group list + launch) plus one relay per open terminal
// tab.

export const PROTOCOL_VERSION = 1;

// Bounds a single buffered (newline-incomplete) frame. Generous for a
// terminal replay burst or a sessions/groups listing, still finite -- a peer
// that never sends '\n' cannot grow this without limit.
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

// Reassembles newline-delimited JSON off a Node socket (net.Socket /
// tls.TLSSocket) and emits one parsed object per complete line. Malformed
// JSON on a line is reported via onError and otherwise ignored (the line is
// dropped, framing continues) -- a single garbled line must not desync or
// kill an otherwise-healthy relay.
export class LineFramer {
  constructor(socket, { onLine, onError } = {}) {
    this.socket = socket;
    this.onLine = onLine || (() => {});
    this.onError = onError || (() => {});
    this._buf = '';
    socket.on('data', (chunk) => this._feed(chunk));
  }

  _feed(chunk) {
    this._buf += chunk.toString('utf-8');
    if (this._buf.length > MAX_LINE_BYTES) {
      this.onError(new Error('federation frame exceeded max line size'));
      try { this.socket.destroy(); } catch { /* already gone */ }
      return;
    }
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        this.onError(new Error(`invalid federation frame JSON: ${err.message}`));
        continue;
      }
      this.onLine(obj);
    }
  }

  write(obj) {
    if (this.socket.destroyed || this.socket.writableEnded) return false;
    try {
      this.socket.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }
}

export function writeFrame(socket, obj) {
  socket.write(`${JSON.stringify(obj)}\n`);
}
