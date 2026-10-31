import { useState } from 'react';
import {
  controlDockerContainer, getDockerContainerLogs, getDockerContainerMonitoring, inspectDockerContainer,
  type DockerContainer, type DockerContainerAction, type DockerContainerDetails, type DockerContainerMetrics, type DockerEngineStatus,
} from '../lib/api';

export function ContainerInventory({ status, containers, loading, error, onRefresh }: {
  status: DockerEngineStatus | null; containers: DockerContainer[]; loading: boolean; error: string | null; onRefresh: () => Promise<void>;
}) {
  const [activeOperation, setActiveOperation] = useState<{ id: string; action: DockerContainerAction } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'name' | 'created' | 'state'>('name');
  const [metrics, setMetrics] = useState<Record<string, DockerContainerMetrics>>({});
  const [metricsAt, setMetricsAt] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [selected, setSelected] = useState<DockerContainerDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ stream: 'stdout' | 'stderr'; text: string }[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsTruncated, setLogsTruncated] = useState(false);
  const [tail, setTail] = useState(100);
  const runningCount = containers.filter((item) => item.state === 'running').length;
  const stoppedCount = containers.filter((item) => ['created', 'exited', 'dead'].includes(item.state)).length;
  const visible = containers.filter((container) => (stateFilter === 'all' || container.state === stateFilter)
    && `${container.name} ${container.id}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sortBy === 'name' ? a.name.localeCompare(b.name) : sortBy === 'created'
      ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : a.state.localeCompare(b.state) || a.name.localeCompare(b.name));

  async function refreshMetrics() {
    setNotice(null);
    setMetricsLoading(true);
    try {
      const result = await getDockerContainerMonitoring();
      setMetrics(Object.fromEntries(result.containers.map((item) => [item.id, item.metrics])));
      setMetricsAt(result.sampledAt);
    } catch (cause) { setNotice({ text: cause instanceof Error ? cause.message : 'Container metrics are unavailable.', error: true }); }
    finally { setMetricsLoading(false); }
  }

  async function openDetails(container: DockerContainer) {
    setSelected(null); setDetailLoading(true); setDetailError(null); setLogs([]); setLogsError(null); setLogsLoaded(false);
    try { setSelected(await inspectDockerContainer(container.id)); }
    catch (cause) { setDetailError(cause instanceof Error ? cause.message : 'Could not load container details.'); }
    finally { setDetailLoading(false); }
  }

  async function refreshLogs() {
    if (!selected) return;
    setLogsLoading(true); setLogsError(null);
    try { const result = await getDockerContainerLogs(selected.id, tail); setLogs(result.lines); setLogsTruncated(result.truncated); setLogsLoaded(true); }
    catch (cause) { setLogsError(cause instanceof Error ? cause.message : 'Could not load container logs.'); }
    finally { setLogsLoading(false); }
  }

  async function runOperation(container: DockerContainer, action: DockerContainerAction) {
    setActiveOperation({ id: container.id, action }); setNotice(null);
    try {
      await controlDockerContainer(container.id, action);
      setNotice({ text: `${container.name} ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'} successfully.`, error: false });
    } catch (cause) { setNotice({ text: cause instanceof Error ? cause.message : `Could not ${action} ${container.name}.`, error: true }); }
    finally { await onRefresh(); setActiveOperation(null); }
  }

  return <section className="docker-section" aria-labelledby="docker-heading">
    <div className="section-heading docker-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> LOCAL ENGINE</div><h2 id="docker-heading">Docker containers</h2>{status?.reachable && status.engine && <p className="docker-engine-meta">Engine {status.engine.version} · API {status.engine.apiVersion} · {status.engine.operatingSystem} / {status.engine.architecture}</p>}</div><span className={`docker-connection connection-${status === null ? 'pending' : status.reachable ? 'online' : 'offline'}`} role="status"><span className="status-dot" />{status === null ? 'Checking Docker' : status.reachable ? 'Docker connected' : 'Docker unavailable'}</span>
      <button className="secondary-button refresh-button" type="button" onClick={() => void onRefresh()} disabled={loading || activeOperation !== null} aria-label="Refresh Docker data">{loading ? 'Refreshing…' : 'Refresh'}<span aria-hidden="true"> ↻</span></button></div>
    <div className="docker-summary-grid" aria-label="Container counts"><article className="docker-summary-card"><span>TOTAL CONTAINERS</span><strong>{loading ? '…' : containers.length}</strong></article><article className="docker-summary-card"><span>RUNNING</span><strong className="count-running">{loading ? '…' : runningCount}</strong></article><article className="docker-summary-card"><span>STOPPED</span><strong className="count-stopped">{loading ? '…' : stoppedCount}</strong></article></div>
    {notice && <div className={`operation-notice ${notice.error ? 'operation-failure' : 'operation-success'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
    <div className="container-inventory-controls"><label>Search<input aria-label="Search containers" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or ID" /></label><label>State<select aria-label="Filter containers by state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="all">All states</option>{[...new Set(containers.map((item) => item.state))].sort().map((state) => <option key={state}>{state}</option>)}</select></label><label>Sort by<select aria-label="Sort containers" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}><option value="name">Name</option><option value="created">Creation time</option><option value="state">State</option></select></label><button className="secondary-button" type="button" onClick={() => void refreshMetrics()} disabled={loading || metricsLoading || !!error}>{metricsLoading ? 'Collecting metrics…' : 'Refresh metrics'}</button>{metricsAt && <span className="muted-value">Sampled {new Date(metricsAt).toLocaleTimeString()}</span>}</div>
    {loading ? <div className="state-panel" role="status"><span className="loading-indicator" /> Loading Docker containers…</div>
      : error ? <div className="state-panel docker-error-panel" role="alert"><span className="docker-error-mark">!</span><div><h3>Docker is unavailable</h3><p>{error}</p></div></div>
      : containers.length === 0 ? <div className="state-panel empty-state docker-empty"><div className="empty-icon">▱</div><h3>No containers found</h3><p>Docker Engine is connected, but it has no containers to show.</p></div>
      : <div className="container-table-wrap"><table className="container-table"><thead><tr><th>CONTAINER</th><th>IMAGE</th><th>STATE</th><th>CREATED</th><th>PUBLISHED PORTS</th><th>CPU / MEMORY</th><th>CONTROLS</th></tr></thead><tbody>{visible.map((container) => {
        const currentMetrics = metrics[container.id];
        const stateClass = container.state === 'running' ? 'running' : container.state === 'paused' ? 'paused' : 'stopped';
        return <tr key={container.id}><td><span className="container-name">{container.name}</span><span className="container-id">{container.id}</span><span className={`container-ownership ${container.managedByCurrentUser ? 'ownership-managed' : container.managed ? 'ownership-other' : 'ownership-readonly'}`}>{container.managedByCurrentUser ? 'DockerPilot managed' : container.managed ? 'Managed by another user' : 'Read-only · external'}</span></td>
          <td className="container-image" title={container.image}>{container.image}</td><td><span className={`container-state state-${stateClass}`}><span className="status-dot" />{container.state}</span><span className="container-status">{container.status}</span></td><td className="container-created">{new Date(container.createdAt).toLocaleString()}</td><td className="container-ports">{container.publishedPorts.length ? container.publishedPorts.map((port) => <span className="port-chip" key={port}>{port}</span>) : <span className="muted-value">—</span>}</td>
          <td className="container-metrics">{!currentMetrics ? <span className="muted-value">Unavailable · refresh metrics</span> : <>{currentMetrics.cpuPercent === null ? 'CPU unavailable' : `CPU ${currentMetrics.cpuPercent.toFixed(1)}%`}<span>{currentMetrics.memoryUsageBytes === null ? 'Memory unavailable' : `${(currentMetrics.memoryUsageBytes / 1048576).toFixed(1)} MiB${currentMetrics.memoryLimitBytes === null ? '' : ` / ${(currentMetrics.memoryLimitBytes / 1048576).toFixed(1)} MiB (${currentMetrics.memoryPercent === null ? 'percentage unavailable' : `${currentMetrics.memoryPercent.toFixed(1)}%`})`}`}</span></>}</td>
          <td><div className="container-actions"><button className="secondary-button" type="button" onClick={() => void openDetails(container)}>Details &amp; logs</button>{container.managedByCurrentUser ? <div className="container-control-buttons">{container.state === 'running' ? <><button className="control-button control-stop" type="button" disabled={activeOperation !== null || loading} onClick={() => { if (window.confirm(`Stop ${container.name}?`)) void runOperation(container, 'stop'); }}>{activeOperation?.id === container.id && activeOperation.action === 'stop' ? 'Stopping…' : 'Stop'}</button><button className="control-button control-restart" type="button" disabled={activeOperation !== null || loading} onClick={() => { if (window.confirm(`Restart ${container.name}?`)) void runOperation(container, 'restart'); }}>{activeOperation?.id === container.id && activeOperation.action === 'restart' ? 'Restarting…' : 'Restart'}</button></> : ['created', 'exited'].includes(container.state) ? <button className="control-button control-start" type="button" disabled={activeOperation !== null || loading} onClick={() => { if (window.confirm(`Start ${container.name}?`)) void runOperation(container, 'start'); }}>{activeOperation?.id === container.id && activeOperation.action === 'start' ? 'Starting…' : 'Start'}</button> : <span className="muted-value">Unavailable</span>}</div> : <span className="readonly-indicator">Read only</span>}</div></td></tr>;
      })}</tbody></table>{visible.length === 0 && <div className="monitoring-state">No containers match this search and state.</div>}</div>}
    {(detailLoading || detailError || selected) && <section className="container-detail-panel" aria-label="Container details"><div className="detail-panel-heading"><h3>{detailLoading ? 'Loading container details…' : selected?.name ?? 'Container details'}</h3><button className="text-button" type="button" onClick={() => setSelected(null)}>Close</button></div>{detailError && <p role="alert">{detailError}</p>}{selected && <>
      <div className="container-detail-grid"><span>Full ID<code>{selected.id}</code></span><span>Image<code>{selected.image}</code></span><span>State / health<code>{selected.state}{selected.health ? ` · ${selected.health}` : ''}</code></span><span>Created / started<code>{selected.createdAt ? new Date(selected.createdAt).toLocaleString() : 'Unavailable'} · {selected.startedAt ? new Date(selected.startedAt).toLocaleString() : 'Not started'}</code></span><span>Restart policy<code>{selected.restartPolicy.name}{selected.restartPolicy.maximumRetryCount ? ` (${selected.restartPolicy.maximumRetryCount} retries)` : ''}</code></span><span>CPU / memory limits<code>{selected.cpuLimitCores === null ? 'CPU unlimited / unavailable' : `${selected.cpuLimitCores} cores`} · {selected.memoryLimitBytes === null ? 'Memory unlimited / unavailable' : `${(selected.memoryLimitBytes / 1048576).toFixed(1)} MiB`}</code></span><span>Current resource use<code>{metrics[selected.id.slice(0, 12)] ? `${metrics[selected.id.slice(0, 12)]!.cpuPercent === null ? 'CPU unavailable' : `CPU ${metrics[selected.id.slice(0, 12)]!.cpuPercent!.toFixed(1)}%`} · ${metrics[selected.id.slice(0, 12)]!.memoryUsageBytes === null ? 'Memory unavailable' : `${(metrics[selected.id.slice(0, 12)]!.memoryUsageBytes! / 1048576).toFixed(1)} MiB`}` : 'Unavailable · refresh metrics from inventory'}</code></span><span>Networks<code>{selected.networks.map((network) => network.name).join(', ') || 'None'}</code></span><span>Mounts<code>{selected.mounts.map((mount) => `${mount.name ?? mount.type}: ${mount.destination}${mount.readOnly ? ' (read only)' : ''}`).join(', ') || 'None'}</code></span><span>Ports<code>{selected.publishedPorts.join(', ') || 'None'}</code></span></div>
      <section className="container-logs"><div className="monitoring-logs-heading"><div><h4>Recent logs</h4><p>Best-effort credential redaction · maximum 64 KB.</p></div><div className="monitoring-log-controls"><label>Lines<select aria-label="Log tail size" value={tail} onChange={(event) => setTail(Number(event.target.value))}><option value={50}>50</option><option value={100}>100</option><option value={250}>250</option><option value={500}>500</option></select></label><button className="secondary-button" type="button" disabled={logsLoading} onClick={() => void refreshLogs()}>{logsLoading ? 'Loading…' : logsLoaded ? 'Refresh logs' : 'Load recent logs'}</button></div></div>{logsError && <p role="alert">{logsError}</p>}{logsTruncated && <p className="monitoring-log-truncated">Earlier output omitted to fit the response limit.</p>}{logsLoaded && logs.length === 0 && <p className="muted-value">No log output is available for this container.</p>}{logs.length > 0 && <ol className="monitoring-log-list">{logs.map((line, index) => <li key={`${index}-${line.stream}`}><span>{line.stream}</span><code>{line.text}</code></li>)}</ol>}</section>
    </>}</section>}
  </section>;
}
