import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { authFetch, getToken, resolveAuthMode } from '../auth.js';
import { displayPath } from '../displayPath.js';
import { formatSize } from '../formatSize.js';
import { isPreviewable } from '../previewExts.js';
import { isAppSelectable } from '../appAvailability.js';
import { loadSandboxDefaults, defaultSandboxOpts } from '../sandboxDefaults.js';

// marked + DOMPurify only matter once someone opens a preview, so keep them
// out of the initial bundle (same split as TerminalView in App.jsx).
const FilePreview = lazy(() => import('./FilePreview.jsx'));

const LAST_DIR_KEY = 'ccserver-last-dir';
const SANDBOX_KEY = 'ccserver-sandbox-default';
const SANDBOX_OPTS_PREFIX = 'ccserver-sandbox-opts:';
const APP_KEY = 'ccserver-app-default';
// opencode only: render it as a terminal (TUI) or as a chat (opencode >= 2).
const OPENCODE_UI_KEY = 'ccserver-opencode-ui';
// Every launchable app id, in the order pickers list them.
const ALL_APPS = ['claude', 'opencode', 'codex'];
// copy for the opt-in tool toggles the server host cannot
// provision (/api/dirs/home's toolsAvailable). See issue #22.
const TOOL_UNAVAILABLE_NOTE = 'この ccserver ホストでは非対応です';

// Force any tool the server host cannot provision to false, so a selection
// remembered from a Linux host never rides along in a launch payload the
// server would silently drop. `avail` is /api/dirs/home's toolsAvailable
// ({ rtk, codeReviewGraph }) or null (older server / not fetched -> untouched).
// `backend` is the backend this launch will use ('bwrap' | 'qemu' | null):
// the VM supports neither the tools nor the legacy host-gpg forwarding, so a
// VM launch carries them as off.
function sanitizeSandboxOpts(opts, avail, backend = null) {
  if (!opts) return opts;
  const next = { ...(opts.tools || {}) };
  if (avail?.rtk === false || backend === 'qemu') next.rtk = false;
  if (avail?.codeReviewGraph === false || backend === 'qemu') next.codeReviewGraph = false;
  return { ...opts, gpg: backend === 'qemu' ? false : opts.gpg, tools: next };
}

// The backend a launch with these opts uses: its own pick, else the
// server's default (/api/dirs/home's sandboxBackends.default).
function launchBackend(opts, backends) {
  return opts?.backend || backends?.default || null;
}

const VM_UNSUPPORTED_NOTE = 'VMでは使えません';
// sandbox-unavailable warning copy shared by the sandbox picker note and the
// browser header banner, so the two can't drift apart (see PR#135 review).
// The short title variant is used for disabled launch-button tooltips.
const SANDBOX_UNAVAILABLE_NOTE = 'このサーバーではサンドボックス機能が利用できません。通常起動をご利用ください。';
const FORCE_SANDBOX_UNAVAILABLE_NOTE = 'サーバー設定 (forceSandbox) でサンドボックスが強制されていますが、このホストではサンドボックス機能を利用できません。サンドボックス基盤をインストールするか、サーバー設定を見直してください。';
// browseRoots is the other cause of a forced sandbox -- /api/dirs/home's
// forceSandboxReason says which one is in effect (issue #251).
const BROWSE_ROOTS_SANDBOX_NOTE = 'サーバー設定 (browseRoots) により、セッションはサンドボックスで起動されます。通常起動はできません。';
const BROWSE_ROOTS_SANDBOX_UNAVAILABLE_NOTE = 'サーバー設定 (browseRoots) でサンドボックスが必須ですが、このホストではサンドボックス機能を利用できません。サンドボックス基盤をインストールするか、サーバー設定を見直してください。';
const LAUNCHES_BLOCKED_TITLE = 'サーバー設定でサンドボックスが強制されていますが、このホストではサンドボックス機能を利用できません';
// Same picker set + labels as single mode, so the two can't drift apart.
const APP_LABELS = { claude: 'Claude Code', opencode: 'opencode', codex: 'OpenAI Codex' };

// Per-directory opt-in sandbox flags (gpg / sshAgent / tools), remembered
// separately per cwd rather than as one server-wide default -- see
// server/sandbox.config.json's `gpg`/`sshAgent`/`tools` for the fallback these
// override at launch. `tools` (rtk / code-review-graph) provisions the tool
// into the sandbox HOME at launch instead of installing it on the host.
// 記憶が無い場合の初期値は Settings > 一般のグローバル既定値
// (client/src/sandboxDefaults.js) を使う。gpg/sshAgent は既定オフ。
// tools (rtk / code-review-graph) もキー不在時はグローバル既定値に
// フォールバックする (旧形式の記憶には tools が無いため); a stored
// explicit false turns them back off for that directory.
export function hasSandboxOptsMemory(path) {
  try {
    return localStorage.getItem(SANDBOX_OPTS_PREFIX + path) !== null;
  } catch { /* ignore */ }
  return false;
}

function loadSandboxOpts(path, globalDefaults) {
  try {
    const raw = localStorage.getItem(SANDBOX_OPTS_PREFIX + path);
    if (raw) {
      const parsed = JSON.parse(raw);
      // 旧形式の記憶 ({gpg, sshAgent} のみ) では tools キーが不在。
      // 不在 = 未選択なので一律 true にせずグローバル既定値にフォールバックする
      // (明示保存された true/false は引き続き尊重される)。
      const fallbackTools = defaultSandboxOpts(globalDefaults || loadSandboxDefaults()).tools;
      return {
        gpg: !!parsed.gpg,
        sshAgent: !!parsed.sshAgent,
        gpgVault: !!parsed.gpgVault,
        tools: {
          rtk: parsed.tools?.rtk ?? fallbackTools.rtk,
          codeReviewGraph: parsed.tools?.codeReviewGraph ?? fallbackTools.codeReviewGraph,
        },
        vmTemplateId: typeof parsed.vmTemplateId === 'string' ? parsed.vmTemplateId : null,
        backend: parsed.backend === 'bwrap' || parsed.backend === 'qemu' ? parsed.backend : null,
      };
    }
  } catch { /* ignore */ }
  return defaultSandboxOpts(globalDefaults || loadSandboxDefaults());
}

function saveSandboxOpts(path, opts) {
  try {
    localStorage.setItem(SANDBOX_OPTS_PREFIX + path, JSON.stringify(opts));
  } catch { /* ignore */ }
}

export default function DirectoryBrowser({ onOpen, onOpenShell, initialPath, sandboxDefaults }) {
  const [currentPath, setCurrentPath] = useState(initialPath || localStorage.getItem(LAST_DIR_KEY) || '/');
  const [homeDir, setHomeDir] = useState(null);
  // browseRoots (issue #189): the server's guaranteed-browsable start (the
  // first allowed root when home() itself is outside them, home() otherwise).
  // Used for the Home button and to recover when a remembered/restored path
  // falls outside a newly-narrowed browseRoots (403 on fetch).
  const [initialBrowsePath, setInitialBrowsePath] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [parentPath, setParentPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  // git init opt-in for folder creation (off by default, like the other
  // launch flags): avoids surprising nested repositories under existing ones.
  const [initGit, setInitGit] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const fileInputRef = useRef(null);
  const dragCountRef = useRef(0);
  const [sandboxDefault, setSandboxDefault] = useState(() => localStorage.getItem(SANDBOX_KEY) === '1');
  // The server's EFFECTIVE "every session must be sandboxed" flag, straight
  // off /api/dirs/home. It is the same field createSession enforces on, so
  // the menu and the server cannot disagree -- they did, and that was issue
  // #251: this used to be the operator's literal "forceSandbox" value, which
  // missed the browseRoots case, so the menu offered 通常起動 for a launch
  // the server then sandboxed anyway.
  //
  // Nothing here re-derives the rule; the server decides it in one place
  // (loadSandboxConfig) and this reads the answer.
  const [forceSandbox, setForceSandbox] = useState(false);
  // 'config' | 'browseRoots' | null -- WORDING ONLY, never a policy branch.
  const [forceSandboxReason, setForceSandboxReason] = useState(null);
  // Whether a sandbox backend exists on the server host (/api/dirs/home's
  // sandboxAvailable). false disables the sandbox choice. null until the fetch resolves;
  // while null everything stays enabled (old-server fallback, same as
  // availableApps).
  const [sandboxAvailable, setSandboxAvailable] = useState(null);
  // /api/dirs/home's sandboxBackends ({ default, bwrap: { ok, reason },
  // qemu: { ok, reason, hint } }): the backend picker (sandboxOpts.backend).
  // The VM template picker (sandboxOpts.vmTemplateId) shows when the launch
  // will run in the VM, with the templates from /api/vm-templates.
  // null = older server: no picker, the server default applies.
  const [sandboxBackends, setSandboxBackends] = useState(null);
  const [vmTemplates, setVmTemplates] = useState([]);
  // gpgVault (plan: gpg-agent-vault) is a passkey-login-only feature -- this
  // component has no other reason to know authMode, so it resolves it
  // locally rather than threading a new prop through App.jsx, same
  // independent-resolution pattern GeneralSection.jsx/PasskeysSection.jsx
  // already use. null until resolved (checkbox stays enabled meanwhile,
  // same old-server-fallback posture as availableApps/sandboxAvailable).
  const [authMode, setAuthMode] = useState(null);
  useEffect(() => {
    let cancelled = false;
    resolveAuthMode().then((m) => { if (!cancelled) setAuthMode(m); });
    return () => { cancelled = true; };
  }, []);
  // Which agent CLIs the server can actually launch ({ claude, opencode,
  // codex } booleans), from /api/dirs/home. null until
  // the fetch resolves; while null every picker entry stays enabled
  // (old-server fallback).
  const [availableApps, setAvailableApps] = useState(null);
  // Which opt-in tool toggles (rtk / code-review-graph) the server host can
  // actually provision, from /api/dirs/home. null until the fetch resolves -> both stay enabled
  // (old-server fallback). An unavailable tool renders its checkbox disabled
  // with an explanation, like availableApps for CLIs.
  const [toolsAvailable, setToolsAvailable] = useState(null);
  // Apps hidden via sandbox.config.json's "hiddenApps" (issue #105 -- CLIs the
  // operator hasn't contracted for): removed from every picker below
  // entirely, regardless of install status. From /api/dirs/home; empty until
  // the fetch resolves, so nothing is hidden by default (old-server fallback).
  const [hiddenApps, setHiddenApps] = useState([]);
  // 'claude' until the server's configured default (sandbox.config.json's
  // "defaultApp") arrives via /api/dirs/home, or the user picks explicitly.
  const [appDefault, setAppDefault] = useState(() => {
    const saved = localStorage.getItem(APP_KEY);
    return ['opencode', 'codex', 'claude'].includes(saved) ? saved : 'claude';
  });
  const [codexModel, setCodexModel] = useState(() => localStorage.getItem('ccserver-codex-model') || '');
  // --model 対応アプリの判定はここに集約（対応アプリ追加時はここだけ変える）。
  const modelForApp = (app) => {
    if (app === 'codex') return codexModel.trim() || null;
    return null;
  };
  const modelInputForApp = (app) => app === 'codex';
  // Chat mode needs opencode >= 2 on the server (/api/dirs/home's
  // opencodeChat; absent on an older server = unavailable).
  const [opencodeChatAvailable, setOpencodeChatAvailable] = useState(false);
  const [opencodeUi, setOpencodeUi] = useState(() => (localStorage.getItem(OPENCODE_UI_KEY) === 'chat' ? 'chat' : 'terminal'));
  const chooseOpencodeUi = useCallback((val) => {
    setOpencodeUi(val);
    try { localStorage.setItem(OPENCODE_UI_KEY, val); } catch { /* ignore */ }
  }, []);
  const uiForApp = (app) => (app === 'opencode' && opencodeChatAvailable && opencodeUi === 'chat' ? 'chat' : 'terminal');
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [sandboxOpts, setSandboxOpts] = useState(() => loadSandboxOpts(currentPath, sandboxDefaults));

  const closeOpenMenu = useCallback(() => setOpenMenuOpen(false), []);

  const chooseSandbox = useCallback((val) => {
    if (forceSandbox) return;
    if (val && sandboxAvailable === false) return;
    setSandboxDefault(val);
    localStorage.setItem(SANDBOX_KEY, val ? '1' : '0');
  }, [forceSandbox, sandboxAvailable]);

  const chooseApp = useCallback((val) => {
    if (hiddenApps.includes(val)) return;
    if (availableApps && !availableApps[val]) return;
    setAppDefault(val);
    localStorage.setItem(APP_KEY, val);
  }, [availableApps, hiddenApps]);

  // gpg/sshAgent/tools はディレクトリ別に記憶し、記憶が無い場合のみ
  // Settings > 一般のグローバル既定値を使う。ディレクトリ移動時と
  // グローバル既定値の変更時に再読込するが、記憶済みの場所は上書きしない。
  useEffect(() => {
    if (hasSandboxOptsMemory(currentPath)) {
      setSandboxOpts(loadSandboxOpts(currentPath, sandboxDefaults));
    } else {
      setSandboxOpts(defaultSandboxOpts(sandboxDefaults || loadSandboxDefaults()));
    }
  }, [currentPath, sandboxDefaults]);

  const updateSandboxOpts = useCallback((path, next) => {
    setSandboxOpts(next);
    saveSandboxOpts(path, next);
  }, []);

  // sandboxOpts with any host-unavailable tool forced off -- the shape every
  // launch payload uses, so a toggle remembered on a Linux host cannot ride
  // along on a macOS host where the server would drop it anyway.
  const effectiveSandboxOpts = useMemo(
    () => sanitizeSandboxOpts(sandboxOpts, toolsAvailable, launchBackend(sandboxOpts, sandboxBackends)),
    [sandboxOpts, toolsAvailable, sandboxBackends],
  );
  const backend = launchBackend(sandboxOpts, sandboxBackends);
  const inVm = backend === 'qemu';
  const toolDisabled = (id) => inVm || (toolsAvailable ? toolsAvailable[id] === false : false);
  const toolNote = inVm ? VM_UNSUPPORTED_NOTE : TOOL_UNAVAILABLE_NOTE;
  const qemuOk = !!sandboxBackends?.qemu?.ok;

  useEffect(() => {
    if (!qemuOk) return undefined;
    let cancelled = false;
    authFetch('/api/vm-templates').then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!cancelled && data && Array.isArray(data.templates)) setVmTemplates(data.templates);
    }).catch(() => { /* picker just shows the default */ });
    return () => { cancelled = true; };
  }, [qemuOk]);
  // A remembered template that has since been deleted stays selected (the
  // launch then fails with a clear error instead of silently booting
  // something else); the picker labels it so it can be changed.
  const vmTemplateMissing = !!sandboxOpts.vmTemplateId && !vmTemplates.some((t) => t.id === sandboxOpts.vmTemplateId);

  const fetchDirs = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ path });
      if (showHidden) params.set('showHidden', '1');
      const res = await authFetch(`/api/dirs?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      setCurrentPath(data.current);
      setParentPath(data.parent);
      setDirs(data.dirs);
      setFiles(data.files || []);
    } catch (err) {
      setError(err.message);
      // A remembered path (localStorage) or restored tab can fall outside a
      // newly-narrowed browseRoots: the listing 403s and the Up/Home buttons
      // alone cannot recover from it. Jump to the server's allowed start
      // once, rather than leaving the browser stuck on an empty error view.
      if (err.status === 403 && initialBrowsePath && path !== initialBrowsePath) {
        setCurrentPath(initialBrowsePath);
      }
    } finally {
      setLoading(false);
    }
  }, [showHidden, initialBrowsePath]);

  useEffect(() => {
    authFetch('/api/dirs/home').then(r => r.json()).then(data => {
      setHomeDir(data.home);
      if (data.initialBrowsePath) setInitialBrowsePath(data.initialBrowsePath);
      // Present-but-unusable browseRoots: the server refuses all directory
      // and file access (503) until it is fixed -- say so instead of
      // rendering an empty browser.
      if (data.browseRootsInvalid) {
        setError('sandbox.config.json の "browseRoots" が不正です (ディレクトリパスの配列で指定してください)。サーバー設定を修正するまでファイル閲覧は無効です。');
      }
      if (!initialPath && !localStorage.getItem(LAST_DIR_KEY)) {
        // browseRoots (issue #189): when set, home() itself may sit outside
        // the allowed roots -- start browsing at initialBrowsePath instead
        // (falls back to data.home on an older server that doesn't send it).
        setCurrentPath(data.initialBrowsePath || data.home);
      }
      // Seed the app picker from the server's configured default, but only
      // if the user hasn't explicitly picked one on this browser yet.
      if (!localStorage.getItem(APP_KEY) && ['opencode', 'codex', 'claude'].includes(data.defaultApp)) {
        setAppDefault(data.defaultApp);
      }
      // Server-enforced sandbox: force the toggle on and lock it.
      if (data.forceSandbox) {
        setForceSandbox(true);
        setSandboxDefault(true);
      }
      // Absent on a server older than this field: the note then just falls
      // back to the generic forceSandbox wording.
      setForceSandboxReason(data.forceSandboxReason || null);
      // No sandbox backend on the server host: the sandbox choice cannot
      // work. Correct a remembered sandbox default the same way stale app
      // defaults are corrected
      // below. Missing field = older server: leave everything enabled.
      if (data.sandboxBackends) setSandboxBackends(data.sandboxBackends);
      setOpencodeChatAvailable(data.opencodeChat === true);
      if (typeof data.sandboxAvailable === 'boolean') {
        setSandboxAvailable(data.sandboxAvailable);
        if (data.sandboxAvailable === false) {
          // forceSandbox keeps the toggle locked on (launches fail
          // server-side with the warning note); only correct the free
          // choice, otherwise the checkmark would sit on 通常起動 while
          // every launch is forced sandboxed.
          if (!data.forceSandbox) {
            setSandboxDefault(false);
            try { localStorage.setItem(SANDBOX_KEY, '0'); } catch { /* ignore */ }
          }
        }
      }
      // Apps hidden via sandbox.config.json's hiddenApps (issue #105): read
      // before the availability reconciliation below so a default that
      // points at a hidden (even if installed) app is also corrected.
      const hidden = Array.isArray(data.hiddenApps) ? data.hiddenApps : [];
      setHiddenApps(hidden);

      // Server-side install detection: grey out picker entries for CLIs that
      // don't exist here, and correct a stale default (localStorage
      // ccserver-app-default, or the server's defaultApp) that points at an
      // uninstalled OR hidden app -- the launch button label and modal
      // checkmark must never advertise an app that cannot start or cannot be
      // shown.
      if (data.availableApps) {
        setAvailableApps(data.availableApps);
        const isPickable = (a) => isAppSelectable(a, data.availableApps, hidden);
        const avail = ALL_APPS.filter(isPickable);
        // The server's defaultApp seeding above runs in the same effect tick,
        // so appDefault is still the stale pre-seeding value here -- evaluate
        // the effective default (server's when the browser hasn't chosen yet,
        // else the remembered one) before testing availability.
        const effectiveDefault = ALL_APPS.includes(data.defaultApp) && !localStorage.getItem(APP_KEY)
          ? data.defaultApp
          : appDefault;
        if (avail.length > 0 && !isPickable(effectiveDefault)) {
          setAppDefault(avail[0]);
        }
      }

      // Opt-in tools the server host cannot provision (rtk / code-review-graph
      // are unavailable on this host). The toggles
      // render disabled-with-an-explanation and effectiveSandboxOpts (below)
      // forces the flags false in every launch payload, so a remembered
      // per-directory selection from a Linux host can't smuggle one through.
      if (data.toolsAvailable && typeof data.toolsAvailable === 'object') {
        setToolsAvailable(data.toolsAvailable);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchDirs(currentPath);
  }, [currentPath, fetchDirs]);

  // Remembering the path is keyed on currentPath ONLY -- deliberately not on
  // fetchDirs. fetchDirs' identity changes when /api/dirs/home resolves
  // (initialBrowsePath), which re-runs the listing effect for the SAME path;
  // folding the write in there re-wrote the (unchanged) path after that
  // resolution and could clobber a concurrently-set value.
  useEffect(() => {
    localStorage.setItem(LAST_DIR_KEY, currentPath);
  }, [currentPath]);

  const navigateTo = useCallback((path) => {
    setCurrentPath(path);
  }, []);

  const navigateUp = useCallback(() => {
    if (parentPath) setCurrentPath(parentPath);
  }, [parentPath]);

  const closeFolderForm = useCallback(() => {
    setCreatingFolder(false);
    setNewFolderName('');
    setInitGit(false);
  }, []);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      const res = await authFetch('/api/dirs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: currentPath, name: newFolderName.trim(), gitInit: initGit }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // git-init failure keeps the directory server-side ({error, path}):
        // navigate there so the user can run `git init` manually, but keep
        // the error visible instead of silently pretending nothing happened.
        if (body.path) {
          closeFolderForm();
          setCurrentPath(body.path);
          setError(body.error || `HTTP ${res.status}`);
          return;
        }
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      closeFolderForm();
      setCurrentPath(data.path);
    } catch (err) {
      setError(err.message);
    }
  }, [currentPath, newFolderName, initGit, closeFolderForm]);

  const closePreview = useCallback(() => setPreviewFile(null), []);

  const handleDownload = useCallback((file) => {
    const a = document.createElement('a');
    const token = getToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    a.href = `/api/files?path=${encodeURIComponent(file.path)}${tokenParam}`;
    a.download = file.name;
    a.click();
  }, []);

  const uploadFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadProgress(`Uploading ${fileList.length} file(s)...`);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('destination', currentPath);
      for (const file of fileList) {
        formData.append('files', file);
      }
      const res = await authFetch('/api/files', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUploadProgress(`Uploaded ${data.uploaded.length} file(s)`);
      fetchDirs(currentPath);
      setTimeout(() => setUploadProgress(''), 3000);
    } catch (err) {
      setError(err.message);
      setUploadProgress('');
    } finally {
      setUploading(false);
    }
  }, [currentPath, fetchDirs]);

  const handleFileInputChange = useCallback((e) => {
    uploadFiles(e.target.files);
    e.target.value = '';
  }, [uploadFiles]);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current++;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  // Under $HOME subdirectories the breadcrumb root renders as `~` (title
  // carries the real path); at $HOME itself and elsewhere the drive/root
  // prefix is shown, so $HOME's parents stay reachable. Navigation always
  // uses the real paths.
  const homeBase = homeDir && homeDir !== '/'
    && currentPath.startsWith(homeDir + '/')
    ? (homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir)
    : null;
  const pathRoot = homeBase || (currentPath.match(/^([a-zA-Z]:\\|\/)/)?.[0] || '/');
  const breadcrumbs = currentPath.slice(homeBase ? homeBase.length : pathRoot.length).split(/[/\\]/).filter(Boolean);

  // Apps hidden via sandbox.config.json's hiddenApps (issue #105): filtered
  // out of every picker list below entirely -- unlike availableApps===false
  // (not installed, which still shows greyed-out with a tooltip), a hidden
  // app never renders at all.
  const visibleApps = ALL_APPS.filter((a) => !hiddenApps.includes(a));
  // Guards the toolbar's quick-launch button and the in-modal single-launch
  // "起動" button (issue #105): unlike the picker items, which block their
  // own onClick via chooseApp, these two fire onOpen directly with whatever
  // appDefault currently holds -- if it's stale (hidden after being saved,
  // or still mid-flight before the /api/dirs/home reconciliation effect
  // above corrects it) they'd launch a hidden or uninstalled app with no
  // guard at all, unlike every other launch affordance this feature added.
  const effectiveAppHidden = hiddenApps.includes(appDefault) || (availableApps && !availableApps[appDefault]);
  // Sandbox choice + gpg/sshAgent suboptions for the single-launch pane.
  // Sandbox choice unavailable when no sandbox backend exists on the server host.
  // When the
  // server mandates a sandbox the toggle stays locked on -- launches will fail
  // server-side, and the note below says so.
  const sandboxChoiceDisabled = sandboxAvailable === false && !forceSandbox;
  // Contradictory server config (a sandbox is mandated -- by forceSandbox or
  // by browseRoots -- but no backend exists): no launch can succeed, so the
  // launch buttons are disabled as well (fail-closed UI).
  // null (fetch pending / older server) keeps everything enabled.
  const launchesBlocked = forceSandbox && sandboxAvailable === false;
  const sandboxPicker = (
    <>
      <div className="open-menu-sep" />
      <div
        className={`open-menu-item${forceSandbox ? ' open-menu-item-disabled' : ''}`}
        onClick={() => chooseSandbox(false)}
        title={forceSandbox ? 'サーバー設定でサンドボックス外の起動は禁止されています' : ''}
      >
        <span className="open-menu-check">{!sandboxDefault ? '✓' : ''}</span>
        通常起動
      </div>
      <div
        className={`open-menu-item${sandboxChoiceDisabled ? ' open-menu-item-disabled' : ''}`}
        onClick={() => chooseSandbox(true)}
          title={forceSandbox ? 'サーバー設定で強制' : (sandboxChoiceDisabled ? 'このサーバーではサンドボックス機能が利用できないため使えません' : '')}
      >
        <span className="open-menu-check">{sandboxDefault ? '✓' : ''}</span>
        🔒 サンドボックスで起動
      </div>
      <div className="open-menu-suboptions">
        {sandboxBackends && (sandboxBackends.bwrap.ok || sandboxBackends.qemu.ok) && (
          <label className="open-menu-suboption">
            方式
            <select
              value={sandboxOpts.backend || ''}
              onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, backend: e.target.value || null })}
            >
              <option value="">既定 ({sandboxBackends.default === 'qemu' ? 'VM' : 'bwrap'})</option>
              <option value="bwrap" disabled={!sandboxBackends.bwrap.ok}>
                bwrap{sandboxBackends.bwrap.ok ? '' : ` (利用不可: ${sandboxBackends.bwrap.reason})`}
              </option>
              <option value="qemu" disabled={!sandboxBackends.qemu.ok}>
                VM (QEMU){sandboxBackends.qemu.ok ? '' : ` (利用不可: ${sandboxBackends.qemu.reason})`}
              </option>
            </select>
          </label>
        )}
        <label className={`open-menu-suboption${inVm ? ' open-menu-suboption-disabled' : ''}`} title={inVm ? 'VMでは GPG Vault を使ってください' : ''}>
          <input
            type="checkbox"
            disabled={inVm}
            checked={inVm ? false : sandboxOpts.gpg}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpg: e.target.checked })}
          />
          GPG署名を使う{inVm ? `（${VM_UNSUPPORTED_NOTE}）` : ''}
        </label>
        <label className="open-menu-suboption">
          <input
            type="checkbox"
            checked={sandboxOpts.sshAgent}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, sshAgent: e.target.checked })}
          />
          ssh-agentを転送する
        </label>
        <label className={`open-menu-suboption${authMode !== 'passkey' ? ' open-menu-suboption-disabled' : ''}`} title={authMode !== 'passkey' ? 'パスキーログイン限定機能です' : ''}>
          <input
            type="checkbox"
            disabled={authMode !== 'passkey'}
            checked={authMode !== 'passkey' ? false : sandboxOpts.gpgVault}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpgVault: e.target.checked })}
          />
          GPG Vaultで署名・SSH pushする
        </label>
        <label className={`open-menu-suboption${toolDisabled('rtk') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('rtk') ? toolNote : ''}>
          <input
            type="checkbox"
            disabled={toolDisabled('rtk')}
            checked={toolDisabled('rtk') ? false : sandboxOpts.tools.rtk}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, tools: { ...sandboxOpts.tools, rtk: e.target.checked } })}
          />
          rtk を導入する (sandbox 内にインストール){toolDisabled('rtk') ? `（${toolNote}）` : ''}
        </label>
        <label className={`open-menu-suboption${toolDisabled('codeReviewGraph') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('codeReviewGraph') ? toolNote : ''}>
          <input
            type="checkbox"
            disabled={toolDisabled('codeReviewGraph')}
            checked={toolDisabled('codeReviewGraph') ? false : sandboxOpts.tools.codeReviewGraph}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, tools: { ...sandboxOpts.tools, codeReviewGraph: e.target.checked } })}
          />
          code-review-graph MCP を導入する{toolDisabled('codeReviewGraph') ? `（${toolNote}）` : ''}
        </label>
        {inVm && (
          <label className="open-menu-suboption">
            VMテンプレート
            <select
              value={sandboxOpts.vmTemplateId || ''}
              onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, vmTemplateId: e.target.value || null })}
            >
              <option value="">既定</option>
              {vmTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.cpus} CPU / {t.memoryMiB} MiB)</option>
              ))}
              {vmTemplateMissing && <option value={sandboxOpts.vmTemplateId}>(削除済みのテンプレート)</option>}
            </select>
          </label>
        )}
      </div>
      <p className="open-menu-note">
        {forceSandbox && sandboxAvailable === false
          ? (forceSandboxReason === 'browseRoots' ? BROWSE_ROOTS_SANDBOX_UNAVAILABLE_NOTE : FORCE_SANDBOX_UNAVAILABLE_NOTE)
          : forceSandbox
            ? (forceSandboxReason === 'browseRoots'
              ? BROWSE_ROOTS_SANDBOX_NOTE
              : 'サンドボックスがサーバー設定 (forceSandbox) で強制されています。通常起動はできません。')
            : sandboxAvailable === false
              ? SANDBOX_UNAVAILABLE_NOTE
              : `サンドボックス: 隣接プロジェクトを隔離し、内部に rootless docker を用意。初期値は一般設定で変更でき、このディレクトリ (${displayPath(currentPath, homeDir)}) に記憶されます。`}
      </p>
    </>
  );

  return (
    <div
      className="directory-browser"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="browser-header">
        <div className="browser-header-title">
          <h1>Select a Directory</h1>
          <p className="subtitle">Choose a working directory</p>
          {sandboxAvailable === false && (
            <div className={`directory-warning-banner${forceSandbox ? ' is-error' : ''}`} role="alert">
              {forceSandbox
                ? (forceSandboxReason === 'browseRoots' ? BROWSE_ROOTS_SANDBOX_UNAVAILABLE_NOTE : FORCE_SANDBOX_UNAVAILABLE_NOTE)
                : SANDBOX_UNAVAILABLE_NOTE}
            </div>
          )}
        </div>
      </div>

      <nav className="breadcrumbs">
        <button
          className="breadcrumb-item"
          onClick={() => navigateTo(pathRoot)}
          title={homeBase || undefined}
        >
          {homeBase ? '~' : pathRoot}
        </button>
        {breadcrumbs.map((segment, i) => {
          const sep = homeBase ? '/' : (pathRoot.includes('\\') ? '\\' : '/');
          // Join through the separator too: pathRoot (e.g. the $HOME base
          // "/home/ast", or "/") must not glue onto the first segment --
          // "/home/ast" + "dev" became "/home/astdev".
          const path = [pathRoot, ...breadcrumbs.slice(0, i + 1)].join(sep);
          return (
            <span key={path}>
              <span className="breadcrumb-sep">/</span>
              <button className="breadcrumb-item" onClick={() => navigateTo(path)}>
                {segment}
              </button>
            </span>
          );
        })}
      </nav>

      <div className="browser-toolbar">
        <div className="toolbar-nav">
          <button className="btn btn-secondary" onClick={navigateUp} disabled={!parentPath}>
            Up
          </button>
          {/* browseRoots (issue #189): home() may sit outside the allowed
              roots, where navigating would just 403 -- prefer the server's
              initialBrowsePath (== home() when unrestricted). */}
          <button
            className="btn btn-secondary"
            onClick={() => { const target = initialBrowsePath || homeDir; if (target) navigateTo(target); }}
            disabled={!(initialBrowsePath || homeDir)}
          >
            Home
          </button>
          <button className="btn btn-secondary" onClick={() => { fetchDirs(currentPath); }} disabled={loading}>
            Refresh
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setCreatingFolder(true);
              setNewFolderName('');
              setInitGit(false);
            }}
            title="Make a directory (optionally as a git repository)"
          >
            New Folder
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
          />
          <label className="toggle-hidden">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden
          </label>
        </div>
        <div className="toolbar-launch-group">
          <button
            className="btn btn-secondary launch-btn"
            onClick={() => onOpenShell(currentPath)}
            disabled={launchesBlocked}
            title={launchesBlocked ? LAUNCHES_BLOCKED_TITLE : ''}
          >
            Terminal
          </button>
          <div className="open-split">
            <button
              className="btn btn-primary open-split-main"
              onClick={() => onOpen(currentPath, { sandbox: sandboxDefault, sandboxOpts: effectiveSandboxOpts, app: appDefault, model: modelForApp(appDefault), ui: uiForApp(appDefault) })}
              disabled={effectiveAppHidden || launchesBlocked}
              title={effectiveAppHidden ? `${APP_LABELS[appDefault] || appDefault}は起動できません (非表示または未インストール)。起動方法を選択してください。` : (launchesBlocked ? LAUNCHES_BLOCKED_TITLE : (sandboxDefault ? 'サンドボックスで起動' : '通常起動'))}
            >
              {sandboxDefault ? '🔒 ' : ''}{uiForApp(appDefault) === 'chat' ? '💬 ' : ''}{appDefault === 'claude' ? 'Claude Code' : appDefault === 'codex' ? 'OpenAI Codex' : 'opencode'}
            </button>
            <button
              className="btn btn-primary open-split-caret"
              onClick={() => setOpenMenuOpen(true)}
              title="起動方法を選択"
              aria-label="起動方法を選択"
            >
              &#9662;
            </button>
          </div>
        </div>
      </div>

      {openMenuOpen && (
        <div className="resume-overlay" onClick={closeOpenMenu}>
          <div className="resume-dialog open-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>起動方法を選択</h3>
            <div className="open-menu-label">アプリ</div>
            {visibleApps.map((app) => (
              <div
                key={app}
                className={`open-menu-item${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                onClick={() => chooseApp(app)}
                title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
              >
                <span className="open-menu-check">{appDefault === app ? '✓' : ''}</span>
                {APP_LABELS[app]}
              </div>
            ))}
            {appDefault === 'opencode' && (
              <>
                <div className="open-menu-label">表示</div>
                <div className="open-menu-ui-row" role="radiogroup" aria-label="表示方法">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={uiForApp('opencode') === 'terminal'}
                    className={`open-menu-ui-btn${uiForApp('opencode') === 'terminal' ? ' active' : ''}`}
                    onClick={() => chooseOpencodeUi('terminal')}
                  >
                    ⌨ ターミナル
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={uiForApp('opencode') === 'chat'}
                    className={`open-menu-ui-btn${uiForApp('opencode') === 'chat' ? ' active' : ''}`}
                    onClick={() => chooseOpencodeUi('chat')}
                    disabled={!opencodeChatAvailable}
                    title={opencodeChatAvailable ? 'Web チャット画面で操作する' : 'チャットは opencode 2.0 以降が必要です'}
                  >
                    💬 チャット
                  </button>
                </div>
                {!opencodeChatAvailable && (
                  <div className="open-menu-note">チャット表示には opencode 2.0 以降が必要です</div>
                )}
              </>
            )}
            {modelInputForApp(appDefault) && (
              <div className="open-menu-model-row">
                <input
                  type="text"
                  className="open-menu-model-input"
                  placeholder="Codexモデル (空=既定)"
                  value={codexModel}
                  onChange={(e) => { setCodexModel(e.target.value); localStorage.setItem('ccserver-codex-model', e.target.value); }}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            )}
            {sandboxPicker}
            <div className="resume-actions">
              <button className="btn btn-secondary" onClick={closeOpenMenu}>キャンセル</button>
              <button
                className="btn btn-primary"
                onClick={() => { closeOpenMenu(); onOpen(currentPath, { sandbox: sandboxDefault, sandboxOpts: effectiveSandboxOpts, app: appDefault, model: modelForApp(appDefault), ui: uiForApp(appDefault) }); }}
                disabled={effectiveAppHidden || launchesBlocked}
                title={effectiveAppHidden ? `${APP_LABELS[appDefault] || appDefault}は起動できません (非表示または未インストール)` : (launchesBlocked ? LAUNCHES_BLOCKED_TITLE : '')}
              >
                起動
              </button>
            </div>
          </div>
        </div>
      )}

      {uploadProgress && (
        <div className="upload-progress">{uploadProgress}</div>
      )}

      {creatingFolder && (
        <div className="new-folder-bar">
          <input
            type="text"
            className="new-folder-input"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') closeFolderForm();
            }}
            autoFocus
          />
          <label className="new-folder-git-check" title="Create a git repository in the new folder">
            <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
            git init
          </label>
          <button className="btn btn-primary" onClick={handleCreateFolder}>
            Create
          </button>
          <button className="btn btn-secondary" onClick={closeFolderForm}>
            Cancel
          </button>
        </div>
      )}

      <div className={`dir-list${dragOver ? ' drag-over' : ''}`}>
        {loading && <div className="loading">Loading...</div>}
        {error && <div className="error">Error: {error}</div>}
        {!loading && !error && dirs.length === 0 && files.length === 0 && (
          <div className="empty">No entries</div>
        )}
        {!loading &&
          !error &&
          dirs.map((dir) => (
            <div
              key={dir.path}
              className="dir-item"
              onClick={() => navigateTo(dir.path)}
              onDoubleClick={() => {
                if (launchesBlocked) return; // fail-closed UI: no launch can succeed
                onOpen(dir.path, {
                  sandbox: sandboxDefault,
                  sandboxOpts: (() => {
                    const opts = loadSandboxOpts(dir.path, sandboxDefaults);
                    return sanitizeSandboxOpts(opts, toolsAvailable, launchBackend(opts, sandboxBackends));
                  })(),
                  app: appDefault,
                  model: modelForApp(appDefault),
                  ui: uiForApp(appDefault),
                });
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigateTo(dir.path);
              }}
            >
              <span className="dir-icon">&#128193;</span>
              <span className="dir-name">{dir.name}</span>
            </div>
          ))}
        {!loading &&
          !error &&
          files.map((file) => (
            <div key={file.path} className="file-item">
              {isPreviewable(file.name) ? (
                // Preview and download are sibling <button>s: real buttons get
                // Enter/Space and focus for free, and nothing interactive nests.
                <button
                  type="button"
                  className="file-open-btn"
                  onClick={() => setPreviewFile(file)}
                  title={`Preview ${file.name}`}
                >
                  <span className="file-icon">&#128196;</span>
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatSize(file.size)}</span>
                </button>
              ) : (
                <span className="file-label">
                  <span className="file-icon">&#128196;</span>
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatSize(file.size)}</span>
                </span>
              )}
              <button
                type="button"
                className="btn btn-secondary file-download-btn"
                onClick={() => handleDownload(file)}
                title="Download"
                aria-label={`Download ${file.name}`}
              >
                &#8595;
              </button>
            </div>
          ))}
      </div>

      {previewFile && (
        <Suspense fallback={null}>
          <FilePreview file={previewFile} onClose={closePreview} onDownload={handleDownload} />
        </Suspense>
      )}

      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-text">Drop files to upload</div>
        </div>
      )}
    </div>
  );
}
