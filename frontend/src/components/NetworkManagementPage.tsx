import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  createDockerNetwork,
  inspectDockerNetwork,
  listDockerNetworks,
  removeDockerNetwork,
  type DockerNetwork,
  type DockerNetworkDetails,
} from '../lib/api';
import { filterAndSortDockerNetworks, formatNetworkCreatedAt, type DockerNetworkSort } from '../lib/networks';

export function NetworkManagementPage() {
  const [networks, setNetworks] = useState<DockerNetwork[]>([]);
  const [ipv6Supported, setIpv6Supported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [sort, setSort] = useState<DockerNetworkSort>('name');
  const [name, setName] = useState('');
  const [internal, setInternal] = useState(false);
  const [enableIPv6, setEnableIPv6] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<DockerNetworkDetails | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshNetworks = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const inventory = await listDockerNetworks();
      setNetworks(inventory.networks);
      setIpv6Supported(inventory.ipv6Supported);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load Docker networks.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshNetworks(); }, [refreshNetworks]);
  const drivers = useMemo(() => [...new Set(networks.map((network) => network.driver))].sort(), [networks]);
  const visibleNetworks = useMemo(() => filterAndSortDockerNetworks(networks, query, driverFilter, sort), [networks, query, driverFilter, sort]);

  async function handleInspect(network: DockerNetwork) {
    setInspectionLoading(true);
    setInspectionError(null);
    setSelected(null);
    try {
      setSelected(await inspectDockerNetwork(network.id));
    } catch (error) {
      setInspectionError(error instanceof Error ? error.message : 'Could not inspect this network.');
    } finally {
      setInspectionLoading(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const networkName = name.trim();
    if (!networkName || creating) return;
    setCreating(true);
    setNotice(null);
    setLoadError(null);
    try {
      await createDockerNetwork({ name: networkName, internal, enableIPv6 });
      setName('');
      setInternal(false);
      setEnableIPv6(false);
      setNotice(`Network ${networkName} created successfully.`);
      await refreshNetworks();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not create this network.');
    } finally {
      setCreating(false);
    }
  }

  async function handleRemove(network: DockerNetwork) {
    if (network.containerCount || network.protected || removingId) return;
    const accepted = window.confirm(`Remove network “${network.name}” (${network.id})? DockerPilot will remove only this exact network after confirming it has no connected containers. It will not disconnect containers or force removal.`);
    if (!accepted) return;
    setRemovingId(network.id);
    setNotice(null);
    setLoadError(null);
    try {
      await removeDockerNetwork(network.id, network.name);
      setNotice(`Network ${network.name} removed.`);
      if (selected?.id === network.id) setSelected(null);
      await refreshNetworks();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not safely remove this network.');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <main className="image-page network-page">
      <Link className="back-link" to="/">← Back to dashboard</Link>
      <div className="image-page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> LOCAL ENGINE</div><h1>Docker networks</h1><p>Inspect and manage networks available in your local Docker Engine.</p></div>
        <button className="secondary-button" type="button" onClick={() => void refreshNetworks()} disabled={loading || creating || removingId !== null}>Refresh inventory</button>
      </div>

      <section className="image-pull-panel network-create-panel" aria-labelledby="create-network-heading">
        <div><div className="eyebrow">LOCAL ENGINE</div><h2 id="create-network-heading">Create a network</h2><p>Creates a standard bridge network. IPv6 is available only when the Docker Engine reports support.</p></div>
        <form onSubmit={(event) => void handleCreate(event)}>
          <label htmlFor="network-name">Network name</label>
          <div className="image-pull-controls"><input id="network-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="project_network" maxLength={255} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,254}" required disabled={creating} /><button className="primary-button" type="submit" disabled={creating || !name.trim()}>{creating ? 'Creating…' : 'Create network'}</button></div>
          <div className="network-create-options"><label><input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} disabled={creating} /> Internal network</label><label title={ipv6Supported ? undefined : 'IPv6 is not reported as supported by the current Docker Engine.'}><input type="checkbox" checked={enableIPv6} onChange={(event) => setEnableIPv6(event.target.checked)} disabled={creating || !ipv6Supported} /> Enable IPv6</label></div>
        </form>
        {notice && <div className="form-message success-message" role="status">{notice}</div>}
      </section>

      {loadError && <div className="form-message error-message" role="alert">{loadError} <button className="text-button" type="button" onClick={() => void refreshNetworks()}>Try again</button></div>}
      <section className="image-inventory" aria-labelledby="network-inventory-heading">
        <div className="image-inventory-heading"><div><div className="eyebrow">LOCAL ENGINE</div><h2 id="network-inventory-heading">Network inventory <span>{loading ? '…' : networks.length}</span></h2></div><div className="image-filters network-filters"><label><span className="visually-hidden">Search networks by name or ID</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or ID" /></label><label><span className="visually-hidden">Filter networks by driver</span><select value={driverFilter} onChange={(event) => setDriverFilter(event.target.value)}><option value="">All drivers</option>{drivers.map((driver) => <option key={driver} value={driver}>{driver}</option>)}</select></label><label><span className="visually-hidden">Sort networks</span><select value={sort} onChange={(event) => setSort(event.target.value as DockerNetworkSort)}><option value="name">Name A–Z</option><option value="driver">Driver A–Z</option><option value="created">Newest first</option></select></label></div></div>
        {loading ? <div className="state-panel" role="status"><span className="loading-indicator" /> Loading Docker networks…</div>
          : !loadError && visibleNetworks.length === 0 ? <div className="state-panel empty-state"><div className="empty-icon" aria-hidden="true">▱</div><h3>{networks.length ? 'No matching networks' : 'No local networks found'}</h3><p>{networks.length ? 'Try a different name, ID, or driver filter.' : 'Create a bridge network to see it here.'}</p></div>
            : visibleNetworks.length > 0 && <div className="image-table-wrap"><table className="image-table network-table"><thead><tr><th scope="col">NETWORK</th><th scope="col">DRIVER / SCOPE</th><th scope="col">SETTINGS</th><th scope="col">CONTAINERS</th><th scope="col">CREATED</th><th scope="col">ACTIONS</th></tr></thead><tbody>{visibleNetworks.map((network) => <tr key={network.id}>
              <td className="network-name-cell"><strong>{network.name}</strong><code title={network.id}>{network.shortId}</code></td>
              <td>{network.driver}<small className="network-scope">{network.scope}</small></td>
              <td><div className="network-settings"><span>{network.internal ? 'Internal' : 'External'}</span><span>{network.enableIPv6 ? 'IPv6 on' : 'IPv6 off'}</span></div></td>
              <td>{network.containerCount}<small className="network-container-status">{network.containerCount ? 'In use' : 'Unused'}</small></td>
              <td>{formatNetworkCreatedAt(network.createdAt)}</td>
              <td><div className="image-actions"><button className="secondary-button" type="button" onClick={() => void handleInspect(network)} disabled={inspectionLoading}>Inspect</button><button className="danger-button" type="button" onClick={() => void handleRemove(network)} disabled={removingId !== null || network.containerCount > 0 || network.protected} title={network.protected ? 'DockerPilot and Docker system networks are protected.' : network.containerCount > 0 ? 'Containers are still connected to this network.' : undefined}>{removingId === network.id ? 'Removing…' : network.protected ? 'Protected' : network.containerCount > 0 ? 'In use' : 'Remove'}</button></div></td>
            </tr>)}</tbody></table></div>}
      </section>

      {inspectionError && <div className="form-message error-message" role="alert">{inspectionError}</div>}
      {inspectionLoading && <div className="state-panel" role="status"><span className="loading-indicator" /> Inspecting network…</div>}
      {selected && <section className="image-details-panel" aria-labelledby="network-details-heading"><div className="image-details-heading"><div><div className="eyebrow">NETWORK DETAILS</div><h2 id="network-details-heading">{selected.name}</h2></div><button className="secondary-button" type="button" onClick={() => setSelected(null)}>Close details</button></div><dl>
        <div><dt>Full network ID</dt><dd><code>{selected.id}</code></dd></div><div><dt>Name</dt><dd>{selected.name}</dd></div><div><dt>Driver and scope</dt><dd>{selected.driver} · {selected.scope}</dd></div><div><dt>Network settings</dt><dd>{selected.internal ? 'Internal' : 'External'} · IPv6 {selected.enableIPv6 ? 'enabled' : 'disabled'}</dd></div>
        <div className="network-subnets"><dt>Subnets and gateways</dt><dd>{selected.subnets.length ? selected.subnets.map((entry, index) => <span key={`${entry.subnet}-${index}`}>{entry.subnet || 'Subnet unavailable'} · gateway {entry.gateway || 'unavailable'}</span>) : 'Unavailable'}</dd></div>
        <div className="network-labels"><dt>Safe labels</dt><dd>{Object.entries(selected.labels).length ? Object.entries(selected.labels).map(([key, value]) => <span key={key}><code>{key}</code>: {value}</span>) : 'None'}</dd></div>
        <div className="network-containers"><dt>Connected containers ({selected.containers.length})</dt><dd>{selected.containers.length ? selected.containers.map((container) => <span className="network-container-reference" key={container.id}><strong>{container.name}</strong><code>{container.id}</code><span>{container.state ?? 'State unavailable'}</span></span>) : 'No containers are connected to this network.'}</dd></div>
      </dl><p className="image-detail-safety">Container environment variables and unrelated Docker metadata are not displayed.</p></section>}
      {!loading && !loadError && <span className="visually-hidden" aria-label={`IPv6 ${ipv6Supported ? 'supported' : 'unsupported'}`} />}
    </main>
  );
}
