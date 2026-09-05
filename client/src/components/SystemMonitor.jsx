import {
  formatUptime,
  formatLoadAvg,
  CpuCard,
  MemoryCard,
  StorageCard,
  TempCard,
  GpuCard,
  IpmiCards,
} from './widgets/MonitorCards.jsx';
import { useSystemStatsContext } from './widgets/SystemStatsProvider.jsx';
import { useSystemStats } from './widgets/useSystemStats.js';

export default function SystemMonitor({ visible }) {
  const provided = useSystemStatsContext();
  const fallback = useSystemStats(!provided && visible);
  const { data, error, interval, setInterval: setIntervalMs, showIpmi, setShowIpmi } = provided || fallback;

  if (error && !data) {
    return (
      <div className="system-monitor">
        <div className="error">Failed to load system stats: {error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="system-monitor">
        <div className="loading">Loading system stats...</div>
      </div>
    );
  }

  return (
    <div className="system-monitor">
      <div className="monitor-header">
        <h2>System Monitor</h2>
        <div className="monitor-meta">
          <span>Uptime: {formatUptime(data.uptime)}</span>
          <span>Load: {formatLoadAvg(data.loadAvg) ?? '—'}</span>
          <select
            className="monitor-interval-select"
            value={interval}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          >
            {/* 選択肢外の値 (localStorageの旧値・手編集値) でも空白にしない */}
            {![1000, 2000, 5000, 10000].includes(interval) && (
              <option value={interval}>{interval / 1000}s</option>
            )}
            <option value={1000}>1s</option>
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>
          <label className="monitor-toggle">
            <input
              type="checkbox"
              checked={showIpmi}
              onChange={(e) => setShowIpmi(e.target.checked)}
            />
            IPMI
          </label>
        </div>
      </div>

      <div className="monitor-grid">
        <CpuCard data={data} />
        <MemoryCard data={data} />
        <StorageCard data={data} />
        <TempCard data={data} />
        <GpuCard data={data} />
        <IpmiCards data={data} showIpmi={showIpmi} />
      </div>
    </div>
  );
}
