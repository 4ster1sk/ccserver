// The network-isolation globe of a session header (see ccserver-netbroker):
// `enabled` is the live enforce/open policy; `scope` 'vm' means the one
// broker of a persistent VM, so a flip applies to all of its sessions.
export default function NetworkIsolationToggle({ enabled, scope, onToggle }) {
  return (
    <button
      className={`btn network-isolate-toggle${enabled ? ' active' : ''}`}
      onClick={onToggle}
      title={(enabled
        ? 'ネットワーク隔離: 有効 (許可リストのみ通信可、クリックで一時解除)'
        : 'ネットワーク隔離: 一時解除中 (全通信許可、クリックで再度有効化)')
        + (scope === 'vm' ? '\nこの常駐VMの全セッションに効きます' : '')}
    >
      <svg className="header-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" style={{ color: 'var(--text-muted)' }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.8" ry="6"/><path d="M2 8h12"/>{enabled && <line x1="2" y1="2" x2="14" y2="14" strokeWidth="2"/>}</svg>
    </button>
  );
}
