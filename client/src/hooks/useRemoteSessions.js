import { useState, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';
import { useVisiblePolling } from './useVisiblePolling.js';

const POLL_MS = 5000;

// セッション一覧 (サイドバー / ポップアップ) 用: ACTIVE なペアリング先
// インスタンスそれぞれの稼働中セッション ([{ instance, session }]、コンボの
// メンバーは除く) とコンボ ([{ instance, group }]) を集めて返す。
// RemoteInstanceView と同じ federation REST を叩くが、あちらは選択中の
// 1インスタンスのみ・Remote タブ表示中のみのポーリングなので別に持つ。
// 取得に失敗したインスタンスは前回値を維持する (一時的な通信断で一覧が
// ちらつかないように)。
export function useRemoteSessions(enabled = true) {
  const [entries, setEntries] = useState([]);
  const refreshingRef = useRef(false);
  const [groupEntries, setGroupEntries] = useState([]);
  const lastByInstanceRef = useRef(new Map());
  const lastGroupsByInstanceRef = useRef(new Map());

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await authFetch('/api/federation/instances');
      if (!res.ok) return;
      const data = await res.json();
      const active = (Array.isArray(data.instances) ? data.instances : []).filter((i) => i.status === 'active');
      const results = await Promise.all(active.map(async (instance) => {
        const base = `/api/federation/instances/${encodeURIComponent(instance.id)}`;
        const fetchList = async (path, key, lastRef) => {
          try {
            const r = await authFetch(`${base}/${path}`);
            if (!r.ok) return lastRef.current.get(instance.id) || [];
            return (await r.json())[key] || [];
          } catch {
            return lastRef.current.get(instance.id) || [];
          }
        };
        const [sessions, groups] = await Promise.all([
          fetchList('sessions', 'sessions', lastByInstanceRef),
          fetchList('groups', 'groups', lastGroupsByInstanceRef),
        ]);
        return [instance, sessions, groups];
      }));
      const next = new Map();
      const nextGroups = new Map();
      const flat = [];
      const flatGroups = [];
      for (const [instance, sessions, groups] of results) {
        next.set(instance.id, sessions);
        nextGroups.set(instance.id, groups);
        // コンボのメンバーはローカル同様に個別行へ出さず、グループ1行にまとめる。
        for (const session of sessions) if (session.groupId == null) flat.push({ instance, session });
        for (const group of groups) flatGroups.push({ instance, group });
      }
      lastByInstanceRef.current = next;
      lastGroupsByInstanceRef.current = nextGroups;
      setEntries(flat);
      setGroupEntries(flatGroups);
    } catch {
      // transient failure -- keep the last known list
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  // 終了直後、次のポーリングを待たずに一覧から外す (タブを閉じた同じ tick で
  // 「リモートのセッション」に一瞬出るのを防ぐ)。
  const dropRemoteSession = useCallback((instanceId, sessionId) => {
    const prev = lastByInstanceRef.current.get(instanceId);
    if (prev) lastByInstanceRef.current.set(instanceId, prev.filter((s) => s.id !== sessionId));
    setEntries((cur) => cur.filter((e) => !(e.instance.id === instanceId && e.session.id === sessionId)));
  }, []);

  const dropRemoteGroup = useCallback((instanceId, groupId) => {
    const prev = lastGroupsByInstanceRef.current.get(instanceId);
    if (prev) lastGroupsByInstanceRef.current.set(instanceId, prev.filter((g) => g.groupId !== groupId));
    setGroupEntries((cur) => cur.filter((e) => !(e.instance.id === instanceId && e.group.groupId === groupId)));
  }, []);

  useVisiblePolling(refresh, POLL_MS, enabled);

  return { remoteSessions: entries, remoteGroups: groupEntries, refreshRemoteSessions: refresh, dropRemoteSession, dropRemoteGroup };
}
