import { useCallback, useEffect, useRef, useState } from 'react';
import { authWsUrl } from '../../auth.js';

const MAX_RECONNECT_ATTEMPTS = 20;
const PING_INTERVAL_MS = 30000;
// The pty log kept for the "起動ログ" panel: serve / bridge / VM launcher
// output only, so a modest cap is plenty.
const MAX_LOG_CHARS = 200_000;

// The ccserver session behind a chat tab, over the same /ws/terminal
// protocol TerminalView speaks: `init` launches (ui: 'chat'), `attach`
// rejoins, SESSION_NOT_FOUND re-launches (resuming the last conversation of
// the directory), and the pty output becomes the log. The conversation
// itself does not travel here -- see useOpencodeChat. The session-level
// controls ride along as in TerminalView: Auto-Y, network isolation, and
// (through onMessage) the scheduled prompt.
export function useChatSessionSocket({ app = 'opencode', cwd, sandbox, sandboxOpts, reuseSandboxHome, model, resume, attachSessionId, onSessionId, onSandboxResolved, onExited, onMessage }) {
  const [sessionId, setSessionId] = useState(attachSessionId || null);
  const [chat, setChat] = useState(null); // server's publicChatState
  const [log, setLog] = useState('');
  const [exited, setExited] = useState(null); // { exitCode, signal } once the pty is gone
  const [error, setError] = useState(null);
  const [disconnected, setDisconnected] = useState(false);
  const [launching, setLaunching] = useState(!attachSessionId);
  const [sandboxResolved, setSandboxResolved] = useState(!!sandbox);
  const [autoYes, setAutoYes] = useState(false);
  const [autoYesLog, setAutoYesLog] = useState([]);
  // { armed, enabled, scope } -- see TerminalView / networkIsolationStateMsg.
  const [networkIsolation, setNetworkIsolation] = useState({ armed: false, enabled: false, scope: 'session' });

  const cbRef = useRef({ onSessionId, onSandboxResolved, onExited, onMessage });
  cbRef.current = { onSessionId, onSandboxResolved, onExited, onMessage };
  const launchRef = useRef({ app, cwd, sandbox, sandboxOpts, reuseSandboxHome, model, resume, resumeId: null });
  const reconnectNowRef = useRef(() => {});
  const relaunchRef = useRef(() => {});
  const wsRef = useRef(null);

  useEffect(() => {
    let ws = null;
    let disposed = false;
    let attempts = 0;
    let reconnectTimer = null;
    let sid = attachSessionId || null;
    let stopped = false; // exit / takeover: no automatic reconnect

    const appendLog = (data) => setLog((prev) => {
      const next = prev + data;
      return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
    });

    const initMsg = (resumeLast) => {
      const l = launchRef.current;
      return {
        type: 'init', cwd: l.cwd, cols: 120, rows: 40, shell: false,
        sandbox: !!l.sandbox, sandboxOpts: l.sandboxOpts || null,
        reuseSandboxHome: l.reuseSandboxHome !== false,
        app: l.app || 'opencode', model: l.model || null, ui: 'chat',
        ...(l.resumeId ? { claudeSessionId: l.resumeId } : resumeLast ? { resume: true } : {}),
      };
    };

    function connect() {
      if (disposed || stopped) return;
      if (ws) { try { ws.close(); } catch { /* closed */ } }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(authWsUrl(`${protocol}//${window.location.host}/ws/terminal`));
      ws = sock;
      wsRef.current = sock;
      sock.onopen = () => {
        attempts = 0;
        setDisconnected(false);
        if (sid) sock.send(JSON.stringify({ type: 'attach', sessionId: sid, cols: 120, rows: 40 }));
        else {
          setLaunching(true);
          sock.send(JSON.stringify(initMsg(!!launchRef.current.resume)));
        }
      };
      sock.onmessage = (ev) => {
        if (ws !== sock) { sock.close(); return; }
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.type) {
          case 'session':
            sid = msg.sessionId;
            setSessionId(msg.sessionId);
            setLaunching(false);
            setExited(null);
            setError(null);
            cbRef.current.onSessionId?.(msg.sessionId);
            if (typeof msg.sandbox === 'boolean') {
              setSandboxResolved(msg.sandbox);
              cbRef.current.onSandboxResolved?.(msg.sandbox);
            }
            cbRef.current.onExited?.(false);
            if (msg.isReconnect) setLog('');
            break;
          case 'chat_state':
            setChat(msg.chat || null);
            break;
          case 'output':
          case 'replay':
            appendLog(msg.data);
            break;
          case 'exit':
            setExited({ exitCode: msg.exitCode, signal: msg.signal });
            stopped = true;
            sid = null;
            cbRef.current.onExited?.(true);
            break;
          case 'error':
            if (msg.code === 'SESSION_NOT_FOUND') {
              // The server lost the session (restart / timeout): launch a new
              // one that picks the conversation up again.
              sid = null;
              setSessionId(null);
              setChat(null);
              setLog('');
              setLaunching(true);
              sock.send(JSON.stringify(initMsg(true)));
            } else {
              setLaunching(false);
              setError(msg.message || 'unknown error');
            }
            break;
          case 'detached':
            stopped = true;
            setDisconnected(true);
            break;
          case 'auto_yes_state':
            setAutoYes(!!msg.enabled);
            setAutoYesLog(msg.log || []);
            break;
          case 'auto_yes':
            // Capped like the server's own session.autoYesLog.
            setAutoYesLog((prev) => [...prev, msg.entry].slice(-100));
            break;
          case 'network_isolation_state':
            setNetworkIsolation({ armed: !!msg.armed, enabled: !!msg.enabled, scope: msg.scope === 'vm' ? 'vm' : 'session' });
            break;
          default:
            cbRef.current.onMessage?.(msg);
            break;
        }
      };
      sock.onclose = () => {
        if (ws !== sock || disposed || stopped) return;
        setDisconnected(true);
        if (attempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(1000 * 2 ** attempts, 10000);
          attempts++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    }

    reconnectNowRef.current = () => {
      clearTimeout(reconnectTimer);
      attempts = 0;
      stopped = false;
      connect();
    };
    // After an exit: a fresh launch that resumes the conversation -- the
    // directory's latest one, or `resumeId` (Claude Code's history).
    relaunchRef.current = (resumeId = null) => {
      clearTimeout(reconnectTimer);
      attempts = 0;
      stopped = false;
      sid = null;
      launchRef.current = { ...launchRef.current, resume: true, ...(resumeId ? { resumeId } : {}) };
      setSessionId(null);
      setChat(null);
      setLog('');
      setExited(null);
      setError(null);
      setAutoYes(false);
      setAutoYesLog([]);
      connect();
    };

    connect();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        attempts = 0;
        clearTimeout(reconnectTimer);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    const ping = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearInterval(ping);
      document.removeEventListener('visibilitychange', onVisible);
      if (ws) { try { ws.close(); } catch { /* closed */ } }
    };
    // The launch parameters are fixed for the tab's lifetime (launchRef).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reconnect = useCallback(() => reconnectNowRef.current(), []);
  const relaunch = useCallback((resumeId) => relaunchRef.current(typeof resumeId === 'string' ? resumeId : null), []);
  // A message on the session's socket; false while it is not open.
  const send = useCallback((obj) => {
    const sock = wsRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    sock.send(JSON.stringify(obj));
    return true;
  }, []);

  return {
    sessionId, chat, log, exited, error, disconnected, launching, sandbox: sandboxResolved,
    autoYes, autoYesLog, networkIsolation, reconnect, relaunch, send,
  };
}
