import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '../../auth.js';
import { displayPath } from '../../displayPath.js';
import { useChatSessionSocket } from './useChatSessionSocket.js';
import { useOpencodeChat } from './useOpencodeChat.js';
import StartupProgress from './StartupProgress.jsx';
import ChatLogPanel from './ChatLogPanel.jsx';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import { FormPrompt, PermissionPrompt } from './PermissionPrompt.jsx';
import ChatHeaderMenu from './ChatHeaderMenu.jsx';
import ChatHistoryPanel from './ChatHistoryPanel.jsx';
import SchedulerPanel, { useScheduledPrompt } from '../SchedulerPanel.jsx';
import { AutoYesLogPanel, useAutoYesToggle } from '../AutoYesControls.jsx';
import NetworkIsolationToggle from '../NetworkIsolationToggle.jsx';

const APP_NAMES = { opencode: 'opencode', claude: 'Claude Code' };

// An app in chat mode: the ccserver session (launch, startup stages, log)
// over the terminal WebSocket, the conversation over opencode's v2 API
// through ccserver's proxy -- opencode's own, or Claude Code's through the
// claude-chat-adapter. See server/ws/opencodeChat.js.
export default function ChatView({ app = 'opencode', cwd, sandbox, sandboxOpts, reuseSandboxHome = true, model = null, resume = false, customLabel = null, notify, notifyEnabled, notifyPermission, onToggleNotify, visible, onSessionId, onSandboxResolved, onExited, attachSessionId, onFocusTab }) {
  const appName = APP_NAMES[app] || app;
  // The socket's messages the hook itself does not keep (scheduled prompt,
  // conversation switch); a ref, since the handlers below need `session`.
  const socketMessageRef = useRef(() => {});
  const onSocketMessage = useCallback((msg) => socketMessageRef.current(msg), []);
  const session = useChatSessionSocket({ app, cwd, sandbox, sandboxOpts, reuseSandboxHome, model, resume, attachSessionId, onSessionId, onSandboxResolved, onExited, onMessage: onSocketMessage });
  // The conversation stays on screen after opencode exits (read-only, with
  // a relaunch banner); only a live session takes input.
  const ready = !!session.chat?.ready;
  const live = ready && !session.exited;
  const chat = useOpencodeChat({ sessionId: session.sessionId, ocSessionId: session.chat?.ocSessionId, enabled: live });
  // The one panel open over the conversation: 'history' | 'timer' |
  // 'autoYesLog' | 'log' | null (the header menu opens them).
  const [panel, setPanel] = useState(null);
  const logOpen = panel === 'log';
  const [switching, setSwitching] = useState(false);
  const sched = useScheduledPrompt({ send: session.send, app, open: panel === 'timer' });
  const autoYesToggle = useAutoYesToggle({ sandbox: session.sandbox, send: session.send });
  const [homeDir, setHomeDir] = useState(null);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    authFetch('/api/dirs/home').then((r) => r.json()).then((d) => { if (d.home) setHomeDir(d.home); }).catch(() => {});
  }, []);

  // A failed start opens the log by itself: that is where the cause is.
  const failed = !!session.error || !!session.chat?.error || (!!session.exited && !ready);
  useEffect(() => { if (failed) setPanel('log'); }, [failed]);

  // Browser notifications while this tab is not the one being looked at: a
  // finished turn, and anything waiting on the user.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const prevBusy = useRef(false);
  const notifyUser = useCallback((body, tag) => {
    if (visibleRef.current && document.visibilityState === 'visible') return;
    const n = notifyRef.current?.(appName, { body, icon: '/icon-192.png', tag });
    if (n) {
      n.onclick = () => { window.focus(); onFocusTab?.(); n.close(); };
    }
  }, [onFocusTab, appName]);
  useEffect(() => {
    if (prevBusy.current && !chat.busy) notifyUser(`応答が完了しました — ${displayPath(cwd, homeDir)}`, `chat-done-${cwd}`);
    prevBusy.current = chat.busy;
  }, [chat.busy, cwd, homeDir, notifyUser]);
  const permCount = chat.permissions.length + chat.forms.length;
  const prevPerm = useRef(0);
  useEffect(() => {
    if (permCount > prevPerm.current) notifyUser(`入力待ちです — ${displayPath(cwd, homeDir)}`, `chat-wait-${cwd}`);
    prevPerm.current = permCount;
  }, [permCount, cwd, homeDir, notifyUser]);

  socketMessageRef.current = (msg) => {
    if (sched.handleMessage(msg)) {
      if (msg.type === 'schedule_fired') notifyUser(`予約プロンプトを送信しました — ${displayPath(cwd, homeDir)}`, `schedule-fired-${cwd}`);
      return;
    }
    if (msg.type === 'chat_switch_result') {
      setSwitching(false);
      if (msg.ok) setPanel(null);
      else setActionError('会話を切り替えられませんでした');
    }
  };

  // History: opencode's serve holds every conversation of the directory and
  // switches in place; Claude Code's adapter holds one per process, so the
  // session is relaunched on the picked transcript.
  const selectConversation = async (id) => {
    setActionError(null);
    if (app === 'claude') {
      setPanel(null);
      if (session.sessionId) {
        await authFetch(`/api/sessions/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' }).catch(() => {});
      }
      session.relaunch(id);
      return;
    }
    if (session.send({ type: 'chat_switch_session', ocSessionId: id })) setSwitching(true);
  };

  const guard = (fn) => async (...args) => {
    setActionError(null);
    try { await fn(...args); } catch (err) { setActionError(err.message); }
  };

  const title = chat.info?.title && chat.info.title !== 'New session' ? chat.info.title : null;
  const effectiveSandbox = session.sandbox;

  return (
    <div className="chat-view">
      <div className={`terminal-header${!effectiveSandbox ? ' no-sandbox' : ''}`}>
        <span className="terminal-title" title={cwd}>
          {effectiveSandbox ? '🔒 ' : '⚠️ '}💬 {customLabel ? `${customLabel} — ` : ''}{appName}{title ? ` · ${title}` : ''} &mdash; {displayPath(cwd, homeDir)}
        </span>
        <div className="header-actions">
          {live && !chat.streamConnected && <span className="chat-status chat-status--warn" title="イベントストリームに再接続中">再接続中…</span>}
          {session.networkIsolation.armed && (
            <NetworkIsolationToggle
              enabled={session.networkIsolation.enabled}
              scope={session.networkIsolation.scope}
              onToggle={() => session.send({ type: 'set_network_isolation', enabled: !session.networkIsolation.enabled })}
            />
          )}
          <ChatHeaderMenu
            panel={panel}
            onPanel={setPanel}
            live={live}
            hasSession={!!session.sessionId && !session.exited}
            schedule={sched.schedule}
            fmtServer={sched.fmtServer}
            autoYes={session.autoYes}
            autoYesLogCount={session.autoYesLog.length}
            onToggleAutoYes={() => autoYesToggle.toggle(!session.autoYes)}
            notifyEnabled={notifyEnabled}
            notifyPermission={notifyPermission}
            onToggleNotify={onToggleNotify}
          />
        </div>
      </div>

      {panel === 'history' && live && (
        <ChatHistoryPanel
          sessionId={session.sessionId}
          currentId={session.chat?.ocSessionId}
          busy={chat.busy}
          switching={switching}
          onSelect={selectConversation}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'timer' && <SchedulerPanel sched={sched} onClose={() => setPanel(null)} />}
      {panel === 'autoYesLog' && session.autoYesLog.length > 0 && (
        <AutoYesLogPanel log={session.autoYesLog} onClose={() => setPanel(null)} />
      )}

      {session.disconnected && (
        <div className="chat-banner chat-banner--warn">
          サーバーとの接続が切れました
          <button type="button" className="btn chat-link-btn" onClick={session.reconnect}>再接続</button>
        </div>
      )}

      <div className="chat-body">
        {!ready ? (
          <div className="chat-startup-wrap">
            <StartupProgress
              stages={session.launching ? null : session.chat?.stages || null}
              appName={appName}
              launchError={session.error}
              exited={session.exited}
              logOpen={logOpen}
              onShowLog={() => setPanel((v) => (v === 'log' ? null : 'log'))}
              onRelaunch={session.error || session.exited ? session.relaunch : null}
            />
          </div>
        ) : (
          <MessageList
            messages={chat.messages}
            pending={chat.pending}
            busy={chat.busy}
            onDismissPending={chat.dismissPending}
          />
        )}
        {logOpen && <ChatLogPanel log={session.log} onClose={() => setPanel(null)} />}
      </div>

      {live && (
        <div className="chat-dock">
          {(chat.permissions.length > 0 || chat.forms.length > 0 || actionError || chat.error) && (
            <div className="chat-dock-prompts">
              {chat.permissions.map((p) => (
                <PermissionPrompt key={p.id} request={p} onReply={chat.replyPermission} />
              ))}
              {chat.forms.map((f) => (
                <FormPrompt key={f.id} form={f} onSubmit={chat.replyForm} onCancel={guard(chat.cancelForm)} />
              ))}
              {(actionError || chat.error) && <div className="chat-banner chat-banner--error">{actionError || chat.error}</div>}
            </div>
          )}
          <Composer
            draftKey={session.sessionId || cwd}
            disabled={!chat.loaded}
            busy={chat.busy}
            messages={chat.messages}
            onSend={chat.send}
            onCommand={guard(chat.runCommand)}
            onInterrupt={guard(chat.interrupt)}
            commands={chat.commands}
            agents={chat.agents}
            models={chat.models}
            agent={chat.info?.agent}
            model={chat.info?.model}
            onAgent={guard(chat.switchAgent)}
            onModel={guard(chat.switchModel)}
            onEffort={guard(chat.switchEffort)}
          />
        </div>
      )}
      {ready && session.exited && (
        <div className="chat-banner chat-banner--error">
          {appName} が終了しました (code {session.exited.exitCode})
          <button type="button" className="btn chat-link-btn" onClick={session.relaunch}>再起動して続きから</button>
        </div>
      )}
      {autoYesToggle.dialog}
    </div>
  );
}
