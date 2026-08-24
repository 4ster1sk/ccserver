// /ws/remote-terminal: the browser-facing half of a remote (federated)
// terminal tab (plan Phase 1, section 8.2). Registered under the SAME
// Fastify instance as /ws/terminal (server/index.js), so it inherits the
// existing CCSERVER_TOKEN gate unchanged -- see server/index.js's onRequest
// hook, which matches on `request.url.startsWith('/ws')`.
//
// Deliberately a thin byte-relay, NOT a reuse of terminal.js's dispatcher:
// this instance owns no session state for a remote tab (the paired peer's
// sessionManager does, on its own machine) -- this route's only job is to
// open one federation terminal channel (federationClient.openTerminalChannel)
// per browser connection and forward JSON messages verbatim in both
// directions, reusing the exact /ws/terminal message vocabulary the peer's
// own terminal.js dispatcher already speaks (see federationServer.js's
// terminal-relay branch). TerminalView.jsx's existing WS reconnect-on-close
// logic is what recovers a dropped federation link -- a fresh browser
// reconnect just re-opens a new channel.

import { getActiveInstance } from './federationPairing.js';
import { openTerminalChannel } from './federationClient.js';

export async function remoteTerminalWs(fastify, opts) {
  fastify.get('/ws/remote-terminal', { websocket: true }, (socket, req) => {
    let channel = null;
    let opening = false;

    function sendError(message, code) {
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', message, code }));
      } catch { /* socket may already be gone */ }
    }

    socket.on('message', async (rawMessage) => {
      let msg;
      try {
        msg = JSON.parse(rawMessage.toString());
      } catch {
        return; // the remote relay only ever speaks JSON, unlike /ws/terminal's raw-passthrough fallback
      }

      if (channel) {
        channel.send(msg);
        return;
      }
      if (opening) return; // a second init/attach arriving before the first channel opened -- drop it

      const instanceId = typeof msg.instanceId === 'string' ? msg.instanceId : null;
      if (!instanceId) {
        sendError('instanceId is required for a remote terminal', 'INVALID_REQUEST');
        try { socket.close(); } catch { /* ignore */ }
        return;
      }
      if (!getActiveInstance(instanceId)) {
        sendError('this instance is not an active paired peer (it may have been revoked, or pairing is still pending)', 'INSTANCE_NOT_FOUND');
        try { socket.close(); } catch { /* ignore */ }
        return;
      }

      opening = true;
      try {
        channel = await openTerminalChannel(instanceId);
      } catch (err) {
        opening = false;
        sendError(`could not reach the remote instance: ${err.message}`, 'REMOTE_UNREACHABLE');
        try { socket.close(); } catch { /* ignore */ }
        return;
      }
      opening = false;

      channel.onMessage((frame) => {
        try {
          if (socket.readyState === 1) socket.send(JSON.stringify(frame));
        } catch { /* browser socket may already be gone */ }
      });
      channel.onClose(() => {
        sendError('the remote federation connection was closed', 'REMOTE_DISCONNECTED');
        try { socket.close(); } catch { /* ignore */ }
      });

      // Forward the very message that triggered the open (init/attach) --
      // the federation channel is brand new and has not seen it yet.
      channel.send(msg);
    });

    socket.on('close', () => {
      if (channel) channel.close();
    });
    socket.on('error', () => {
      if (channel) channel.close();
    });
  });
}
