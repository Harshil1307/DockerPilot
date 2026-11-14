import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDockerOverview, type DockerOverview, type DockerStorageMetric } from '../lib/api';
import { dockerStoragePercent, formatDockerBytes } from '../lib/dockerOverview';
import { LocalAgentPanel } from './LocalAgentPanel';

function displayCount(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString();
}

function displayDate(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable';
}

function StorageRow({ label, metric, totalBytes }: { label: string; metric: DockerStorageMetric; totalBytes: number | null }) {
  const percent = dockerStoragePercent(metric.bytes, totalBytes);
  return <div className="host-storage-row">
    <div className="host-storage-copy"><span>{label}</span><strong>{formatDockerBytes(metric.bytes)}</strong><small className={`metric-quality quality-${metric.quality}`}>{metric.quality}</small></div>
    {percent !== null && <progress max="100" value={percent} aria-label={`${label}: ${percent.toFixed(0)}% of reported Docker storage`} />}
  </div>;
}

export function DockerOverviewPage() {
  const [overview, setOverview] = useState<DockerOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      setOverview(await fetchDockerOverview());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load Docker host overview.');
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const unavailable = overview?.daemon.status === 'unavailable';
  const statusLabel = !overview ? 'Checking Docker' : overview.daemon.status === 'connected' ? 'Connected' : overview.daemon.status === 'unavailable' ? 'Unavailable' : 'Error';

  return <main className="docker-overview-page">
    <div className="docker-overview-heading"><div><Link className="back-link" to="/">← Back to dashboard</Link><div className="eyebrow"><span className="eyebrow-line" /> LOCAL ENGINE</div><h1>Docker host overview</h1><p>Engine health, resource inventory, and read-only storage usage.</p></div><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh overview'}</button></div>

    {loading && !overview && <div className="state-panel" role="status"><span className="loading-indicator" /> Loading Docker host overview…</div>}
    {loadError && <div className="form-message error-message" role="alert">{loadError}{overview && <span> Showing the last collected data.</span>}</div>}

    {overview && <>
      {unavailable && <div className="host-daemon-unavailable" role="alert"><strong>Docker Engine unavailable</strong><span>{overview.daemon.message ?? 'Start Docker Desktop and refresh to load host data.'}</span></div>}
      <LocalAgentPanel localEngineReachable={overview.daemon.status === 'connected'} />
      {overview.daemon.status === 'error' && <div className="host-daemon-unavailable" role="alert"><strong>Docker status could not be checked</strong><span>{overview.daemon.message ?? 'Try refreshing the overview.'}</span></div>}
      {Object.keys(overview.errors).length > 0 && <section className="host-partial-warning" role="status"><strong>Some Docker metrics are unavailable.</strong><ul>{Object.entries(overview.errors).map(([key, message]) => <li key={key}><span>{key === 'storage' ? 'Storage' : key[0]!.toUpperCase() + key.slice(1)}:</span> {message}</li>)}</ul></section>}

      <section className="host-engine-card" aria-labelledby="host-engine-heading">
        <div className="host-engine-heading"><div><div className="eyebrow">DOCKER ENGINE</div><h2 id="host-engine-heading">Host status</h2></div><span className={`host-status-pill host-status-${overview.daemon.status}`} role="status"><span className="status-dot" aria-hidden="true" />{statusLabel}</span></div>
        <div className="host-engine-grid"><div><span>Engine version</span><strong>{overview.engine?.version ?? 'Unavailable'}</strong></div><div><span>API version</span><strong>{overview.engine?.apiVersion ?? 'Unavailable'}</strong></div><div><span>Operating system</span><strong>{overview.engine?.operatingSystem ?? 'Unavailable'}</strong></div><div><span>Architecture</span><strong>{overview.engine?.architecture ?? 'Unavailable'}</strong></div></div>
        <p className="host-refresh-time">Last successful refresh: <time dateTime={overview.lastSuccessfulRefreshAt ?? undefined}>{displayDate(overview.lastSuccessfulRefreshAt)}</time></p>
      </section>

      <section className="host-summary-grid" aria-label="Docker resource summaries">
        <article className="host-summary-card"><div className="card-label">CONTAINERS</div><strong>{displayCount(overview.containers.total)}</strong><div className="host-summary-breakdown"><span>Running {displayCount(overview.containers.running)}</span><span>Stopped {displayCount(overview.containers.stopped)}</span><span>Paused {displayCount(overview.containers.paused)}</span></div><Link to="/#docker-heading">View containers <span aria-hidden="true">→</span></Link></article>
        <article className="host-summary-card"><div className="card-label">IMAGES</div><strong>{displayCount(overview.images.total)}</strong><div className="host-summary-breakdown"><span>{formatDockerBytes(overview.storage.images.bytes)} stored</span></div><Link to="/images">Manage images <span aria-hidden="true">→</span></Link></article>
        <article className="host-summary-card"><div className="card-label">VOLUMES</div><strong>{displayCount(overview.volumes.total)}</strong><div className="host-summary-breakdown"><span>{displayCount(overview.volumes.inUse)} in use</span><span>{displayCount(overview.volumes.unused)} unused</span></div><Link to="/volumes">Manage volumes <span aria-hidden="true">→</span></Link></article>
        <article className="host-summary-card"><div className="card-label">NETWORKS</div><strong>{displayCount(overview.networks.total)}</strong><div className="host-summary-breakdown"><span>{displayCount(overview.networks.connected)} connected</span><span>{displayCount(overview.networks.unused)} unused</span></div><Link to="/networks">Manage networks <span aria-hidden="true">→</span></Link></article>
      </section>

      <section className="host-storage-card" aria-labelledby="host-storage-heading"><div className="host-section-heading"><div><div className="eyebrow">SYSTEM DISK USAGE</div><h2 id="host-storage-heading">Docker storage</h2><p>Read-only estimates reported by Docker Engine. Total is shown only when every category is available.</p></div><div className="host-storage-total"><span>TOTAL REPORTED</span><strong>{formatDockerBytes(overview.storage.total.bytes)}</strong><small className={`metric-quality quality-${overview.storage.total.quality}`}>{overview.storage.total.quality}</small></div></div>
        <div className="host-storage-list"><StorageRow label="Image layers (unique)" metric={overview.storage.images} totalBytes={overview.storage.total.bytes} /><StorageRow label="Container writable layers" metric={overview.storage.containerWritable} totalBytes={overview.storage.total.bytes} /><StorageRow label="Volumes" metric={overview.storage.volumes} totalBytes={overview.storage.total.bytes} /><StorageRow label="Build cache" metric={overview.storage.buildCache} totalBytes={overview.storage.total.bytes} /></div>
      </section>

      <div className="host-recent-grid"><section className="host-recent-card" aria-labelledby="host-recent-containers"><div className="host-section-heading"><div><div className="eyebrow">RECENT ACTIVITY</div><h2 id="host-recent-containers">Recently created containers</h2></div><Link to="/#docker-heading">View all</Link></div>{overview.containers.recent === null ? <p className="host-recent-empty">Container inventory is unavailable.</p> : overview.containers.recent.length === 0 ? <p className="host-recent-empty">No containers found.</p> : <ul>{overview.containers.recent.map((container) => <li key={container.id}><span><strong>{container.name}</strong><small>{container.image}</small></span><span className="host-recent-meta">{container.state}<small>{displayDate(container.createdAt)}</small></span></li>)}</ul>}</section>
        <section className="host-recent-card" aria-labelledby="host-recent-images"><div className="host-section-heading"><div><div className="eyebrow">RECENT ACTIVITY</div><h2 id="host-recent-images">Recently created images</h2></div><Link to="/images">View all</Link></div>{overview.images.recent === null ? <p className="host-recent-empty">Image inventory is unavailable.</p> : overview.images.recent.length === 0 ? <p className="host-recent-empty">No images found.</p> : <ul>{overview.images.recent.map((image) => <li key={image.id}><span><strong>{image.name}</strong><small>{image.id.slice(0, 19)}</small></span><span className="host-recent-meta">{displayDate(image.createdAt)}</span></li>)}</ul>}</section></div>
      <p className="host-collected-time">Collected {displayDate(overview.collectedAt)} · Refresh runs only when requested.</p>
    </>}
  </main>;
}
