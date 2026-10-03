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
// itself does not travel here -- see useOpencodeChat.
export function useChatSessionSocket({ cwd, sandbox, sandboxOpts, reuseSandboxHome, model, resume, attachSessionId, onSessionId, onSandboxResolved, onExited }) {
  const [sessionId, setSessionId] = useState(attachSessionId || null);
  const [chat, setChat] = useState(null); // server's publicChatState
  const [log, setLog] = useState('');
  const [exited, setExited] = useState(null); // { exitCode, signal } once the pty is gone
  const [error, setError] = useState(null);
  const [disconnected, setDisconnected] = useState(false);
  const [launching, setLaunching] = useState(!attachSessionId);
  const [sandboxResolved, setSandboxResolved] = useState(!!sandbox);

  const cbRef = useRef({ onSessionId, onSandboxResolved, onExited });
  cbRef.current = { onSessionId, onSandboxResolved, onExited };
  const launchRef = useRef({ cwd, sandbox, sandboxOpts, reuseSandboxHome, model, resume });
  const reconnectNowRef = useRef(() => {});
  const relaunchRef = useRef(() => {});

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
        app: 'opencode', model: l.model || null, ui: 'chat',
        ...(resumeLast ? { resume: true } : {}),
      };
    };

    function connect() {
      if (disposed || stopped) return;
      if (ws) { try { ws.close(); } catch { /* closed */ } }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(authWsUrl(`${protocol}//${window.location.host}/ws/terminal`));
      ws = sock;
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
          default:
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
    // After an exit: a fresh launch that resumes the conversation.
    relaunchRef.current = () => {
      clearTimeout(reconnectTimer);
      attempts = 0;
      stopped = false;
      sid = null;
      launchRef.current = { ...launchRef.current, resume: true };
      setSessionId(null);
      setChat(null);
      setLog('');
      setExited(null);
      setError(null);
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
  const relaunch = useCallback(() => relaunchRef.current(), []);

  return { sessionId, chat, log, exited, error, disconnected, launching, sandbox: sandboxResolved, reconnect, relaunch };
}
