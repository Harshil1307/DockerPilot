import { useCallback, useEffect, useState } from 'react';
import { controlDockerContainer, getBrainDashboard, type BrainDashboard } from '../lib/api';
import { useConfirm } from './ConfirmDialog';

function bytes(value: number | null) {
  if (value === null) return 'Unavailable';
  return value < 1024 * 1024 ? (value / 1024).toFixed(0) + ' KiB' : (value / 1024 / 1024).toFixed(1) + ' MiB';
}

export function SmartAutoSleepPage() {
  const confirm = useConfirm();
  const [dashboard, setDashboard] = useState<BrainDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try { setDashboard(await getBrainDashboard()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load idle-container analysis.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function stop(candidate: BrainDashboard['idleCandidates'][number]) {
    const approved = await confirm({
      title: 'Stop ' + candidate.name + '?',
      message: 'DockerPilot observed ' + candidate.inactivity + ' This will stop the container but will not remove it. You can start it again from Containers.',
      confirmLabel: 'Stop container',
      destructive: true,
    });
    if (!approved) return;
    setStopping(candidate.id); setError(null); setNotice(null);
    try {
      await controlDockerContainer(candidate.id, 'stop');
      setNotice(candidate.name + ' was stopped.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The container could not be stopped.'); }
    finally { setStopping(null); }
  }

  return <main className="brain-page">
    <div className="page-heading"><div className="eyebrow"><span className="eyebrow-line" /> RESOURCE MANAGEMENT</div><h1>Smart Auto-Sleep</h1><p>Review containers with sustained low activity. DockerPilot never stops a container without your confirmation.</p></div>
    {error && <div className="form-message error-message" role="alert">{error}<button className="secondary-button" onClick={() => void refresh()}>Retry</button></div>}
    {dashboard?.message && <div className="form-message error-message" role="status">{dashboard.message}</div>}
    {notice && <div className="form-message success-message" role="status">{notice}</div>}
    <section className="brain-card autosleep-card">
      <div className="brain-card-heading"><div><span className="eyebrow">RULE-BASED IDLE ANALYSIS</span><h2>Review candidates</h2></div><button className="secondary-button" onClick={() => void refresh()} disabled={loading}>Refresh samples</button></div>
      <p className="brain-empty">Candidates require at least two low-activity samples spanning the configured inactivity window. Databases and common infrastructure are excluded. Stopping a container requires your approval and uses the existing ownership check.</p>
      {loading ? <p className="brain-empty" role="status">Collecting Docker samples…</p> : dashboard?.idleCandidates.length ? dashboard.idleCandidates.map((candidate) => <article className="autosleep-candidate" key={candidate.id}>
        <div className="autosleep-title"><div><strong>{candidate.name}</strong><span>{candidate.inactivity}</span></div><button className="danger-button" disabled={stopping !== null || dashboard.status !== 'ready'} onClick={() => void stop(candidate)}>{stopping === candidate.id ? 'Stopping…' : 'Review and stop'}</button></div>
        <p>{candidate.reason}</p>
        <div className="autosleep-metrics"><span>CPU <b>{candidate.cpuPercent === null ? 'Unavailable' : candidate.cpuPercent.toFixed(1) + '%'}</b></span><span>Memory <b>{bytes(candidate.memoryUsageBytes)}</b></span><span>Network I/O since previous sample <b>{bytes(candidate.networkIoDeltaBytes)}</b></span><span>Block I/O since previous sample <b>{bytes(candidate.blockIoDeltaBytes)}</b></span></div>
      </article>) : <div className="brain-empty">{dashboard?.status !== 'ready' ? 'Docker data is unavailable.' : 'No idle candidates yet. Keep this page open to collect samples across the configured inactivity window.'}</div>}
      <p className="autosleep-safety">No candidates are stopped automatically. Protected infrastructure is excluded, and the API verifies container ownership when you approve a stop.</p>
    </section>
  </main>;
}
