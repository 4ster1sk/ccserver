import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { authFetch, getToken } from '../auth.js';
import TabIcon from './TabIcon.jsx';

const TerminalView = lazy(() => import('./TerminalView.jsx'));

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch { return ''; }
}

// A combo group's tab body: a second-level sub-tab bar (one entry per member:
// workerA / workerB / orchestrator) above always-mounted TerminalViews, one
// per member session, switched by display exactly like the top-level tabs.
//
// Membership is discovered ONLY from GET /api/groups/:id (polled while
// visible) -- the orchestrator's open_tab additions appear here after the
// next poll. No sessionId is ever constructed client-side; the authorization
// boundary lives server-side (groupManager.isSessionInGroup).
export default function GroupTabView({
  groupId,
  initialMembers,
  visible,
  xtermTheme,
  themeId,
  onThemeChange,
  notify,
  notifyEnabled,
  notifyPermission,
  onToggleNotify,
  onActiveAppChange,
  onCurrentTurnChange,
  tabId,
  onFocusTab,
}) {
  const [members, setMembers] = useState(initialMembers || []);
  const [activeRole, setActiveRole] = useState(() => initialMembers?.[0]?.role || null);
  const [currentTurn, setCurrentTurn] = useState(null);
  const [restartingOrch, setRestartingOrch] = useState(false);
  const [groupGone, setGroupGone] = useState(false);
  const membersRef = useRef(members);
  const wasVisibleRef = useRef(visible);
  const currentTurnRef = useRef(null);

  // Group file exchange state
  const [files, setFiles] = useState([]);
  const [filesError, setFilesError] = useState(null);
  const [uploadProgress, setUploadProgress] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const fileInputRef = useRef(null);
  const dragCountRef = useRef(0);

  const openFiles = useCallback(() => setIsFilesOpen(true), []);
  const closeFiles = useCallback(() => setIsFilesOpen(false), []);

  useEffect(() => {
    if (!isFilesOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setIsFilesOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFilesOpen]);

  useEffect(() => { membersRef.current = members; }, [members]);

  useEffect(() => {
    if (initialMembers && (!activeRole || !initialMembers.some((m) => m.role === activeRole))) {
      setActiveRole(initialMembers[0]?.role || null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMembers]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await authFetch(`/api/groups/${groupId}`);
        if (res.status === 404) {
          // The group is gone server-side (torn down from another client /
          // the server restarted and the group was destroyed): nothing left
          // to poll. Show a banner instead of silently staying stale.
          setGroupGone(true);
          return;
        }
        if (!res.ok) return;
        setGroupGone(false);
        const data = await res.json();
        if (cancelled) return;
        setCurrentTurn(data.currentTurn ?? null);
        if (currentTurnRef.current !== (data.currentTurn ?? null)) {
          currentTurnRef.current = data.currentTurn ?? null;
          onCurrentTurnChange?.(data.currentTurn ?? null);
        }
        const next = data.members || [];
        const prev = membersRef.current;
        if (JSON.stringify(next) !== JSON.stringify(prev)) {
          setMembers(next);
          setActiveRole((role) => {
            if (role && next.some((m) => m.role === role)) return role;
            return next[0]?.role || null;
          });
        }
      } catch {
        // poll is best effort; the next tick retries
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, groupId]);

  // Files polling (same 3s interval, independent)
  const fetchFiles = useCallback(async () => {
    try {
      const res = await authFetch(`/api/groups/${groupId}/files`);
      if (res.status === 404) { setFiles([]); return; }
      if (!res.ok) { setFilesError(`HTTP ${res.status}`); return; }
      const data = await res.json();
      setFiles(data.files || []);
      setFilesError(null);
    } catch (err) {
      setFilesError(err.message);
    }
  }, [groupId]);

  useEffect(() => {
    if (!visible) return;
    fetchFiles();
    const interval = isFilesOpen ? 3000 : 10000;
    const timer = setInterval(fetchFiles, interval);
    return () => clearInterval(timer);
  }, [visible, fetchFiles, isFilesOpen]);

  const uploadFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadProgress(`Uploading ${fileList.length} file(s)...`);
    setFilesError(null);
    try {
      const formData = new FormData();
      for (const file of fileList) {
        formData.append('files', file);
      }
      const res = await authFetch(`/api/groups/${groupId}/files`, { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      setUploadProgress(`Uploaded ${fileList.length} file(s)`);
      fetchFiles();
      setTimeout(() => setUploadProgress(''), 3000);
    } catch (err) {
      setFilesError(err.message);
      setUploadProgress('');
    } finally {
      setUploading(false);
    }
  }, [groupId, fetchFiles]);

  const handleFileInputChange = useCallback((e) => {
    uploadFiles(e.target.files);
    e.target.value = '';
  }, [uploadFiles]);

  const handleDownload = useCallback((file) => {
    const token = getToken();
    const a = document.createElement('a');
    if (token) a.href = `/api/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(file.id)}?token=${encodeURIComponent(token)}`;
    else a.href = `/api/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(file.id)}`;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [groupId]);

  const handleDelete = useCallback(async (file) => {
    if (!window.confirm(`Delete ${file.name}?`)) return;
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      fetchFiles();
    } catch (err) {
      setFilesError(err.message);
    }
  }, [groupId, fetchFiles]);

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
  const handleDragOver = useCallback((e) => { e.preventDefault(); }, []);
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  // Report the active member's app upward (App uses it to hide the Usage
  // button for opencode). While this tab is visible it emits on every change
  // -- no per-instance dedup: App's single shared state must always reflect
  // the currently visible group tab, and multiple group tabs stay mounted
  // while hidden (their own last-reported value would otherwise go stale).
  // On becoming hidden it emits null so switching tabs never leaves a stale
  // group's app in App's state.
  useEffect(() => {
    if (!visible) {
      if (wasVisibleRef.current) {
        wasVisibleRef.current = false;
        onActiveAppChange?.(null);
      }
      return;
    }
    wasVisibleRef.current = true;
    const active = members.find((m) => m.role === activeRole);
    const app = ['claude', 'opencode', 'codex'].includes(active?.app) ? active.app : null;
    onActiveAppChange?.(app);
  }, [members, activeRole, visible, onActiveAppChange]);

  // Restart a dead orchestrator: the server spawns a fresh orchestrator
  // session in the group's own dir and re-creates the control broker. The
  // poll loop picks the new member up on the next tick.
  const restartOrchestrator = useCallback(async () => {
    if (restartingOrch) return;
    setRestartingOrch(true);
    try {
      const res = await authFetch(`/api/groups/${groupId}/orchestrator`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`オーケストレーターを再起動できませんでした: ${err.message}`);
    } finally {
      setRestartingOrch(false);
    }
  }, [groupId, restartingOrch]);

  const orchestrator = members.find((m) => m.role === 'orchestrator');

  const roleLabel = (role) => {
    if (role === 'orchestrator') return 'Orchestrator';
    if (role === 'workerA') return 'Worker A';
    if (role === 'workerB') return 'Worker B';
    return role;
  };

  return (
    <div className="group-tab-view">
      <div className="group-subtab-bar">
        {members.map((m) => (
          <div
            key={m.role}
            className={`group-subtab-item${m.role === activeRole ? ' active' : ''}${m.role === currentTurn ? ' current-turn' : ''}${m.exited ? ' exited' : ''}${!m.sandbox ? ' no-sandbox' : ''}`}
            onClick={() => setActiveRole(m.role)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setActiveRole(m.role);
            }}
          >
            <span className="group-subtab-label">
              <TabIcon type="terminal" app={m.app === 'codex' ? 'codex' : m.app === 'opencode' ? 'opencode' : 'claude'} shell={false} />
              {roleLabel(m.role)}
              {m.model && <span className="group-subtab-model" title={m.model}>{m.model}</span>}
              {m.exited && <span className="group-subtab-exited" title="exited">&#10005;</span>}
            </span>
          </div>
        ))}
        <button
          className="group-files-trigger-btn"
          onClick={openFiles}
          aria-label="Files"
          aria-haspopup="dialog"
          aria-expanded={isFilesOpen}
          title="Files"
        >
          <span aria-hidden="true">📎</span> Files
          {files.length > 0 && <span className="group-files-badge">{files.length}</span>}
        </button>
        {orchestrator?.exited && (
          <button
            className="btn btn-secondary group-restart-orch-btn group-restart-orch-btn--with-files"
            onClick={restartOrchestrator}
            disabled={restartingOrch}
            title="オーケストレーターが終了しています。再起動しますか?"
          >
            {restartingOrch ? '再起動中...' : 'Orchestrator 再起動'}
          </button>
        )}
      </div>
      {groupGone && (
        <div className="group-gone-banner">
          このグループはサーバー上で削除されています。このタブを閉じてください。
        </div>
      )}
      <div className="group-subtab-body">
        {members.map((m) => (
          <div
            key={m.sessionId}
            style={{ display: m.role === activeRole && visible ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}
          >
            <Suspense fallback={null}>
              <TerminalView
                cwd={m.cwd}
                app={m.app === 'codex' ? 'codex' : m.app === 'opencode' ? 'opencode' : 'claude'}
                model={m.model || null}
                attachSessionId={m.sessionId}
                visible={m.role === activeRole && visible}
                // Resume settings for a dead member (exited after a restart
                // or on its own): the attach fails with SESSION_NOT_FOUND and
                // TerminalView re-launches with these, keeping the member's
                // group membership (groupId/groupRole) and conversation
                // (claudeSessionId / opencode resume) intact.
                claudeSessionId={m.claudeSessionId}
                sandbox={m.sandbox}
                sandboxOpts={m.sandboxOpts}
                resume={m.app === 'opencode' || m.app === 'codex'}
                groupId={groupId}
                groupRole={m.role}
                xtermTheme={xtermTheme}
                themeId={themeId}
                onThemeChange={onThemeChange}
                notify={notify}
                notifyEnabled={notifyEnabled}
                notifyPermission={notifyPermission}
                onToggleNotify={onToggleNotify}
                tabId={tabId}
                onFocusTab={() => {
                  // Bring up this group tab AND the specific member whose
                  // notification was clicked.
                  setActiveRole(m.role);
                  onFocusTab?.();
                }}
              />
            </Suspense>
          </div>
        ))}
      </div>
      {isFilesOpen && (
        <div className="resume-overlay group-files-overlay" onClick={closeFiles}>
          <div
            className={`resume-dialog group-files-dialog${dragOver ? ' drag-over' : ''}`}
            onClick={(e) => e.stopPropagation()}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            role="dialog"
            aria-modal="true"
            aria-label="Files"
          >
            <div className="group-files-dialog-header">
              <h3>Files</h3>
              <button className="btn btn-secondary" onClick={closeFiles} aria-label="Close">✕</button>
            </div>
            <div className="group-files-header">
              <span className="group-files-count">{files.length} file(s)</span>
              <button className="btn btn-secondary group-files-upload-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading} title="Upload files to this group">
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
              <input ref={fileInputRef} type="file" multiple onChange={handleFileInputChange} style={{ display: 'none' }} />
            </div>
            {uploadProgress && <div className="group-files-progress">{uploadProgress}</div>}
            {filesError && <div className="group-files-error">Error: {filesError}</div>}
            {files.length === 0 ? (
              <div className="group-files-empty">No files yet. Drag &amp; drop or click Upload. Max 50 MiB/file, 20 files / 200 MiB per group.</div>
            ) : (
              <div className="group-files-list">
                {files.map((f) => (
                  <div key={f.id} className="group-files-item">
                    <span className="group-files-name" title={f.name}>{f.name}</span>
                    <span className="group-files-meta">{formatSize(f.size)} · {f.mimeType} · {f.direction === 'agent' ? `agent:${f.publishedBy || ''}` : 'browser'} · {formatTime(f.publishedAt)}</span>
                    <button className="btn btn-secondary group-files-download-btn" onClick={() => handleDownload(f)} title="Download">↓</button>
                    <button className="btn btn-secondary group-files-delete-btn" onClick={() => handleDelete(f)} title="Delete">✕</button>
                  </div>
                ))}
              </div>
            )}
            {dragOver && <div className="group-files-drag-overlay">Drop files to upload</div>}
            <div className="resume-actions" style={{ marginTop: '12px' }}>
              <button className="btn btn-secondary" onClick={closeFiles}>閉じる</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
