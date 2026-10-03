import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';
import { useCommitSigningStatusContext } from './CommitSigningStatusProvider.jsx';
import CommitSigningUnlockForm from './CommitSigningUnlockForm.jsx';

// Global banner for server-initiated destructive-operation approvals (see
// ws/approvals.js). Polls GET /api/approvals?status=pending every few seconds
// and lets the user approve/reject each request via
// POST /api/approvals/:id/decision. Rendered at the App level (above the tab
// bar) so it is visible from every tab.
//
// Current callers: commit signing (server/ws/commitSignService.js) -- a
// launch with signing asks at launch or before each commit (the latter can
// be approved for the rest of the session at once), and a commit waiting on
// a locked key asks for an unlock. An unlock request is answered by unlocking (the form
// below), never by "承認": the server refuses that decision for it. Any
// non-OK response or fetch error is treated as "nothing pending" instead
// of surfacing errors, mirroring how App.jsx handles older-server endpoints.

const POLL_MS = 4000;
// Must match the server's fixed approval timeout (plan §3.1-6): unanswered
// requests are auto-rejected after 5 minutes. Display-only; the server owns
// the actual expiry.
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const KIND_LABELS = {
  close_session: 'セッション強制終了',
  delete_sandbox: 'サンドボックス削除',
  commit_signing_launch: 'コミット署名ありで起動',
  commit_signing_sign: 'コミットに署名',
  commit_signing_unlock: '署名鍵のロック解除',
};

function normalizeApproval(a) {
  return {
    id: a.id,
    kind: a.kind,
    summary: a.summary,
    requestedBy: a.requestedBy ?? a.requested_by ?? null,
    createdAt: a.createdAt ?? a.created_at ?? null,
  };
}

function formatRemaining(createdAt, now) {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  const remainSec = Math.max(0, Math.ceil((createdAt + APPROVAL_TIMEOUT_MS - now) / 1000));
  const min = Math.floor(remainSec / 60);
  const sec = remainSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function shortId(id) {
  return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : id;
}

export default function ApprovalBanner() {
  const [approvals, setApprovals] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null); // { id, message }
  const signing = useCommitSigningStatusContext();
  // Same overlap guard as SettingsView's sandbox list polling: a slow stale
  // response must not clobber a newer one.
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await authFetch('/api/approvals?status=pending');
      if (!res.ok) return;
      const data = await res.json();
      // Server contract (routes/approvals.js): { pending: [...], history: [...] }.
      // The status=pended query param is accepted for forward compatibility;
      // the server always answers with both lists and we render only pending.
      const list = Array.isArray(data?.pending)
        ? data.pending
        : Array.isArray(data?.approvals) ? data.approvals : [];
      setApprovals(list.map(normalizeApproval).filter((a) => a && a.id));
      setNow(Date.now());
    } catch {
      // unreachable server: keep showing the last known list
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  useVisiblePolling(refresh, POLL_MS);

  // Keep the countdown live between polls while something is pending.
  const hasPending = approvals.length > 0;
  useEffect(() => {
    if (!hasPending) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasPending]);

  const post = useCallback(async (id, url, body) => {
    if (busyId) return;
    setBusyId(id);
    setActionError(null);
    try {
      const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // 404 = the approval row is gone, 409 = another browser tab already
        // decided it (the server answers already-resolved with 409): either
        // way the refresh below picks up the new state, no error to show.
        if (res.status !== 404 && res.status !== 409) {
          const errBody = await res.json().catch(() => ({}));
          setActionError({ id, message: errBody.error || `HTTP ${res.status}` });
        }
      }
    } catch (err) {
      setActionError({ id, message: err.message || '通信エラー' });
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [busyId, refresh]);

  const decide = useCallback((id, decision) => (
    post(id, `/api/approvals/${encodeURIComponent(id)}/decision`, { decision })
  ), [post]);

  // Per-commit signing: approve this one and the rest of its session.
  const approveSigningForSession = useCallback((id) => (
    post(id, `/api/commit-signing/approvals/${encodeURIComponent(id)}/approve-session`, {})
  ), [post]);

  if (!hasPending) return null;

  return (
    <div className="approval-banner-stack" role="alert">
      <div className="approval-banner-title">
        操作の承認を待っています（5分以内に応答がない操作は拒否されます）
      </div>
      {approvals.map((a) => {
        const remaining = formatRemaining(a.createdAt, now);
        return (
          <div key={a.id} className="approval-banner">
            <div className="approval-banner-main">
              <span className="approval-banner-kind">{KIND_LABELS[a.kind] || a.kind}</span>
              <span className="approval-banner-summary">{a.summary}</span>
              <span className="approval-banner-meta">
                {a.requestedBy && (
                  <span title={`要求元セッション: ${a.requestedBy}`}>by {shortId(a.requestedBy)}</span>
                )}
                {remaining && <span>残り {remaining}</span>}
              </span>
            </div>
            <div className="approval-banner-actions">
              {a.kind === 'commit_signing_unlock' ? (
                <CommitSigningUnlockForm
                  passkeys={signing?.data?.passkeys}
                  onUnlocked={async () => { await signing?.refresh(); await refresh(); }}
                />
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={busyId === a.id}
                  onClick={() => decide(a.id, 'approved')}
                >
                  承認
                </button>
              )}
              {a.kind === 'commit_signing_sign' && (
                <button
                  className="btn btn-secondary"
                  disabled={busyId === a.id}
                  onClick={() => approveSigningForSession(a.id)}
                >
                  承認 (このセッションでは以降確認しない)
                </button>
              )}
              <button
                className="btn btn-secondary approval-reject-btn"
                disabled={busyId === a.id}
                onClick={() => decide(a.id, 'rejected')}
              >
                却下
              </button>
            </div>
            {actionError?.id === a.id && (
              <p className="approval-banner-error">処理に失敗しました: {actionError.message}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
