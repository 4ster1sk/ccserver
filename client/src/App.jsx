import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import SettingsView from './components/SettingsView.jsx';
import ApprovalBanner from './components/ApprovalBanner.jsx';
import TabIcon, { sessionMenuIcon } from './components/TabIcon.jsx';
import SessionSidebar from './components/SessionSidebar.jsx';
import SessionContextMenu from './components/SessionContextMenu.jsx';
import SessionRenameDialog from './components/SessionRenameDialog.jsx';
import RightSidebar, { WIDGET_DEFS, MONITOR_WIDGET_IDS } from './components/RightSidebar.jsx';
import { SystemStatsProvider } from './components/widgets/SystemStatsProvider.jsx';
import { CommitSigningStatusProvider } from './components/CommitSigningStatusProvider.jsx';
import CommitSigningUnlockButton from './components/CommitSigningUnlockButton.jsx';
import { useWidgetPrefs } from './hooks/useWidgetPrefs.js';
import { useSessionSidebarPrefs } from './hooks/useSessionSidebarPrefs.js';
import { NARROW_DRAWER_QUERY } from './hooks/viewportQuery.js';
import { useNotifications } from './hooks/useNotifications.js';
import { useVisiblePolling } from './hooks/useVisiblePolling.js';
import { loadNavGuardMode, saveNavGuardMode, useNavGuard } from './hooks/useNavGuard.js';
import { authFetch } from './auth.js';
import { getTheme, loadThemeId, saveThemeId, applyThemeCss } from './themes.js';
import { loadSandboxDefaults, saveSandboxDefaults } from './sandboxDefaults.js';
import { isAppSelectable, isAppVisible } from './appAvailability.js';

const TerminalView = lazy(() => import('./components/TerminalView.jsx'));
const ChatView = lazy(() => import('./components/chat/ChatView.jsx'));

let tabIdCounter = 0;

// Whether a tab's session can be fully terminated rather than merely
// detached: terminal tabs with a known session id. Local tabs DELETE
// /api/sessions/:id.
function canTerminateTab(tab) {
  return !!tab && tab.type === 'terminal' && !!(tab.sessionId || tab.attachSessionId);
}

export default function App() {
  const [tabs, setTabs] = useState([
    { id: 'browser', type: 'browser', label: 'Files' },
    { id: 'settings', type: 'settings', label: 'Settings' },
  ]);
  const [activeTabId, setActiveTabId] = useState('browser');
  const [lastDir, setLastDir] = useState(() => localStorage.getItem('ccserver-last-dir'));
  // Reuse dialog for a sandboxed launch when a previous persistent sandbox
  // exists for the project: { cwd, sandbox, sandboxOpts, app, model,
  // permissionMode, resume, reuseSandboxHome, inUse }.
  const [sandboxPrompt, setSandboxPrompt] = useState(null);
  // VM (qemu) launch while other VMs already run: a warning instead of the
  // reuse dialog. { cwd, ...launch opts, runningVms } (see proceedOpen).
  const [vmRunningPrompt, setVmRunningPrompt] = useState(null);
  // Duplicate-launch guard (issue #132): { cwd, opts, session } when a live
  // session already runs in the directory being opened.
  const [duplicateSessionPrompt, setDuplicateSessionPrompt] = useState(null);
  const [themeId, setThemeId] = useState(loadThemeId);
  const [closeConfirm, setCloseConfirm] = useState(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  // "セッションを終了" (terminateSessionById) is async: while its DELETE
  // is in flight the dialog buttons are disabled and re-entry is ignored,
  // so a double-click can't fire a duplicate DELETE (whose 404 would
  // surface a bogus failure alert after a successful termination).
  // The guard is a ref keyed by tabId (not just the state below): setState
  // applies asynchronously, so two clicks before the next render would both
  // see a stale `false` and slip through. Keying by tabId (rather than a
  // single shared flag) matters because terminateSessionById is also called
  // from the "次回以降確認しない" skip path in handleCloseTab, where
  // closing several different tabs in quick succession must not have the
  // second one silently no-op just because the first tab's DELETE is still
  // in flight. The state remains for the disabled UI (dialog-only, so it
  // only ever reflects the single in-flight closeConfirm.tabId).
  const terminatingTabIdsRef = useRef(new Set());
  const [isTerminatingSession, setIsTerminatingSession] = useState(false);
  // Hoisted above terminateSessionById (below) so it can optimistically drop
  // a just-terminated session the instant doCloseTab fires, in the same
  // render as the tab's removal -- otherwise there's a render in between
  // where `tabs` no longer lists the session but this stale snapshot still
  // does, and the unopened-section filter (openedSessionIds vs
  // serverSessions, further down) briefly mis-files the just-terminated
  // session as a still-running "unopened" one.
  const [serverSessions, setServerSessions] = useState([]);
  const [skipCloseConfirm, setSkipCloseConfirm] = useState(() => {
    try {
      return localStorage.getItem('ccserver-skip-close-confirm') === '1';
    } catch {
      return false;
    }
  });
  // 終了確認スキップの永続化付き setter (一般設定タブと終了確認ダイアログ
  // の「次回以降確認しない」から共有する)。
  const setSkipCloseConfirmPersisted = useCallback((v) => {
    setSkipCloseConfirm(v);
    try {
      if (v) localStorage.setItem('ccserver-skip-close-confirm', '1');
      else localStorage.removeItem('ccserver-skip-close-confirm');
    } catch {
      // ignore (private mode etc.)
    }
  }, []);
  const pendingOpenRef = useRef(null);
  // ブラウザの「戻る / 進む」履歴操作ガード (Settings > 一般で変更。
  // confirm: 確認ダイアログ / suppress: 黙って抑制 / allow: 無効)。
  const [navGuardMode, setNavGuardMode] = useState(loadNavGuardMode);
  const setNavGuardModePersisted = useCallback((v) => {
    setNavGuardMode(v);
    saveNavGuardMode(v);
  }, []);
  useNavGuard(navGuardMode);
  // サンドボックス起動フラグのグローバル既定値 (Settings > 一般で変更。
  // ディレクトリ別記憶が無い場合の初期値として DirectoryBrowser が使う)。
  const [sandboxDefaults, setSandboxDefaults] = useState(loadSandboxDefaults);
  const setSandboxDefaultsPersisted = useCallback((next) => {
    setSandboxDefaults(next);
    saveSandboxDefaults(next);
  }, []);
  const { enabled: notifyEnabled, permission: notifyPermission, toggle: toggleNotify, notify } = useNotifications();
  // Server-side facts from /api/dirs/home: whether the Usage button is
  // enabled (sandbox.config.json's "showUsage") and which agent CLIs are
  // installed here (availableApps). Usage is only meaningful when claude
  // exists, so a missing claude hides the button regardless of showUsage.
  const [usagePrefs, setUsagePrefs] = useState({ showUsage: true, availableApps: null, hiddenApps: [], toolsAvailable: null });

  useEffect(() => {
    applyThemeCss(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  // Browser tab title: "<hostname> ccserver" (hostname resolved server-side
  // with the same precedence as the notify footer's _from: <host>). The
  // static index.html fallback is "ccserver"; this upgrades it once the API
  // answers. Silent on failure (e.g. token auth gate) -- the fallback stays.
  // Idempotent, so React StrictMode's double mount is harmless.
  useEffect(() => {
    authFetch('/api/dirs/home')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.hostname) document.title = `${data.hostname} ccserver`;
        // Absent keys (older server / default config) keep the button shown
        // and the app picker unrestricted.
        setUsagePrefs({
          showUsage: data.showUsage !== false,
          availableApps: data.availableApps || null,
          hiddenApps: Array.isArray(data.hiddenApps) ? data.hiddenApps : [],
          // Which opt-in sandbox tools this host can provision (false on macOS);
          // null/absent = older server -> the settings toggles stay enabled.
          toolsAvailable: (data.toolsAvailable && typeof data.toolsAvailable === 'object') ? data.toolsAvailable : null,
        });
      })
      .catch(() => {});
  }, []);

  const openTerminalTab = useCallback((dirPath, { claudeSessionId = null, shell = false, sessionId = null, attachSessionId = null, sandbox = false, sandboxOpts = null, app = 'claude', model = null, resume = false, reuseSandboxHome = true, label: labelOverride = null, ui = 'terminal' } = {}) => {
    const id = `terminal-${++tabIdCounter}`;
    const dirName = dirPath.split(/[/\\]/).filter(Boolean).pop() || dirPath;
    const label = labelOverride || (shell ? `$ ${dirName}` : dirName);
    setTabs((prev) => [
      ...prev,
      // ui: 'chat' renders the session with ChatView (opencode / Claude Code
      // chat mode) instead of xterm.js; everything else about the tab is the
      // same.
      { id, type: 'terminal', label, cwd: dirPath, claudeSessionId, shell, sessionId, attachSessionId, sandbox, sandboxOpts, app, model, resume, reuseSandboxHome, ui: !shell && (app === 'opencode' || app === 'claude') && ui === 'chat' ? 'chat' : 'terminal', exited: false },
    ]);
    setActiveTabId(id);
    // A VM Terminal's cwd is the guest's, not a host directory to browse.
    if (!sandboxOpts?.vmShellId) setLastDir(dirPath);
  }, []);

  // The post-sandbox-dialog open flow: a plain tab open. Carries the chosen
  // reuseSandboxHome through to the new tab.
  const continueOpen = useCallback((dirPath, { sandbox = false, sandboxOpts = null, app = 'claude', model = null, resume = false, reuseSandboxHome = true, ui = 'terminal' } = {}) => {
    openTerminalTab(dirPath, { sandbox, sandboxOpts, app, model, resume, reuseSandboxHome, ui });
  }, [openTerminalTab]);

  // Sandboxed agent launch: before opening, ask the server whether a previous
  // persistent sandbox exists for this project; if so, show the reuse dialog
  // (existing resume prompt takes a back seat until the choice is made).
  // A VM (qemu) launch skips the reuse dialog and keeps the previous HOME;
  // it only warns (continue / cancel) when it would boot a new VM while
  // others already run -- not when it joins a running persistent VM.
  // Renamed from `handleOpen` -- the duplicate-session check below now runs
  // first and calls this once cleared / overridden by the user.
  const proceedOpen = useCallback(async (dirPath, opts = {}) => {
    if (opts.sandbox) {
      try {
        const backend = opts.sandboxOpts?.backend || '';
        const vmTemplateId = opts.sandboxOpts?.vmTemplateId || '';
        const res = await authFetch(`/api/sandbox/status?cwd=${encodeURIComponent(dirPath)}&backend=${encodeURIComponent(backend)}&vmTemplateId=${encodeURIComponent(vmTemplateId)}`);
        const data = res.ok ? await res.json() : null;
        if (data?.backend === 'qemu') {
          if (!data.joinsRunningVm && data.runningVms?.length > 0) {
            pendingOpenRef.current = dirPath;
            setVmRunningPrompt({ cwd: dirPath, ...opts, runningVms: data.runningVms });
            return;
          }
          continueOpen(dirPath, { ...opts, reuseSandboxHome: true });
          return;
        }
        if (data?.enabled && data?.exists) {
          pendingOpenRef.current = dirPath;
          setSandboxPrompt({ cwd: dirPath, ...opts, inUse: data.inUse || 0 });
          return;
        }
      } catch {
        // older server / unreachable: proceed without the dialog
      }
    }
    continueOpen(dirPath, opts);
  }, [continueOpen]);

  // Before actually launching, warn when a live (non-shell) session already
  // runs in this exact directory -- e.g. it was opened from another browser
  // tab/window/device this tab's own `tabs` state knows nothing about (see
  // issue #132).
  const handleOpen = useCallback(async (dirPath, opts = {}) => {
    try {
      // A fresh fetch, not the `serverSessions` state: that's only kept
      // current while the session sidebar/menu is open (see
      // fetchServerSessions below), so it can be stale or empty here.
      const res = await authFetch('/api/sessions');
      const data = res.ok ? await res.json() : null;
      const dup = (data?.sessions || []).find((s) => !s.shell && s.cwd === dirPath);
      if (dup) {
        pendingOpenRef.current = dirPath;
        setDuplicateSessionPrompt({ cwd: dirPath, opts, session: dup });
        return;
      }
    } catch {
      // server unreachable (offline, DNS, etc.): proceed without the
      // duplicate check rather than blocking the launch entirely.
    }
    await proceedOpen(dirPath, opts);
  }, [proceedOpen]);

  const handleSandboxReuse = useCallback(() => {
    if (!sandboxPrompt) return;
    const p = sandboxPrompt;
    setSandboxPrompt(null);
    pendingOpenRef.current = null;
    continueOpen(p.cwd, { ...p, reuseSandboxHome: true });
  }, [sandboxPrompt, continueOpen]);

  const handleSandboxNew = useCallback(() => {
    if (!sandboxPrompt) return;
    const p = sandboxPrompt;
    setSandboxPrompt(null);
    pendingOpenRef.current = null;
    // Wiping happens server-side at launch; nothing to clean up client-side
    // except the persisted claude resume id has no bearing on the HOME.
    continueOpen(p.cwd, { ...p, reuseSandboxHome: false });
  }, [sandboxPrompt, continueOpen]);

  const cancelSandboxPrompt = useCallback(() => {
    setSandboxPrompt(null);
    pendingOpenRef.current = null;
  }, []);

  const handleVmRunningContinue = useCallback(() => {
    if (!vmRunningPrompt) return;
    const { runningVms, ...p } = vmRunningPrompt;
    setVmRunningPrompt(null);
    pendingOpenRef.current = null;
    continueOpen(p.cwd, { ...p, reuseSandboxHome: true });
  }, [vmRunningPrompt, continueOpen]);

  const cancelVmRunningPrompt = useCallback(() => {
    setVmRunningPrompt(null);
    pendingOpenRef.current = null;
  }, []);

  const handleOpenShell = useCallback((dirPath) => {
    openTerminalTab(dirPath, { shell: true });
  }, [openTerminalTab]);

  // Settings > VM: a shell on a running persistent VM (the server opens it
  // in the guest user's home, outside the guest bwrap).
  const handleOpenVmTerminal = useCallback((vm) => {
    openTerminalTab('~', {
      shell: true,
      sandbox: true,
      sandboxOpts: { backend: 'qemu', vmShellId: vm.vmId },
      label: `$ VM ${vm.templateName || '既定設定'}`,
    });
  }, [openTerminalTab]);

  const handleSessionClick = useCallback((session) => {
    // Check if a tab is already open for this session
    const existingTab = tabs.find((t) => t.sessionId === session.id);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }
    // Carry the session's launch settings over so a re-launch after the
    // original pty is gone (SESSION_NOT_FOUND -> re-init in TerminalView)
    // keeps the sandbox instead of silently dropping it.
    openTerminalTab(session.cwd, {
      shell: !!session.shell,
      sessionId: session.id,
      attachSessionId: session.id,
      app: session.app === 'opencode' ? 'opencode' : session.app === 'codex' ? 'codex' : 'claude',
      model: session.model || null,
      sandbox: !!session.sandbox,
      sandboxOpts: session.sandboxOpts || null,
      ui: session.ui === 'chat' ? 'chat' : 'terminal',
      // opencode/codex re-launches resume the last session of
      // the project (-c / --continue / resume --last), so a continued
      // conversation survives the dead pty like claude's does.
      resume: session.app === 'opencode' || session.app === 'codex',
    });
  }, [tabs, openTerminalTab]);

  // Duplicate-launch prompt actions (issue #132). Placed after
  // handleSessionClick/proceedOpen since both are referenced here.
  const handleOpenExistingDuplicate = useCallback(() => {
    if (!duplicateSessionPrompt) return;
    const { session } = duplicateSessionPrompt;
    setDuplicateSessionPrompt(null);
    pendingOpenRef.current = null;
    handleSessionClick(session);
  }, [duplicateSessionPrompt, handleSessionClick]);

  const handleForceNewDuplicate = useCallback(() => {
    if (!duplicateSessionPrompt) return;
    const { cwd, opts } = duplicateSessionPrompt;
    setDuplicateSessionPrompt(null);
    pendingOpenRef.current = null;
    proceedOpen(cwd, opts);
  }, [duplicateSessionPrompt, proceedOpen]);

  const cancelDuplicateSessionPrompt = useCallback(() => {
    setDuplicateSessionPrompt(null);
    pendingOpenRef.current = null;
  }, []);

  const doCloseTab = useCallback((tabId) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      // If we're closing the active tab, switch to an adjacent tab
      if (tabId === activeTabId) {
        const newActive = next[Math.min(idx, next.length - 1)];
        // Closing the last terminal makes the adjacent pick spill over into
        // static tabs; land on Files instead.
        const isDynamic = (t) => t?.type === 'terminal';
        setActiveTabId(isDynamic(newActive) ? newActive.id : 'browser');
      }
      return next;
    });
  }, [activeTabId]);

  // 対象タブのセッションを完全に終了する (DELETE /api/sessions/:id) 後に
  // タブを閉じる。閉じる確認ダイアログの「セッションを終了」ボタンと、
  // 「次回以降確認しない」設定時の即時終了の両方がこれを通る。
  // 削除不能な形 (sessionId不明) は従来通り閉じるだけにフォールバックする。
  // Returns true once the tab is actually closed (termination succeeded, or
  // there was nothing to terminate), false on failure or when a concurrent
  // call is already in flight -- callers that persist "次回以降確認しない"
  // only after success (terminateSessionAndCloseTab below) rely on this.

  const terminateSessionById = useCallback(async (tabId) => {
    if (terminatingTabIdsRef.current.has(tabId)) return false;
    const tab = tabs.find((t) => t.id === tabId);
    const sessionId = tab?.sessionId || tab?.attachSessionId || null;
    if (!tab || !sessionId) { doCloseTab(tabId); return true; }
    terminatingTabIdsRef.current.add(tabId);
    setIsTerminatingSession(true);
    try {
      const res = await authFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      if (res.status === 404) {
        // Session already gone server-side: termination is effectively done.
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`セッションを終了できませんでした: ${err.message}`);
      return false;
    } finally {
      terminatingTabIdsRef.current.delete(tabId);
      setIsTerminatingSession(terminatingTabIdsRef.current.size > 0);
    }
    doCloseTab(tabId);
    // Drop it from the last-fetched server list in the same tick as the tab
    // removal above, rather than waiting for the next fetchServerSessions()
    // (triggered by tabs changing, further down) to catch up -- otherwise a
    // render in between shows it under "unopened" (see the comment on
    // serverSessions' declaration above).
    setServerSessions((prev) => prev.filter((session) => session.id !== sessionId));
    return true;
  }, [tabs, doCloseTab]);

  const handleCloseTab = useCallback(async (tabId) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab && tab.type === 'terminal' && !tab.exited) {
      if (skipCloseConfirm) {
        if (canTerminateTab(tab)) terminateSessionById(tabId);
        else doCloseTab(tabId);
        return;
      }
      setDontAskAgain(false);
      setCloseConfirm({ tabId, kind: 'terminal' });
      return;
    }
    doCloseTab(tabId);
  }, [tabs, skipCloseConfirm, doCloseTab, terminateSessionById]);

  const confirmCloseTab = useCallback(async () => {
    if (!closeConfirm) return;
    if (dontAskAgain) {
      setSkipCloseConfirmPersisted(true);
    }
    doCloseTab(closeConfirm.tabId);
    setCloseConfirm(null);
  }, [closeConfirm, dontAskAgain, doCloseTab, setSkipCloseConfirmPersisted]);

  const handleTabClick = useCallback((tabId) => {
    setActiveTabId(tabId);
  }, []);

  const handleTabExited = useCallback((tabId, exited) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, exited } : t
    ));
  }, []);

  const handleTabSessionId = useCallback((tabId, sessionId) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, sessionId } : t
    ));
  }, []);

  // The sandbox flag the session actually launched with, reported by the
  // server once the session exists (issue #251). openTerminalTab seeds the
  // tab with what this client REQUESTED, which is only a guess: the server
  // forces a sandbox whenever forceSandbox or browseRoots mandates one. Until
  // this landed, the tab and the terminal header kept showing the guess while
  // the session list showed the server's value -- the same session displayed
  // two different answers.
  const handleTabSandboxResolved = useCallback((tabId, sandbox) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId && t.sandbox !== sandbox ? { ...t, sandbox } : t
    ));
  }, []);

  // Session list: terminal tabs are listed vertically in the left sidebar,
  // while browser/settings tabs stay horizontal. The sidebar behaves like
  // the right widgets panel (open/overlay are separate flags).
  const sessionSidebarPrefs = useSessionSidebarPrefs();
  const sessionSidebarOpen = sessionSidebarPrefs.open;
  const sessionsRefreshingRef = useRef(false);
  const sessionsRefreshQueuedRef = useRef(false);
  const fetchServerSessions = useCallback(async () => {
    if (sessionsRefreshingRef.current) { sessionsRefreshQueuedRef.current = true; return; }
    sessionsRefreshingRef.current = true;
    try {
      const res = await authFetch('/api/sessions');
      if (!res.ok) return;
      const data = await res.json();
      setServerSessions(data.sessions || []);
    } catch {
      // supplementary panel: keep the last-known list on failure
    } finally {
      sessionsRefreshingRef.current = false;
      if (sessionsRefreshQueuedRef.current) {
        sessionsRefreshQueuedRef.current = false;
        fetchServerSessions();
      }
    }
  }, []);
  // tabs全体ではなくセッション構成に影響する安定キーのみ監視する
  // (手番ポーリング等の無関係なsetTabsで/api/sessionsを叩かない)。
  const sessionTabsKey = tabs.map((t) => `${t.id}:${t.sessionId || ''}:${t.attachSessionId || ''}`).join(',');
  // パネル開表示の間、一覧を更新する。タブ構成変化時も下段 (稼働中) との
  // 付け替えを反映する。
  const sessionPanelOpen = sessionSidebarOpen;
  useEffect(() => {
    if (sessionPanelOpen) {
      fetchServerSessions();
    }
    // closing a tab moves its server-side session from the upper section
    // to the lower one while the panel stays open, so the list must refresh
    // on tab changes too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPanelOpen, fetchServerSessions, sessionTabsKey]);
  // The events above are enough to keep membership right, but not the
  // per-session activity level (SessionList's dots), which changes on its own
  // as the agents work. Poll while the panel is actually on screen; the hook
  // skips ticks for a backgrounded browser tab and stops entirely when the
  // panel is closed.
  useVisiblePolling(fetchServerSessions, 3000, sessionPanelOpen);
  // サイドバー表示中に開く操作をした際、重ね表示のときだけ閉じる。
  // in-flow表示はCLIをリサイズ済みのため開いたままにする。重ね表示とは
  // 設定ONのデスクトップオーバーレイと、狭幅ドロワー (NARROW_DRAWER_QUERY・
  // 常時前面) の両方を指す。狭幅判定はクリック時に都度行う (リサイズ対応の
  // ため購読はしない)。
  const closeSessionSidebarIfOverlay = useCallback(() => {
    if (sessionSidebarPrefs.overlay) {
      sessionSidebarPrefs.setOpen(false);
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia?.(NARROW_DRAWER_QUERY).matches) {
      sessionSidebarPrefs.setOpen(false);
    }
  }, [sessionSidebarPrefs.overlay, sessionSidebarPrefs.setOpen]);
  // 選択で閉じるのは重ね表示のときだけ。in-flow表示では常時表示のため
  // 閉じない (ターミナルタブとグループタブ共通)。
  const handleSelectSessionTab = useCallback((tabId) => {
    setActiveTabId(tabId);
    closeSessionSidebarIfOverlay();
  }, [closeSessionSidebarIfOverlay]);
  const handleCloseSessionTab = useCallback((tabId) => {
    handleCloseTab(tabId);
  }, [handleCloseTab]);
  const handleOpenUnopenedSession = useCallback((session) => {
    closeSessionSidebarIfOverlay();
    handleSessionClick(session);
  }, [handleSessionClick, closeSessionSidebarIfOverlay]);
  // Lower section's X: terminate the server-side session (tab close keeps
  // the session alive, so this is the only destructive action here).
  const terminatingUnopenedRef = useRef(new Set());
  const terminateUnopened = useCallback(async ({ session }) => {
    if (terminatingUnopenedRef.current.has(session.id)) return false;
    terminatingUnopenedRef.current.add(session.id);
    setIsTerminatingSession(true);
    try {
      const res = await authFetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
      if (res.status !== 404 && !res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`セッションを終了できませんでした: ${err.message}`);
      return false;
    } finally {
      terminatingUnopenedRef.current.delete(session.id);
      setIsTerminatingSession(terminatingTabIdsRef.current.size > 0 || terminatingUnopenedRef.current.size > 0);
    }
    setServerSessions((prev) => prev.filter((item) => item.id !== session.id));
    fetchServerSessions();
    return true;
  }, [fetchServerSessions]);
  const requestTerminateUnopened = useCallback((target) => {
    if (skipCloseConfirm) {
      terminateUnopened(target);
      return;
    }
    setDontAskAgain(false);
    setCloseConfirm({ kind: 'unopened', target });
  }, [skipCloseConfirm, terminateUnopened]);
  const handleTerminateUnopenedSession = useCallback((session) => {
    requestTerminateUnopened({ session });
  }, [requestTerminateUnopened]);

  // Close-confirm dialog's "セッションを終了": delegates the DELETE + tab
  // close to terminateSessionById above, shown only for terminal tabs with a
  // known session id. For kind 'unopened' (lower-section ✕) there is no tab:
  // it delegates to terminateUnopened.
  // "次回以降確認しない" is persisted only after a successful termination
  // (terminateSessionById's return value): on failure the session is still
  // alive and the dialog stays open so the user can see the alert and retry
  // or cancel, rather than silently persisting a skip past a failure.
  const terminateSessionAndCloseTab = useCallback(async () => {
    if (!closeConfirm) return;
    const ok = closeConfirm.kind === 'unopened'
      ? await terminateUnopened(closeConfirm.target)
      : await terminateSessionById(closeConfirm.tabId);
    if (!ok) return;
    if (dontAskAgain) {
      setSkipCloseConfirmPersisted(true);
    }
    setCloseConfirm(null);
  }, [closeConfirm, dontAskAgain, setSkipCloseConfirmPersisted, terminateSessionById, terminateUnopened]);

  // セッション表示名 (右クリック改名): サーバー保存の customLabel を
  // sessionId で引くマップ。一覧の上段・ターミナルヘッダーで使う。
  // 下段 (未オープン) は serverSessions 要素の customLabel を直接使う。
  const labelBySessionId = new Map();
  for (const s of serverSessions) {
    if (s.customLabel) labelBySessionId.set(s.id, s.customLabel);
  }
  const resolveTabLabel = (tab) => {
    const sid = tab.sessionId || tab.attachSessionId;
    return (sid && labelBySessionId.get(sid)) || null;
  };
  // 右クリックメニューと改名ダイアログの表示状態。contextMenu: { x, y, id,
  // currentLabel }、renameTarget: { id, currentLabel }。
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const handleRowContextMenu = useCallback((e, target) => {
    setContextMenu({ x: e.clientX, y: e.clientY, id: target.id, currentLabel: target.currentLabel });
  }, []);
  const handleRenameSession = useCallback(async (id, name) => {
    try {
      const res = await authFetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customLabel: name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`セッション名を設定できませんでした: ${err.message}`);
    }
    setRenameTarget(null);
    fetchServerSessions();
  }, [fetchServerSessions]);
  const handleClearSessionLabel = useCallback((id) => {
    setContextMenu(null);
    handleRenameSession(id, null);
  }, [handleRenameSession]);
  const handleOpenRenameDialog = useCallback(() => {
    if (!contextMenu) return;
    setRenameTarget({ id: contextMenu.id, currentLabel: contextMenu.currentLabel });
    setContextMenu(null);
  }, [contextMenu]);

  const sessionTabs = tabs.filter((t) => t.type === 'terminal');
  // commitSigningActive comes from the server (GET /api/sessions, via
  // listSessions()), not from this tab's own launch-time sandboxOpts prop --
  // a tab attached to a session started elsewhere (another device/tab)
  // wouldn't otherwise know it. Only used by SessionList.jsx's badge
  // (commitSigningBadge.js); TerminalView.jsx gets its own copy live over the WS
  // `session` message instead, so its open header badge doesn't depend on
  // serverSessions' event-driven (not continuously polled) refresh cadence.
  const serverSessionsById = new Map(serverSessions.map((s) => [s.id, s]));
  const sessionTabsForList = sessionTabs.map((t) => {
    const sid = t.sessionId || t.attachSessionId || null;
    const srv = sid ? serverSessionsById.get(sid) : null;
    // sandboxBackend: the server's effective backend ('bwrap' | 'qemu'); until
    // the session list arrives, fall back to what this tab asked for.
    const requestedBackend = t.sandboxOpts?.backend === 'qemu' || t.sandboxOpts?.vmShellId ? 'qemu' : null;
    return { ...t, commitSigningActive: srv?.commitSigningActive ?? false, activity: srv?.activity ?? null, sandboxBackend: srv?.sandboxBackend ?? requestedBackend };
  });
  const openedTabCount = sessionTabs.length;
  const barTabs = tabs.filter((t) => t.type === 'browser' || t.type === 'settings');
  const openedSessionIds = new Set();
  for (const t of tabs) {
    if (t.sessionId) openedSessionIds.add(t.sessionId);
    if (t.attachSessionId) openedSessionIds.add(t.attachSessionId);
  }
  const unopenedSessions = serverSessions.filter((s) => !openedSessionIds.has(s.id));
  const activeTab = tabs.find((t) => t.id === activeTabId);
  // Close-confirm dialog's "セッションを終了" availability: terminal tabs with
  // a known server-side session id, plus every
  // kind 'unopened' target (the lower-section ✕).
  const closeConfirmTab = closeConfirm ? tabs.find((t) => t.id === closeConfirm.tabId) : null;
  const canTerminateCloseConfirm = closeConfirm?.kind === 'unopened' || canTerminateTab(closeConfirmTab);
  const closeConfirmTargetText = closeConfirm?.kind === 'unopened'
    ? (closeConfirm.target.session.cwd || closeConfirm.target.session.id)
    : null;
  // Usage covers claude (Claude Code's /usage), codex (Codex's rate-limit
  // read) and opencode Go (the zen/go quota API); the UsageWidget (right
  // sidebar) itself has tabs to switch between them, so it is no longer tied
  // to whichever app the active terminal tab happens to be running -- it
  // stays visible on opencode terminals too, as long as at least one
  // source is usable. It's fully hidden via sandbox.config.json's
  // "showUsage": false, or when hiddenApps hides every usable source.
  // When no CLI is installed AND no Go key exists, the frame stays with a
  // friendly empty message instead (emptyReason 'no-cli', see below).
  // `availableApps` null/absent (fetch pending or failed, older server)
  // means "unknown" -- every tab is assumed available in that case (unless
  // hidden via hiddenApps). Note `opencodeGo` is not the opencode CLI
  // install flag: it means toggle on + Go API key present. Unlike
  // claude/codex (whose keys predate this feature), a PRESENT object
  // without the opencodeGo key is an older server, so Go stays hidden
  // there (see appAvailability.js's isAppVisible, shared with UsageWidget).
  // hiddenApps 'opencode' hides the Go tab as well (issue #105).
  const availableApps = usagePrefs.availableApps;
  const claudeAvailable = isAppSelectable('claude', availableApps, usagePrefs.hiddenApps);
  const codexAvailable = isAppSelectable('codex', availableApps, usagePrefs.hiddenApps);
  const opencodeGoAvailable = isAppVisible('opencode', availableApps, usagePrefs.hiddenApps);
  // `hidden`: 設定で無効化された場合は従来通りウィジェットごと除外する。
  // `emptyReason: 'no-cli'`: CLI未インストール (+Goキーなし) で表示ソースが
  // 無い場合は枠を残して親切メッセージを出す。hiddenAppsで「あるのに隠した」
  // 場合は設定尊重で除外側に倒す (誤った「未インストール」表示を避ける)。
  // availableApps==null (取得前/失敗/旧サーバ) は不明扱いで従来通り可視。
  const claudeInstalled = !availableApps || availableApps.claude !== false;
  const codexInstalled = !availableApps || availableApps.codex !== false;
  const goReady = !availableApps ? true : availableApps.opencodeGo === true;
  const nothingUsable = !claudeAvailable && !codexAvailable && !opencodeGoAvailable;
  const noCliInstalled = !!availableApps && !claudeInstalled && !codexInstalled && !goReady;
  const usageEmptyNoCli = usagePrefs.showUsage && !!availableApps && nothingUsable && noCliInstalled;
  // `!!availableApps` はここでは付けない: availableApps===null (不明) の場合、
  // nothingUsable が true になるのは hiddenApps で全滅させた場合のみ
  // (isAppSelectable/isAppVisible は availableApps が無ければ常にavailable側に
  // 倒すため)。つまり null でも nothingUsable なら「設定で意図的に隠した」
  // ケースであり、旧計算式(`!showUsage || nothingUsable`)通りウィジェットごと
  // 隠すのが正しい。ここに `!!availableApps` を付けると、その場合だけ
  // Usageウィジェットが表示されたままになってしまう。
  const usageHidden = !usagePrefs.showUsage || (nothingUsable && !usageEmptyNoCli);
  // First-run seed only: UsageWidget remembers the app the user last picked
  // (localStorage), so this active-tab-derived default is used just when
  // nothing has been saved yet. The active tab's app wins when that source
  // is actually usable, else claude, else whichever of codex/Go is usable.
  const activeTabApp = activeTab?.app;
  const usageDefaultApp = (activeTabApp === 'codex' && codexAvailable) ? 'codex'
    : (activeTabApp === 'opencode' && opencodeGoAvailable) ? 'opencode'
    : (claudeAvailable ? 'claude' : (codexAvailable ? 'codex' : (opencodeGoAvailable ? 'opencode' : 'claude')));
  const sidebarPrefs = useWidgetPrefs(WIDGET_DEFS);
  const monitorWidgetsVisible = sidebarPrefs.open
    && sidebarPrefs.visibleWidgets.some((w) => MONITOR_WIDGET_IDS.includes(w.id));
  const statsActive = monitorWidgetsVisible;
  const usageWidgetProps = { hidden: usageHidden, emptyReason: usageEmptyNoCli ? 'no-cli' : null, defaultApp: usageDefaultApp, availableApps, hiddenApps: usagePrefs.hiddenApps };

  return (
    <CommitSigningStatusProvider>
    <div className="app">
      {/* Pending destructive-operation approval requests: global banner above
          the tab bar so it is visible no matter which tab is active. */}
      <ApprovalBanner />
      <div className="tab-bar">
        <button
          type="button"
          className="btn session-menu-btn"
          onClick={() => sessionSidebarPrefs.setOpen(!sessionSidebarOpen)}
          title={openedTabCount > 0 ? `セッション (${openedTabCount})` : 'セッション'}
          aria-label={sessionSidebarOpen ? 'セッションサイドバーを閉じる' : 'セッションサイドバーを開く'}
          aria-expanded={sessionSidebarOpen}
        >
          {sessionMenuIcon}
          {openedTabCount > 0 && (
            <span className="session-menu-count" aria-hidden="true">{openedTabCount}</span>
          )}
        </button>
        <div className="tab-list">
        {barTabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item${tab.id === activeTabId ? ' active' : ''}`}
            title={tab.label}
            aria-label={tab.label}
            onClick={() => handleTabClick(tab.id)}
          >
            <span className="tab-label">
              <TabIcon type={tab.type} app={tab.app} shell={tab.shell} ui={tab.ui} />
            </span>
            {tab.type !== 'browser' && tab.type !== 'settings' && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
                title="Close"
              >
                &#10005;
              </button>
            )}
          </div>
        ))}
        <div className="tab-bar-spacer" />
        </div>
        <CommitSigningUnlockButton />
        <button
          type="button"
          className="btn sidebar-toggle-btn"
          onClick={() => sidebarPrefs.setOpen(!sidebarPrefs.open)}
          title={sidebarPrefs.open ? 'Widgetsパネルを閉じる' : 'Widgetsパネルを開く'}
          aria-label={sidebarPrefs.open ? 'Widgetsパネルを閉じる' : 'Widgetsパネルを開く'}
          aria-expanded={sidebarPrefs.open}
        >
          <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M10 2.5v11" />
            {sidebarPrefs.open && <rect x="10" y="2.5" width="4.5" height="11" fill="currentColor" stroke="none" />}
          </svg>
        </button>
      </div>
      <SystemStatsProvider active={statsActive}>
      <div className={`main-row${sidebarPrefs.open ? ' sidebar-open' : ''}${sidebarPrefs.overlay ? ' sidebar-overlay' : ''}${sessionSidebarOpen ? ' session-open' : ''}${sessionSidebarPrefs.overlay ? ' session-overlay' : ''}`}>
      {sessionSidebarOpen && (
        <button
          type="button"
          className="session-backdrop"
          aria-label="セッションサイドバーを閉じる"
          tabIndex={-1}
          onClick={() => sessionSidebarPrefs.setOpen(false)}
        />
      )}
      <SessionSidebar
        open={sessionSidebarOpen}
        overlay={sessionSidebarPrefs.overlay}
        onOverlayChange={sessionSidebarPrefs.setOverlay}
        sessionTabs={sessionTabsForList}
        activeTabId={activeTabId}
        unopenedSessions={unopenedSessions}
        onSelectTab={handleSelectSessionTab}
        onCloseTab={handleCloseSessionTab}
        onOpenSession={handleOpenUnopenedSession}
        onTerminateSession={handleTerminateUnopenedSession}
        customLabels={labelBySessionId}
        onRowContextMenu={handleRowContextMenu}
      />
      <div className="tab-content">
        <div style={{ display: activeTabId === 'browser' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <DirectoryBrowser onOpen={handleOpen} onOpenShell={handleOpenShell} initialPath={lastDir} sandboxDefaults={sandboxDefaults} />
        </div>
        {tabs.some((t) => t.type === 'settings') && (
          <div style={{ display: activeTabId === 'settings' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
            <SettingsView
              themeId={themeId}
              onThemeChange={setThemeId}
              confirmBeforeClose={!skipCloseConfirm}
              onConfirmBeforeCloseChange={(v) => setSkipCloseConfirmPersisted(!v)}
              sandboxDefaults={sandboxDefaults}
              onSandboxDefaultsChange={setSandboxDefaultsPersisted}
              toolsAvailable={usagePrefs.toolsAvailable}
              navGuardMode={navGuardMode}
              onNavGuardModeChange={setNavGuardModePersisted}
              notifyEnabled={notifyEnabled}
              notifyPermission={notifyPermission}
              onToggleNotify={toggleNotify}
              onOpenVmTerminal={handleOpenVmTerminal}
            />
          </div>
        )}
        {tabs
          .filter((t) => t.type === 'terminal')
          .map((tab) => (
            <div
              key={tab.id}
              style={{ display: activeTabId === tab.id ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}
            >
              <Suspense fallback={null}>
                {tab.ui === 'chat' ? (
                  <ChatView
                    app={tab.app}
                    cwd={tab.cwd}
                    sandbox={tab.sandbox}
                    sandboxOpts={tab.sandboxOpts}
                    reuseSandboxHome={tab.reuseSandboxHome !== false}
                    model={tab.model || null}
                    resume={!!tab.resume}
                    customLabel={resolveTabLabel(tab)}
                    notify={notify}
                    notifyEnabled={notifyEnabled}
                    notifyPermission={notifyPermission}
                    onToggleNotify={toggleNotify}
                    visible={activeTabId === tab.id}
                    onSessionId={(sid) => handleTabSessionId(tab.id, sid)}
                    onSandboxResolved={(sb) => handleTabSandboxResolved(tab.id, sb)}
                    onExited={(exited) => handleTabExited(tab.id, exited)}
                    attachSessionId={tab.attachSessionId}
                    onFocusTab={() => handleTabClick(tab.id)}
                  />
                ) : (
                <TerminalView
                  cwd={tab.cwd}
                  onClose={() => handleCloseTab(tab.id)}
                  claudeSessionId={tab.claudeSessionId}
                  shell={tab.shell}
                  sandbox={tab.sandbox}
                  sandboxOpts={tab.sandboxOpts}
                  reuseSandboxHome={tab.reuseSandboxHome !== false}
                  app={tab.app || 'claude'}
                  model={tab.model || null}
                  resume={!!tab.resume}
                  customLabel={resolveTabLabel(tab)}
                  notify={notify}
                  notifyEnabled={notifyEnabled}
                  notifyPermission={notifyPermission}
                  onToggleNotify={toggleNotify}
                  visible={activeTabId === tab.id}
                  onSessionId={(sid) => handleTabSessionId(tab.id, sid)}
                  onSandboxResolved={(sb) => handleTabSandboxResolved(tab.id, sb)}
                  onExited={(exited) => handleTabExited(tab.id, exited)}
                  attachSessionId={tab.attachSessionId}
                  xtermTheme={getTheme(themeId).xterm}
                  tabId={tab.id}
                  onFocusTab={() => handleTabClick(tab.id)}
                />
                )}
              </Suspense>
            </div>
          ))}
      </div>
      {sidebarPrefs.open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="サイドバーを閉じる"
          tabIndex={-1}
          onClick={() => sidebarPrefs.setOpen(false)}
        />
      )}
      <RightSidebar usageProps={usageWidgetProps} prefs={sidebarPrefs} />
      </div>
      </SystemStatsProvider>
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasCustomLabel={!!contextMenu.currentLabel}
          onRename={handleOpenRenameDialog}
          onClear={() => handleClearSessionLabel(contextMenu.id)}
          onClose={closeContextMenu}
        />
      )}
      {renameTarget && (
        <SessionRenameDialog
          initialName={renameTarget.currentLabel}
          onSubmit={(name) => handleRenameSession(renameTarget.id, name)}
          onClose={() => setRenameTarget(null)}
        />
      )}
      {duplicateSessionPrompt && (
        <div className="resume-overlay" onClick={cancelDuplicateSessionPrompt}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>同じディレクトリで既にセッションが起動しています</h3>
            <p className="resume-session-id">{duplicateSessionPrompt.cwd}</p>
            <p>既存のセッションを開くか、そのまま新しいセッションを起動するか選んでください。</p>
            <div className="resume-actions">
              <button className="btn btn-primary" onClick={handleOpenExistingDuplicate}>
                既存セッションを開く
              </button>
              <button className="btn btn-secondary" onClick={handleForceNewDuplicate}>
                そのまま新規起動する
              </button>
              <button className="btn btn-secondary" onClick={cancelDuplicateSessionPrompt}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
      {sandboxPrompt && (
        <div className="resume-overlay" onClick={cancelSandboxPrompt}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>前回利用したサンドボックスがあります</h3>
            <p>
              このプロジェクトの前回のサンドボックス環境（インストール済みのツール・キャッシュ等）を引き継ぎますか？
            </p>
            <p className="sandbox-prompt-warn">
              「新規作成」は前回の環境を破棄して空の状態から始めます。
              {sandboxPrompt.inUse > 0
                ? '（このプロジェクトのサンドボックスを利用中のセッションがあるため選択できません）'
                : ''}
            </p>
            <div className="resume-actions">
              <button className="btn btn-primary" onClick={handleSandboxReuse}>
                使用する
              </button>
              <button
                className="btn btn-secondary"
                disabled={sandboxPrompt.inUse > 0}
                onClick={handleSandboxNew}
              >
                新規作成
              </button>
              <button className="btn btn-secondary" onClick={cancelSandboxPrompt}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
      {vmRunningPrompt && (
        <div className="resume-overlay" onClick={cancelVmRunningPrompt}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>起動中のVMがあります</h3>
            <p>
              他にVMが起動しています。さらにVMを起動するとメモリ等のリソースを消費します。そのまま起動しますか？
            </p>
            <ul className="vm-running-list">
              {vmRunningPrompt.runningVms.map((vm) => (
                <li key={`${vm.kind}:${vm.id}`}>
                  VM {vm.templateName || '既定設定'}
                  {vm.kind === 'pool'
                    ? `（常駐・${vm.idle ? 'アイドル中' : `${vm.sessionCount}セッション`}）`
                    : `（${vm.cwd}）`}
                </li>
              ))}
            </ul>
            <div className="resume-actions">
              <button className="btn btn-primary" onClick={handleVmRunningContinue}>
                そのまま起動する
              </button>
              <button className="btn btn-secondary" onClick={cancelVmRunningPrompt}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
      {closeConfirm && (
        <div className="resume-overlay" onClick={() => { if (!isTerminatingSession) setCloseConfirm(null); }}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{closeConfirm.kind === 'unopened' ? 'セッションを終了しますか?' : 'タブを閉じますか?'}</h3>
            <p>{canTerminateCloseConfirm
                ? 'セッションを終了します。終了後は再接続できません。'
                : 'セッションは背後で動き続け、セッション一覧から再接続できます。'}</p>
            {closeConfirmTargetText && <p className="close-confirm-target" title={closeConfirmTargetText}>{closeConfirmTargetText}</p>}
            <label className="close-confirm-checkbox">
              <input
                type="checkbox"
                checked={dontAskAgain}
                disabled={isTerminatingSession}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              次回以降確認しない
            </label>
            <div className="resume-actions">
              {canTerminateCloseConfirm ? (
                <button className="btn btn-danger btn-left" onClick={terminateSessionAndCloseTab} disabled={isTerminatingSession}>
                  {isTerminatingSession
                    ? '終了中...'
                    : 'セッションを終了'}
                </button>
              ) : null}
              <button className="btn btn-secondary" onClick={() => setCloseConfirm(null)} disabled={isTerminatingSession}>
                キャンセル
              </button>
              {!canTerminateCloseConfirm && (
                <button className="btn btn-primary" onClick={confirmCloseTab} disabled={isTerminatingSession}>
                  閉じる
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </CommitSigningStatusProvider>
  );
}
