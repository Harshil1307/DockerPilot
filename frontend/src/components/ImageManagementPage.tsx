import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  inspectDockerImage,
  listDockerImages,
  pullDockerImage,
  removeDockerImage,
  type DockerImage,
  type DockerImageInspection,
  type DockerImagePullProgress,
} from '../lib/api';
import { dockerImageName, filterAndSortDockerImages, formatImageSize, type DockerImageSort } from '../lib/images';

function formatCreatedAt(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable';
}

export function ImageManagementPage() {
  const [images, setImages] = useState<DockerImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<DockerImageSort>('name');
  const [selected, setSelected] = useState<DockerImageInspection | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<DockerImagePullProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refreshImages = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setImages(await listDockerImages());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load Docker images.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshImages(); }, [refreshImages]);

  const visibleImages = useMemo(() => filterAndSortDockerImages(images, query, sort), [images, query, sort]);

  async function handleInspect(image: DockerImage) {
    setInspectionLoading(true);
    setInspectionError(null);
    setSelected(null);
    try {
      setSelected(await inspectDockerImage(image.id));
    } catch (error) {
      setInspectionError(error instanceof Error ? error.message : 'Could not inspect this image.');
    } finally {
      setInspectionLoading(false);
    }
  }

  async function handlePull(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const imageReference = reference.trim();
    if (!imageReference || pulling) return;
    setPulling(true);
    setPullProgress({ status: `Starting pull for ${imageReference}` });
    setNotice(null);
    setPullError(null);
    try {
      await pullDockerImage(imageReference, setPullProgress);
      setReference('');
      setNotice(`Image ${imageReference} pulled successfully.`);
      setPullProgress(null);
      await refreshImages();
    } catch (error) {
      setPullError(error instanceof Error ? error.message : 'Could not pull this image.');
    } finally {
      setPulling(false);
    }
  }

  async function handleRemove(image: DockerImage) {
    const name = image.repositoryTags.length ? image.repositoryTags.join(', ') : '<none>:<none>';
    if (image.containerCount > 0 || image.protected || removingId) return;
    if (!window.confirm(`Remove ${name} (${image.id})? This removes only the selected image and will never force removal.`)) return;
    setRemovingId(image.id);
    setNotice(null);
    setLoadError(null);
    try {
      await removeDockerImage(image.id);
      setNotice(`Image ${name} removed.`);
      if (selected?.id === image.id) setSelected(null);
      await refreshImages();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not remove this image.');
    } finally {
      setRemovingId(null);
    }
  }

  const progressPercent = pullProgress?.total && pullProgress.total > 0 && pullProgress.current !== undefined
    ? Math.min(100, Math.round((pullProgress.current / pullProgress.total) * 100))
    : null;

  return (
    <main className="image-page">
      <Link className="back-link" to="/">← Back to dashboard</Link>
      <div className="image-page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> LOCAL ENGINE</div><h1>Docker images</h1><p>Inspect and manage images available in your local Docker Engine.</p></div>
        <button className="secondary-button" type="button" onClick={() => void refreshImages()} disabled={loading || pulling}>Refresh inventory</button>
      </div>

      <section className="image-pull-panel" aria-labelledby="pull-image-heading">
        <div><div className="eyebrow">REGISTRY</div><h2 id="pull-image-heading">Pull an image</h2><p>Enter a repository and optional tag; omitted tags use latest. Registry credentials are not stored.</p></div>
        <form onSubmit={(event) => void handlePull(event)}>
          <label htmlFor="image-reference">Repository and tag</label>
          <div className="image-pull-controls"><input id="image-reference" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="nginx:alpine" maxLength={300} required disabled={pulling} /><button className="primary-button" type="submit" disabled={pulling || !reference.trim()}>{pulling ? 'Pulling…' : 'Pull image'}</button></div>
        </form>
        {pulling && pullProgress && <div className="image-pull-progress" role="status" aria-live="polite"><div className="image-progress-copy"><span>{pullProgress.id ? `${pullProgress.id}: ` : ''}{pullProgress.status}</span>{progressPercent !== null && <span>{progressPercent}%</span>}</div><progress max="100" value={progressPercent ?? undefined} aria-label="Image pull progress" /></div>}
        {pullError && <div className="form-message error-message" role="alert">{pullError}</div>}
        {notice && <div className="form-message success-message" role="status">{notice}</div>}
      </section>

      <section className="image-inventory" aria-labelledby="image-inventory-heading">
        <div className="image-inventory-heading"><div><div className="eyebrow">LOCAL STORAGE</div><h2 id="image-inventory-heading">Image inventory <span>{loading ? '…' : images.length}</span></h2></div><div className="image-filters"><label><span className="visually-hidden">Search by repository or tag</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repository or tag" /></label><label><span className="visually-hidden">Sort images</span><select value={sort} onChange={(event) => setSort(event.target.value as DockerImageSort)}><option value="name">Name A–Z</option><option value="size">Largest size</option><option value="created">Newest first</option></select></label></div></div>
        {loadError && <div className="form-message error-message" role="alert">{loadError} <button className="text-button" type="button" onClick={() => void refreshImages()}>Try again</button></div>}
        {loading ? <div className="state-panel" role="status"><span className="loading-indicator" /> Loading Docker images…</div>
          : !loadError && visibleImages.length === 0 ? <div className="state-panel empty-state"><div className="empty-icon" aria-hidden="true">▱</div><h3>{images.length ? 'No matching images' : 'No local images found'}</h3><p>{images.length ? 'Try a different repository or tag.' : 'Pull an image to make it available in Docker.'}</p></div>
            : visibleImages.length > 0 && <div className="image-table-wrap"><table className="image-table"><thead><tr><th scope="col">REPOSITORY / TAG</th><th scope="col">IMAGE ID</th><th scope="col">SIZE</th><th scope="col">CREATED</th><th scope="col">CONTAINERS</th><th scope="col">ACTIONS</th></tr></thead><tbody>{visibleImages.map((image) => <tr key={image.id}>
              <td className="image-tags">{image.repositoryTags.length ? image.repositoryTags.map((tag) => <span key={tag}>{tag}</span>) : <span className="muted-value">&lt;none&gt;:&lt;none&gt;</span>}{image.protected && <small>DockerPilot protected</small>}</td>
              <td><code>{image.id}</code></td><td>{formatImageSize(image.sizeBytes)}</td><td>{formatCreatedAt(image.createdAt)}</td><td>{image.containerCount}{image.containerCount > 0 && <small className="image-safety-note">Remove referencing containers first.</small>}{image.protected && <small className="image-safety-note">Infrastructure image cannot be removed.</small>}</td>
              <td><div className="image-actions"><button className="secondary-button" type="button" onClick={() => void handleInspect(image)} disabled={inspectionLoading}>Inspect</button><button className="danger-button" type="button" onClick={() => void handleRemove(image)} disabled={removingId !== null || image.containerCount > 0 || image.protected} title={image.protected ? 'DockerPilot infrastructure images are protected.' : image.containerCount > 0 ? 'Containers still reference this image.' : undefined}>{removingId === image.id ? 'Removing…' : image.protected ? 'Protected' : image.containerCount > 0 ? 'In use' : 'Remove'}</button></div></td>
            </tr>)}</tbody></table></div>}
      </section>

      {inspectionError && <div className="form-message error-message" role="alert">{inspectionError}</div>}
      {inspectionLoading && <div className="state-panel" role="status"><span className="loading-indicator" /> Inspecting image…</div>}
      {selected && <section className="image-details-panel" aria-labelledby="image-details-heading"><div className="image-details-heading"><div><div className="eyebrow">IMAGE DETAILS</div><h2 id="image-details-heading">{dockerImageName(selected)}</h2></div><button className="secondary-button" type="button" onClick={() => setSelected(null)}>Close details</button></div><dl>
        <div><dt>Full image ID</dt><dd><code>{selected.id}</code></dd></div><div><dt>Repository and tags</dt><dd>{selected.repositoryTags.length ? selected.repositoryTags.join(', ') : 'Untagged image'}</dd></div><div><dt>Size</dt><dd>{formatImageSize(selected.sizeBytes)}</dd></div><div><dt>Created</dt><dd>{formatCreatedAt(selected.createdAt)}</dd></div><div><dt>Operating system</dt><dd>{selected.operatingSystem ?? 'Unavailable'}</dd></div><div><dt>Architecture</dt><dd>{selected.architecture ?? 'Unavailable'}{selected.variant ? ` · ${selected.variant}` : ''}</dd></div><div><dt>User</dt><dd>{selected.config.user || 'Default'}</dd></div><div><dt>Working directory</dt><dd>{selected.config.workingDir || 'Default'}</dd></div><div><dt>Exposed ports</dt><dd>{selected.config.exposedPorts.length ? selected.config.exposedPorts.join(', ') : 'None'}</dd></div><div><dt>Volumes</dt><dd>{selected.config.volumes.length ? selected.config.volumes.join(', ') : 'None'}</dd></div>
      </dl><p className="image-detail-safety">Container environment variables and labels are not displayed.</p></section>}
    </main>
  );
}

