import { homedir } from 'node:os';
import {
  createSession,
  createVmShellSession,
  getSession,
  attachSocket,
  detachSocket,
  resizeSession,
  writeToSession,
  setScheduledPrompt,
  cancelScheduledPrompt,
  scheduledPromptPublic,
  computeNextLocalTime,
  buildScheduleStateMsg as scheduleStateMsg,
  networkIsolationStateMsg,
  setPooledVmNetworkMode,
  chatStateMsg,
} from './sessionManager.js';
import { brokerArmed, setSessionBrokerMode } from './netbrokerClient.js';
import { setupRequired } from '../paths.js';

// The /ws/terminal message dispatcher, factored out of the route registration
// for a narrow channel interface compatible with sessionManager.js: `.send(jsonString)`,
// `.close(code, reason)`, and a numeric `.readyState` (1 === open).
//
// Behavior is unchanged from before this refactor -- every case body below is
// the same logic that used to close over the route handler's local `socket`
// variable, just parameterized as `chan`.
// WS messages refused while the #201 setup gate is up.
//
// index.js gates /api by method (writes 503, reads through) but lets all of
// /ws/ past, because blocking the WebSocket would cut every RUNNING session
// off from its browser -- and DEFAULT_SESSION_TIMEOUT_MS (12h) would then
// reap them, causing exactly the outage that not restarting the server was
// meant to avoid. An attacker-perspective review (attack-test-201 F2) showed
// the obvious consequence: the gate was trivially bypassed by talking WS
// instead of HTTP, and `init` happily created sessions whose state landed in
// the pre-migration paths the operator was about to migrate out from under.
//
// So the gate moves down to the message level, applying the same rule the
// HTTP side uses -- stop NEW state being created in the WRONG PLACE, without
// stopping anyone reaching what is already running:
//
//   init             creates a session (and the state files it writes).
//                    REFUSED. This is NOT the re-attach path: TerminalView
//                    sends `attach` whenever it has a sessionId and only
//                    falls back to `init` for a genuinely new session (or
//                    after SESSION_NOT_FOUND). Refusing it leaves every live
//                    session reachable.
//   schedule_prompt  writes scheduled-prompts.json. REFUSED.
//
// Everything else stays open on purpose: attach/input/resize/ping are the
// re-attach path itself; set_auto_yes and set_network_isolation mutate only
// in-memory session fields and a running broker's mode; cancel_schedule only
// REMOVES an entry (it can never create a state file that was not already
// there), and leaving it reachable lets an operator defuse a prompt that
// would otherwise fire into a gated host and try to launch a session.
const SETUP_GATED_MESSAGES = new Set(['init', 'schedule_prompt']);

export function attachTerminalHandler(chan) {
  let currentSessionId = null;

  async function handleMessage(msg) {
    if (SETUP_GATED_MESSAGES.has(msg.type) && setupRequired()) {
      chan.send(JSON.stringify({
        type: 'error',
        message: 'Setup is not complete on this host: run `npm run setup` and restart ccserver.',
        code: 'SETUP_REQUIRED',
      }));
      return;
    }
    switch (msg.type) {
      case 'init': {
        if (currentSessionId) {
          detachSocket(currentSessionId, chan);
        }

        // A VM Terminal (Settings GUI) is only ever opened from here, by
        // the browser itself -- see createVmShellSession.
        const result = typeof msg.vmShellId === 'string' ? await createVmShellSession({
          vmId: msg.vmShellId,
          cols: msg.cols || 80,
          rows: msg.rows || 24,
        }) : await createSession({
          cwd: msg.cwd || homedir(),
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          claudeSessionId: msg.claudeSessionId || null,
          shell: !!msg.shell,
          sandbox: !!msg.sandbox,
          sandboxOpts: msg.sandboxOpts || null,
          app: msg.app || null,
          model: typeof msg.model === 'string' ? msg.model : null,
          resumeLast: !!msg.resume,
          // Default reuse (keep the previous persistent HOME); only an
          // explicit false (client's "新規作成" dialog) wipes it.
          reuseSandboxHome: msg.reuseSandboxHome !== false,
          ui: msg.ui === 'chat' ? 'chat' : 'terminal',
        });
        if (result.error) {
          chan.send(JSON.stringify({
            type: 'error',
            message: result.error,
            code: 'SPAWN_FAILED',
          }));
          break;
        }

        const { sessionId, session } = result;
        currentSessionId = sessionId;
        attachSocket(sessionId, chan, { cols: msg.cols, rows: msg.rows });

        chan.send(
          JSON.stringify({
            type: 'session',
            sessionId,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            isReconnect: false,
            // Whether the host signs THIS session's commits (sandbox.js's
            // effective value, not just a requested override) -- the
            // client's signing badge (commitSigningBadge.js).
            commitSigningActive: !!session.commitSigningActive,
            // Effective sandbox flag, for the same reason and in the same
            // shape (issue #251). The client opens the tab optimistically
            // with the value it REQUESTED, but createSession overrides that
            // whenever forceSandbox or browseRoots mandates a sandbox -- so
            // without this the tab and the terminal header kept showing
            // "no sandbox" for a session that was in fact sandboxed, while
            // the session list (which reads the server's value) showed the
            // opposite for the very same session.
            sandbox: !!session.sandbox,
            ui: session.ui || 'terminal',
          })
        );
        if (session.chat) chan.send(JSON.stringify(chatStateMsg(session)));
        chan.send(scheduleStateMsg(scheduledPromptPublic(session)));
        chan.send(JSON.stringify(networkIsolationStateMsg(session)));
        break;
      }

      case 'attach': {
        if (!msg.sessionId) {
          chan.send(
            JSON.stringify({
              type: 'error',
              message: 'sessionId required',
              code: 'INVALID_REQUEST',
            })
          );
          break;
        }

        const session = getSession(msg.sessionId);
        // Refuse attaching to an exited session: the pty is gone, so the
        // client-side re-init path (which carries the tab's launch
        // settings, e.g. sandbox) is the correct continuation. Attaching
        // here would otherwise leave the user staring at a stale "Process
        // exited" screen and, worse, cancel the exit-cleanup timer
        // (attachSocket clears timeoutTimer), turning the session into a
        // zombie that lingers until the server restarts.
        if (!session || session.exited) {
          chan.send(
            JSON.stringify({
              type: 'error',
              message: 'Session not found',
              code: 'SESSION_NOT_FOUND',
            })
          );
          break;
        }

        if (currentSessionId && currentSessionId !== msg.sessionId) {
          detachSocket(currentSessionId, chan);
        }

        currentSessionId = msg.sessionId;
        // Taking over: any client already watching this session is evicted
        // (code 4001). The viewport rides along so the pty follows this
        // client's window size.
        attachSocket(msg.sessionId, chan, { cols: msg.cols, rows: msg.rows });

        chan.send(
          JSON.stringify({
            type: 'session',
            sessionId: msg.sessionId,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            isReconnect: true,
            commitSigningActive: !!session.commitSigningActive,
            // Same effective value on re-attach (issue #251).
            sandbox: !!session.sandbox,
            ui: session.ui || 'terminal',
          })
        );
        if (session.chat) chan.send(JSON.stringify(chatStateMsg(session)));

        for (const chunk of session.outputBuffer) {
          if (chan.readyState === 1) {
            chan.send(JSON.stringify({ type: 'replay', data: chunk }));
          }
        }

        if (session.exited) {
          chan.send(
            JSON.stringify({
              type: 'exit',
              exitCode: session.exitCode,
              signal: session.exitSignal,
              claudeSessionId: session.claudeSessionId,
            })
          );
        }

        // (No direct pty resize here: attachSocket above already sized the
        // pty to this client's viewport.)

        // Send auto-yes state on attach
        if (!session.shell) {
          chan.send(JSON.stringify({
            type: 'auto_yes_state',
            enabled: session.autoYes,
            log: session.autoYesLog,
          }));
        }

        // Send scheduled-prompt state on attach (available for all sessions)
        chan.send(scheduleStateMsg(scheduledPromptPublic(session)));
        chan.send(JSON.stringify(networkIsolationStateMsg(session)));
        break;
      }

      case 'input': {
        if (currentSessionId) {
          writeToSession(currentSessionId, msg.data);
        }
        break;
      }

      case 'ping': {
        chan.send(JSON.stringify({ type: 'pong' }));
        break;
      }

      case 'resize': {
        if (currentSessionId && msg.cols && msg.rows) {
          // One client per session: the pty simply follows its viewport.
          resizeSession(currentSessionId, chan, msg.cols, msg.rows);
        }
        break;
      }

      case 'set_auto_yes': {
        if (currentSessionId) {
          const session = getSession(currentSessionId);
          if (session && !session.shell) {
            session.autoYes = !!msg.enabled;
            chan.send(JSON.stringify({
              type: 'auto_yes_state',
              enabled: session.autoYes,
              log: session.autoYesLog,
            }));
          }
        }
        break;
      }

      case 'get_auto_yes': {
        if (currentSessionId) {
          const session = getSession(currentSessionId);
          if (session) {
            chan.send(JSON.stringify({
              type: 'auto_yes_state',
              enabled: session.autoYes,
              log: session.autoYesLog,
            }));
          }
        }
        break;
      }

      case 'set_network_isolation': {
        if (currentSessionId) {
          const session = getSession(currentSessionId);
          if (session && brokerArmed(session)) {
            const mode = msg.enabled ? 'enforce' : 'open';
            let ok;
            if (session.qemuVm?.pooled) {
              // One broker serves the whole persistent VM: flip it for every
              // session on it (they all get the new state broadcast).
              ok = await setPooledVmNetworkMode(session.qemuVm.vmId, mode);
            } else {
              ok = await setSessionBrokerMode(session, mode);
              if (ok) {
                session.networkIsolateMode = mode;
              }
            }
            chan.send(JSON.stringify({ ...networkIsolationStateMsg(session), ok }));
          } else if (session) {
            // No isolation for this session (or the broker handle is somehow
            // incomplete) -- nothing to flip, but the client still gets a
            // definitive answer instead of silence.
            chan.send(JSON.stringify({ ...networkIsolationStateMsg(session), ok: false }));
          }
        }
        break;
      }

      case 'get_network_isolation': {
        if (currentSessionId) {
          const session = getSession(currentSessionId);
          if (session) {
            chan.send(JSON.stringify(networkIsolationStateMsg(session)));
          }
        }
        break;
      }

      case 'schedule_prompt': {
        if (currentSessionId) {
          // Prefer an "HH:MM" wall-clock time interpreted in the server's
          // timezone; fall back to an explicit absolute epoch (`at`).
          const at = msg.time != null
            ? computeNextLocalTime(msg.time)
            : Number(msg.at);
          const text = typeof msg.text === 'string' ? msg.text : '';
          const scheduled = at != null ? setScheduledPrompt(currentSessionId, at, text) : null;
          chan.send(scheduleStateMsg(
            scheduled,
            scheduled ? undefined : 'Invalid schedule (time must be HH:MM in the future within 48h, with non-empty text)'
          ));
        }
        break;
      }

      case 'cancel_schedule': {
        if (currentSessionId) {
          cancelScheduledPrompt(currentSessionId);
          chan.send(scheduleStateMsg(null));
        }
        break;
      }

      case 'get_schedule': {
        if (currentSessionId) {
          const session = getSession(currentSessionId);
          if (session) {
            chan.send(scheduleStateMsg(scheduledPromptPublic(session)));
          }
        }
        break;
      }
    }
  }

  // A message that failed JSON.parse is treated as raw pty input for whatever
  // session is currently attached.
  function handleRaw(rawString) {
    if (currentSessionId) {
      const session = getSession(currentSessionId);
      if (session?.ptyProcess && !session.exited) {
        session.ptyProcess.write(rawString);
      }
    }
  }

  function handleClose() {
    if (currentSessionId) {
      detachSocket(currentSessionId, chan);
      currentSessionId = null;
    }
  }

  return { handleMessage, handleRaw, handleClose, getCurrentSessionId: () => currentSessionId };
}

export async function terminalWs(fastify, opts) {
  fastify.get('/ws/terminal', { websocket: true }, (socket, req) => {
    const handler = attachTerminalHandler(socket);

    socket.on('message', async (rawMessage) => {
      let msg;
      try {
        msg = JSON.parse(rawMessage.toString());
      } catch {
        handler.handleRaw(rawMessage.toString());
        return;
      }

      try {
        await handler.handleMessage(msg);
      } catch (err) {
        fastify.log.error({ err }, 'terminal message handler error');
        try {
          socket.send(JSON.stringify({ type: 'error', message: String(err?.message || err), code: 'INTERNAL_ERROR' }));
        } catch { /* socket may be gone */ }
      }
    });

    socket.on('close', () => handler.handleClose());

    socket.on('error', (err) => {
      fastify.log.error('WebSocket error:', err);
      handler.handleClose();
    });
  });
}
