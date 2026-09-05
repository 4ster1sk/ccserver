export function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatMb(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export function tempColor(temp) {
  if (temp >= 80) return 'var(--error)';
  if (temp >= 60) return '#fab387';
  if (temp >= 40) return '#f9e2af';
  return 'var(--success)';
}

export function usageColor(pct) {
  if (pct >= 90) return 'var(--error)';
  if (pct >= 70) return '#fab387';
  if (pct >= 50) return '#f9e2af';
  return 'var(--accent)';
}

export function Bar({ value, max, label, sublabel, color, format }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const barColor = color || usageColor(pct);
  return (
    <div className="monitor-bar-row">
      <div className="monitor-bar-label">
        <span>{label}</span>
        {sublabel && <span className="monitor-bar-sublabel">{sublabel}</span>}
      </div>
      <div className="monitor-bar-track">
        <div className="monitor-bar-fill" style={{ width: `${pct}%`, background: barColor }} />
      </div>
      <div className="monitor-bar-value">{format || `${pct.toFixed(1)}%`}</div>
    </div>
  );
}

export function TempItem({ label, value }) {
  return (
    <div className="monitor-temp-item">
      <span className="monitor-temp-label">{label}</span>
      <span className="monitor-temp-value" style={{ color: tempColor(value) }}>{value}°C</span>
    </div>
  );
}

export function CpuCard({ data }) {
  if (!data?.cpu) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">CPU</div>
      <div className="monitor-card-subtitle">{data.cpu.model}</div>
      <Bar
        value={data.cpu.usage.total}
        max={100}
        label="Total"
        color={usageColor(data.cpu.usage.total)}
        format={`${data.cpu.usage.total.toFixed(1)}%`}
      />
      <div className="monitor-core-grid">
        {data.cpu.usage.cores.map((usage, i) => (
          <Bar
            key={i}
            value={usage}
            max={100}
            label={`Core ${i}`}
            format={`${usage.toFixed(1)}%`}
          />
        ))}
      </div>
    </div>
  );
}

export function MemoryCard({ data }) {
  if (!data?.memory) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">Memory</div>
      <Bar
        value={data.memory.used}
        max={data.memory.total}
        label="RAM"
        format={`${formatMb(data.memory.used)} / ${formatMb(data.memory.total)}`}
      />
      <div className="monitor-mem-detail">
        <span>Available: {formatMb(data.memory.available)}</span>
        <span>Buffer/Cache: {formatMb(data.memory.bufferCache)}</span>
      </div>
      {data.memory.swapTotal > 0 && (
        <Bar
          value={data.memory.swapUsed}
          max={data.memory.swapTotal}
          label="Swap"
          format={`${formatMb(data.memory.swapUsed)} / ${formatMb(data.memory.swapTotal)}`}
        />
      )}
    </div>
  );
}

export function StorageCard({ data }) {
  if (!data?.storage || data.storage.length === 0) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">Storage</div>
      {data.storage.map((s) => (
        <Bar
          key={s.mount}
          value={s.used}
          max={s.total}
          label={s.mount}
          sublabel={s.device}
          color={usageColor(s.usedPct)}
          format={`${formatMb(s.used)} / ${formatMb(s.total)}`}
        />
      ))}
    </div>
  );
}

export function TempCard({ data }) {
  if (!data?.temperatures) return null;
  const t = data.temperatures;
  if (!t.cpu && !t.pch && !t.other) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">Temperatures</div>
      {t.cpu && (
        <div className="monitor-temp-group">
          <div className="monitor-temp-group-label">CPU</div>
          {t.cpu.map((item) => (
            <TempItem key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
      )}
      {t.pch && (
        <div className="monitor-temp-group">
          <div className="monitor-temp-group-label">Chipset (PCH)</div>
          {t.pch.map((item) => (
            <TempItem key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
      )}
      {t.other && (
        <div className="monitor-temp-group">
          <div className="monitor-temp-group-label">Other</div>
          {t.other.map((item) => (
            <TempItem key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GpuCard({ data }) {
  if (!data?.gpu) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">GPU</div>
      <div className="monitor-card-subtitle">{data.gpu.name}</div>
      <TempItem label="Temperature" value={data.gpu.temp} />
      <Bar
        value={data.gpu.utilization}
        max={100}
        label="Utilization"
        format={`${data.gpu.utilization}%`}
      />
      <Bar
        value={data.gpu.memoryUsed}
        max={data.gpu.memoryTotal}
        label="VRAM"
        format={`${formatMb(data.gpu.memoryUsed)} / ${formatMb(data.gpu.memoryTotal)}`}
      />
      <div className="monitor-gpu-detail">
        <span>Fan: {data.gpu.fanSpeed}%</span>
        <span>Power: {data.gpu.powerUsage}W / {data.gpu.powerCap}W</span>
      </div>
    </div>
  );
}

function IpmiPowerCard({ data }) {
  if (!data?.ipmi || data.ipmi.power.length === 0) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">Power (IPMI)</div>
      {data.ipmi.power.map((p) => (
        <div key={p.label} className="monitor-ipmi-row">
          <span className="monitor-ipmi-label">{p.label}</span>
          <span className="monitor-ipmi-value monitor-power-value">{p.value} W</span>
        </div>
      ))}
    </div>
  );
}

function IpmiVoltageCard({ data }) {
  if (!data?.ipmi || data.ipmi.voltage.length === 0) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">Voltage (IPMI)</div>
      <div className="monitor-voltage-grid">
        {data.ipmi.voltage.map((v) => (
          <div key={v.label} className="monitor-ipmi-row">
            <span className="monitor-ipmi-label">{v.label}</span>
            <span className="monitor-ipmi-value">{v.value.toFixed(3)} V</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function IpmiFansCard({ data }) {
  if (!data?.ipmi || data.ipmi.fans.length === 0) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">Fans (IPMI)</div>
      {data.ipmi.fans.map((f) => (
        <div key={f.label} className="monitor-ipmi-row">
          <span className="monitor-ipmi-label">{f.label}</span>
          <span className="monitor-ipmi-value">{Math.round(f.value)} RPM</span>
        </div>
      ))}
    </div>
  );
}

function IpmiTempsCard({ data }) {
  if (!data?.ipmi || data.ipmi.temps.length === 0) return null;
  return (
    <div className="monitor-card">
      <div className="monitor-card-title">Temperatures (IPMI)</div>
      {data.ipmi.temps.map((t) => (
        <TempItem key={t.label} label={t.label} value={t.value} />
      ))}
    </div>
  );
}

export function IpmiCards({ data, showIpmi }) {
  if (!showIpmi || !data?.ipmi) return null;
  return (
    <>
      <IpmiPowerCard data={data} />
      <IpmiVoltageCard data={data} />
      <IpmiFansCard data={data} />
      <IpmiTempsCard data={data} />
    </>
  );
}
