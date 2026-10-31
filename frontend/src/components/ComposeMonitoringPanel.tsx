import { useState } from 'react';
import { getComposeContainerLogs, getComposeMonitoring, type ComposeContainerMonitoring } from '../lib/api';
import { monitoringPanelState } from '../lib/monitoringView';

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Unavailable';
  const mib = value / (1024 * 1024);
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
}

function stateLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function metricLabel(container: ComposeContainerMonitoring): string {
  const { memoryUsageBytes, memoryLimitBytes } = container.metrics;
  if (memoryUsageBytes === null) return container.metricsUnavailableReason ?? 'Memory unavailable';
  return memoryLimitBytes === null
    ? `${formatBytes(memoryUsageBytes)} used · no limit reported`
    : `${formatBytes(memoryUsageBytes)} / ${formatBytes(memoryLimitBytes)} (${container.metrics.memoryPercent?.toFixed(1) ?? 'Unavailable'}%)`;
}

export function ComposeMonitoringPanel({ environmentId }: { environmentId: string }) {
  const [containers, setContainers] = useState<ComposeContainerMonitoring[]>([]);
  const [sampledAt, setSampledAt] = useState<string | null>(null);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [logs, setLogs] = useState<{ stream: 'stdout' | 'stderr'; text: string }[]>([]);
  const [logsTruncated, setLogsTruncated] = useState(false);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [tail, setTail] = useState(100);
  const inventoryView = monitoringPanelState({ loaded: inventoryLoaded, loading: inventoryLoading, error: inventoryError, itemCount: containers.length });
  const logsView = monitoringPanelState({ loaded: logsLoaded, loading: logsLoading, error: logsError, itemCount: logs.length });

  async function refreshInventory() {
    setInventoryLoading(true);
    setInventoryError(null);
    try {
      const result = await getComposeMonitoring(environmentId);
      setContainers(result.containers);
      setSampledAt(result.sampledAt);
      setInventoryLoaded(true);
      setSelectedId((current) => result.containers.some((container) => container.id === current && container.state !== 'removed')
        ? current
        : result.containers.find((container) => container.state !== 'removed')?.id ?? '');
      setLogsLoaded(false);
      setLogs([]);
    } catch (cause) {
      setInventoryError(cause instanceof Error ? cause.message : 'Could not load deployment details.');
    } finally {
      setInventoryLoading(false);
    }
  }

  async function refreshLogs() {
    if (!selectedId) return;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const result = await getComposeContainerLogs(environmentId, selectedId, tail);
      setLogs(result.lines);
      setLogsTruncated(result.truncated);
      setLogsLoaded(true);
    } catch (cause) {
      setLogsError(cause instanceof Error ? cause.message : 'Could not load recent logs.');
      setLogsLoaded(false);
    } finally {
      setLogsLoading(false);
    }
  }

  return (
    <details className="compose-monitoring-panel" onToggle={(event) => {
      if (event.currentTarget.open && !inventoryLoaded && !inventoryLoading) void refreshInventory();
    }}>
      <summary>Services, resource use &amp; logs</summary>
      <div className="compose-monitoring-content">
        <div className="monitoring-toolbar">
          <p>{sampledAt ? `Last checked ${new Date(sampledAt).toLocaleTimeString()}` : 'Deployment service details'}</p>
          <button className="secondary-button" type="button" onClick={() => void refreshInventory()} disabled={inventoryLoading}>
            {inventoryLoading ? 'Refreshing…' : 'Refresh services & stats'}
          </button>
        </div>

        {inventoryView === 'loading' && <div className="monitoring-state" role="status"><span className="loading-indicator" /> Loading deployment details…</div>}
        {inventoryError && <div className="form-message error-message" role="alert">{inventoryError} <button className="text-button" type="button" onClick={() => void refreshInventory()}>Try again</button></div>}
        {inventoryView === 'error' && inventoryError && <div className="monitoring-state">Deployment details could not be loaded.</div>}
        {inventoryView === 'empty' && <div className="monitoring-state">No registered containers are available for this deployment.</div>}

        {inventoryView === 'ready' && <>
          <div className="monitoring-table-wrap">
            <table className="monitoring-table">
              <thead><tr><th>Service / container</th><th>State / health</th><th>CPU</th><th>Memory</th><th>Image</th></tr></thead>
              <tbody>{containers.map((container) => <tr key={container.id}>
                <td><strong>{container.serviceName ?? 'Unknown service'}</strong><span className="monitoring-secondary">{container.name ?? `Container ${container.id.slice(0, 12)}`} · {container.id.slice(0, 12)}</span><span className="monitoring-secondary">{container.startedAt ? `Started ${new Date(container.startedAt).toLocaleString()}` : container.createdAt ? `Created ${new Date(container.createdAt).toLocaleString()}` : 'Time unavailable'}</span></td>
                <td><span className={`monitoring-state-badge monitoring-${container.state}`}>{stateLabel(container.state)}</span><span className={`monitoring-health-badge monitoring-${container.health ?? 'unknown'}`}>Health {container.health ? stateLabel(container.health) : 'unavailable'}</span></td>
                <td>{container.metrics.cpuPercent === null ? 'Unavailable' : `${container.metrics.cpuPercent.toFixed(1)}%`}</td>
                <td>{metricLabel(container)}</td>
                <td className="monitoring-image">{container.image ?? 'Unavailable'}</td>
              </tr>)}</tbody>
            </table>
          </div>

          <section className="monitoring-logs" aria-labelledby={`logs-heading-${environmentId}`}>
            <div className="monitoring-logs-heading">
              <div><h4 id={`logs-heading-${environmentId}`}>Recent container logs</h4><p>Best-effort credential redaction; maximum 500 lines and 64 KB.</p></div>
              <div className="monitoring-log-controls">
                <label className="visually-hidden" htmlFor={`container-log-select-${environmentId}`}>Select a container for logs</label>
                <select id={`container-log-select-${environmentId}`} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setLogs([]); setLogsLoaded(false); setLogsError(null); }} disabled={logsLoading}>
                  <option value="">Select a container</option>
                  {containers.filter((container) => container.state !== 'removed').map((container) => (
                    <option key={container.id} value={container.id}>{container.serviceName ?? container.name ?? container.id.slice(0, 12)}</option>
                  ))}
                </select>
                <label className="visually-hidden" htmlFor={`compose-log-tail-${environmentId}`}>Log tail size</label><select id={`compose-log-tail-${environmentId}`} aria-label="Log tail size" value={tail} onChange={(event) => setTail(Number(event.target.value))} disabled={logsLoading}><option value={50}>50 lines</option><option value={100}>100 lines</option><option value={250}>250 lines</option><option value={500}>500 lines</option></select>
                <button className="secondary-button" type="button" onClick={() => void refreshLogs()} disabled={!selectedId || logsLoading}>
                  {logsLoading ? 'Loading logs…' : logsLoaded ? 'Refresh logs' : 'Load recent logs'}
                </button>
              </div>
            </div>
            {logsView === 'loading' && <div className="monitoring-state" role="status"><span className="loading-indicator" /> Loading recent logs…</div>}
            {logsError && <div className="form-message error-message" role="alert">{logsError} <button className="text-button" type="button" onClick={() => void refreshLogs()}>Try again</button></div>}
            {logsView === 'error' && logsError && <div className="monitoring-state">Recent logs could not be loaded.</div>}
            {logsView === 'empty' && <div className="monitoring-state">No recent logs are available for this container.</div>}
            {logsView === 'ready' && <>
              {logsTruncated && <p className="monitoring-log-truncated" role="status">Earlier output was omitted to keep this view within its size limit.</p>}
              <ol className="monitoring-log-list">{logs.map((line, index) => <li key={`${index}-${line.stream}`}><span>{line.stream}</span><code>{line.text}</code></li>)}</ol>
            </>}
          </section>
        </>}
      </div>
    </details>
  );
}
