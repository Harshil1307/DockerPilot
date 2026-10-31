import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  createDockerVolume,
  inspectDockerVolume,
  listDockerVolumes,
  removeDockerVolume,
  type DockerVolume,
  type DockerVolumeDetails,
} from '../lib/api';
import { filterAndSortDockerVolumes, formatVolumeCreatedAt, type DockerVolumeSort } from '../lib/volumes';

export function VolumeManagementPage() {
  const [volumes, setVolumes] = useState<DockerVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<DockerVolumeSort>('name');
  const [selected, setSelected] = useState<DockerVolumeDetails | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshVolumes = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setVolumes(await listDockerVolumes());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load Docker volumes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshVolumes(); }, [refreshVolumes]);
  const visibleVolumes = useMemo(() => filterAndSortDockerVolumes(volumes, query, sort), [volumes, query, sort]);

  async function handleInspect(volume: DockerVolume) {
    setInspectionLoading(true);
    setInspectionError(null);
    setSelected(null);
    try {
      setSelected(await inspectDockerVolume(volume.name));
    } catch (error) {
      setInspectionError(error instanceof Error ? error.message : 'Could not inspect this volume.');
    } finally {
      setInspectionLoading(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const volumeName = name.trim();
    if (!volumeName || creating) return;
    setCreating(true);
    setNotice(null);
    setLoadError(null);
    try {
      await createDockerVolume(volumeName);
      setName('');
      setNotice(`Volume ${volumeName} created successfully.`);
      await refreshVolumes();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not create this volume.');
    } finally {
      setCreating(false);
    }
  }

  async function handleRemove(volume: DockerVolume) {
    if (volume.inUse || volume.protected || removingName) return;
    const accepted = window.confirm(`Remove Docker volume “${volume.name}”? This permanently removes data stored in this volume. DockerPilot will only remove this exact, unused volume and will not force removal.`);
    if (!accepted) return;
    setRemovingName(volume.name);
    setNotice(null);
    setLoadError(null);
    try {
      await removeDockerVolume(volume.name, volume.name);
      setNotice(`Volume ${volume.name} removed.`);
      if (selected?.name === volume.name) setSelected(null);
      await refreshVolumes();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not remove this volume.');
    } finally {
      setRemovingName(null);
    }
  }

  return (
    <main className="image-page volume-page">
      <Link className="back-link" to="/">← Back to dashboard</Link>
      <div className="image-page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> LOCAL ENGINE</div><h1>Docker volumes</h1><p>Inspect and manage named volumes available in your local Docker Engine.</p></div>
        <button className="secondary-button" type="button" onClick={() => void refreshVolumes()} disabled={loading || creating || removingName !== null}>Refresh inventory</button>
      </div>

      <section className="image-pull-panel volume-create-panel" aria-labelledby="create-volume-heading">
        <div><div className="eyebrow">LOCAL STORAGE</div><h2 id="create-volume-heading">Create a volume</h2><p>Creates a named volume with Docker’s default local driver. Driver options are not accepted.</p></div>
        <form onSubmit={(event) => void handleCreate(event)}>
          <label htmlFor="volume-name">Volume name</label>
          <div className="image-pull-controls"><input id="volume-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="project_data" maxLength={255} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,254}" required disabled={creating} /><button className="primary-button" type="submit" disabled={creating || !name.trim()}>{creating ? 'Creating…' : 'Create volume'}</button></div>
        </form>
        {notice && <div className="form-message success-message" role="status">{notice}</div>}
      </section>

      {loadError && <div className="form-message error-message" role="alert">{loadError} <button className="text-button" type="button" onClick={() => void refreshVolumes()}>Try again</button></div>}
      <section className="image-inventory" aria-labelledby="volume-inventory-heading">
        <div className="image-inventory-heading"><div><div className="eyebrow">LOCAL STORAGE</div><h2 id="volume-inventory-heading">Volume inventory <span>{loading ? '…' : volumes.length}</span></h2></div><div className="image-filters"><label><span className="visually-hidden">Search volumes by name</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search volume name" /></label><label><span className="visually-hidden">Sort volumes</span><select value={sort} onChange={(event) => setSort(event.target.value as DockerVolumeSort)}><option value="name">Name A–Z</option><option value="driver">Driver A–Z</option><option value="created">Newest first</option></select></label></div></div>
        {loading ? <div className="state-panel" role="status"><span className="loading-indicator" /> Loading Docker volumes…</div>
          : !loadError && visibleVolumes.length === 0 ? <div className="state-panel empty-state"><div className="empty-icon" aria-hidden="true">▱</div><h3>{volumes.length ? 'No matching volumes' : 'No local volumes found'}</h3><p>{volumes.length ? 'Try a different volume name.' : 'Create a named volume to see it here.'}</p></div>
            : visibleVolumes.length > 0 && <div className="image-table-wrap"><table className="image-table volume-table"><thead><tr><th scope="col">VOLUME</th><th scope="col">DRIVER</th><th scope="col">CREATED</th><th scope="col">CONTAINERS</th><th scope="col">STATUS</th><th scope="col">ACTIONS</th></tr></thead><tbody>{visibleVolumes.map((volume) => <tr key={volume.name}>
              <td className="volume-name-cell"><strong>{volume.name}</strong><small>{volume.mountpoint || 'Mountpoint unavailable'}</small></td>
              <td>{volume.driver}</td><td>{formatVolumeCreatedAt(volume.createdAt)}</td>
              <td>{volume.containerCount}{volume.inUse && <small className="image-safety-note">Stopped containers count too.</small>}</td>
              <td><span className={`volume-usage ${volume.inUse ? 'volume-in-use' : 'volume-unused'}`}>{volume.inUse ? 'In use' : 'Unused'}</span>{volume.protected && <small className="image-safety-note">Infrastructure protected</small>}</td>
              <td><div className="image-actions"><button className="secondary-button" type="button" onClick={() => void handleInspect(volume)} disabled={inspectionLoading}>Inspect</button><button className="danger-button" type="button" onClick={() => void handleRemove(volume)} disabled={removingName !== null || volume.inUse || volume.protected} title={volume.protected ? 'DockerPilot infrastructure volumes cannot be removed.' : volume.inUse ? 'Running or stopped containers reference this volume.' : undefined}>{removingName === volume.name ? 'Removing…' : volume.protected ? 'Protected' : volume.inUse ? 'In use' : 'Remove'}</button></div></td>
            </tr>)}</tbody></table></div>}
      </section>

      {inspectionError && <div className="form-message error-message" role="alert">{inspectionError}</div>}
      {inspectionLoading && <div className="state-panel" role="status"><span className="loading-indicator" /> Inspecting volume…</div>}
      {selected && <section className="image-details-panel" aria-labelledby="volume-details-heading"><div className="image-details-heading"><div><div className="eyebrow">VOLUME DETAILS</div><h2 id="volume-details-heading">{selected.name}</h2></div><button className="secondary-button" type="button" onClick={() => setSelected(null)}>Close details</button></div><dl>
        <div><dt>Name</dt><dd>{selected.name}</dd></div><div><dt>Driver</dt><dd>{selected.driver}</dd></div><div><dt>Mountpoint</dt><dd><code>{selected.mountpoint || 'Unavailable'}</code></dd></div><div><dt>Created</dt><dd>{formatVolumeCreatedAt(selected.createdAt)}</dd></div><div><dt>Scope</dt><dd>{selected.scope}</dd></div><div><dt>Usage</dt><dd>{selected.inUse ? `In use by ${selected.containerCount} container${selected.containerCount === 1 ? '' : 's'}` : 'Unused'}</dd></div>
        <div className="volume-labels"><dt>Safe labels</dt><dd>{Object.entries(selected.labels).length ? Object.entries(selected.labels).map(([key, value]) => <span key={key}><code>{key}</code>: {value}</span>) : 'None'}</dd></div>
        <div className="volume-references"><dt>Referencing containers</dt><dd>{selected.containers.length ? selected.containers.map((container) => <span className="volume-reference" key={`${container.id}-${container.name}`}><strong>{container.name}</strong><code>{container.id}</code><span className={`volume-usage ${container.state.toLowerCase() === 'running' ? 'volume-in-use' : 'volume-unused'}`}>{container.state}</span></span>) : 'None'}</dd></div>
      </dl><p className="image-detail-safety">Container environment variables and unrelated labels are not displayed.</p></section>}
    </main>
  );
}
