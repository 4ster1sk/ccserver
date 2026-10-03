// Shared by TerminalView.jsx (open tab header) and SessionList.jsx (sidebar)
// -- one judgment so the two can't drift.
//
// session: { commitSigningActive } -- from the WS `session` message or a
//          GET /api/sessions element: whether the host signs this session's
//          commits (decided at launch).
// status:  useCommitSigningStatusContext().data (null = not yet loaded).
// Returns null (render nothing) or { state: 'active'|'inactive', reason }.
// "inactive" for a signing session means its commits will wait for an
// unlock (the approval banner asks), not that they fail.
export function commitSigningBadgeState(session, status) {
  if (!session?.commitSigningActive) return null;
  if (!status?.configured || !status.key) {
    return { state: 'inactive', reason: 'ホストの署名鍵が見つかりません (コミットは署名を拒否されます)' };
  }
  if (!status.unlocked) {
    return { state: 'inactive', reason: '署名鍵はロック中です (コミット時にロック解除を求めます)' };
  }
  return { state: 'active', reason: `コミットはホストで署名されます (${status.key.nameEmail})` };
}
