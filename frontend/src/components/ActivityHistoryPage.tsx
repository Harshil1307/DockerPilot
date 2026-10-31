import { useEffect, useRef, useState } from 'react';
import {
  listActivity,
  type ActivityActionType,
  type ActivityPage,
  type ActivityResourceType,
} from '../lib/api';

const actions: ActivityActionType[] = [
  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_DELETED',
  'COMPOSE_ENVIRONMENT_CREATED', 'COMPOSE_ENVIRONMENT_UPDATED', 'COMPOSE_ENVIRONMENT_DELETED',
  'COMPOSE_DEPLOYMENT_CREATED', 'COMPOSE_DEPLOYMENT_STARTED', 'COMPOSE_DEPLOYMENT_STOPPED',
  'COMPOSE_DEPLOYMENT_RESTARTED', 'COMPOSE_DEPLOYMENT_CLEANED',
  'CONTAINER_STARTED', 'CONTAINER_STOPPED', 'CONTAINER_RESTARTED',
  'IMAGE_PULLED', 'IMAGE_REMOVED', 'VOLUME_CREATED', 'VOLUME_REMOVED', 'NETWORK_CREATED', 'NETWORK_REMOVED',
];
const resources: ActivityResourceType[] = ['project', 'compose_environment', 'compose_deployment', 'container', 'image', 'volume', 'network'];

function humanize(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function ActivityHistoryPage() {
  const [actionType, setActionType] = useState<ActivityActionType | ''>('');
  const [resourceType, setResourceType] = useState<ActivityResourceType | ''>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  async function load() {
    const currentRequest = ++requestId.current;
    setLoading(true); setError(null);
    try {
      const pageResult = await listActivity({ actionType: actionType || undefined, resourceType: resourceType || undefined, page });
      if (currentRequest === requestId.current) setResult(pageResult);
    } catch (cause) {
      if (currentRequest === requestId.current) setError(cause instanceof Error ? cause.message : 'Could not load activity history.');
    } finally { if (currentRequest === requestId.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [actionType, resourceType, page]);

  return <main className="activity-page">
    <div className="eyebrow"><span className="eyebrow-line" /> ACCOUNT HISTORY</div>
    <div className="activity-heading"><div><h1>Activity history</h1><p>Recent actions performed through DockerPilot for this account.</p></div><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    <div className="activity-filters"><label>Action<select value={actionType} onChange={(event) => { setActionType(event.target.value as ActivityActionType | ''); setPage(1); }}><option value="">All actions</option>{actions.map((action) => <option key={action} value={action}>{humanize(action)}</option>)}</select></label><label>Resource<select value={resourceType} onChange={(event) => { setResourceType(event.target.value as ActivityResourceType | ''); setPage(1); }}><option value="">All resources</option>{resources.map((resource) => <option key={resource} value={resource}>{humanize(resource)}</option>)}</select></label><span className="activity-sort-label">Newest first · 30 per page</span></div>
    {loading ? <div className="state-panel" role="status"><span className="loading-indicator" /> Loading activity…</div>
      : error ? <div className="state-panel error-panel" role="alert"><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}>Try again</button></div>
        : !result?.activities.length ? <div className="state-panel empty-state"><h2>No activity yet</h2><p>Actions performed through DockerPilot will appear here.</p></div>
          : <><ol className="activity-list">{result.activities.map((activity) => <li key={activity.id} className="activity-row"><span className={`activity-outcome ${activity.status === 'SUCCEEDED' ? 'activity-success' : 'activity-failure'}`}>{activity.status === 'SUCCEEDED' ? 'Success' : 'Failed'}</span><div className="activity-copy"><strong>{humanize(activity.actionType)}</strong><span>{activity.summary}</span><small>By you · {humanize(activity.resourceType)}{activity.resourceName ? ` · ${activity.resourceName}` : ''}{activity.resourceId ? ` · ${activity.resourceId}` : ''}</small></div><time dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleString()}</time></li>)}</ol><div className="activity-pagination"><button className="secondary-button" type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {page}</span><button className="secondary-button" type="button" disabled={!result.hasMore || loading} onClick={() => setPage((value) => value + 1)}>Next</button></div></>}
  </main>;
}
