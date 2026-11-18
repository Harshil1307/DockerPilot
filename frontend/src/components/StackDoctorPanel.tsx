import { useCallback, useEffect, useState } from 'react';
import { compareStackDoctorScan, getStackDoctorHistory, runStackDoctorScan, type StackDoctorReport, type StackDoctorScanRecord } from '../lib/api';

export function StackDoctorPanel({ projectId }: { projectId: string }) {
  const [history, setHistory] = useState<StackDoctorScanRecord[]>([]);
  const [report, setReport] = useState<StackDoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<{ resolved: string[]; outstanding: string[]; newIssues: string[] } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const scans = await getStackDoctorHistory(projectId); setHistory(scans); setReport(scans[0]?.report ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load Stack Doctor history.'); }
    finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function scan() {
    setScanning(true); setError(null); setComparison(null);
    try { const next = await runStackDoctorScan(projectId); setReport(next); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The diagnostic scan could not be completed.'); }
    finally { setScanning(false); }
  }
  async function compare(record: StackDoctorScanRecord) {
    try { setComparison(await compareStackDoctorScan(projectId, record.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not compare scan reports.'); }
  }
  const grouped = { CRITICAL: report?.issues.filter((item) => item.severity === 'CRITICAL') ?? [], WARNING: report?.issues.filter((item) => item.severity === 'WARNING') ?? [], INFORMATIONAL: report?.issues.filter((item) => item.severity === 'INFORMATIONAL') ?? [] };

  return <section className="doctor-panel" aria-labelledby="doctor-heading">
    <div className="doctor-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> RUNTIME DIAGNOSTICS</div><h2 id="doctor-heading">Stack Doctor</h2><p>Checks saved Compose stacks and owned containers for configuration and runtime issues.</p></div><button className="primary-button doctor-scan" onClick={() => void scan()} disabled={scanning}>{scanning ? <><span className="loading-indicator" /> Scanning…</> : 'Run diagnostic scan'}</button></div>
    {error && <div className="form-message error-message" role="alert">{error}</div>}
    {scanning && <div className="doctor-progress" role="status"><span className="loading-indicator" /> Checking Compose configuration, container health, resource usage, and logs…</div>}
    {loading ? <div className="state-panel"><span className="loading-indicator" /> Loading scan history…</div> : !report ? <div className="doctor-empty"><strong>No diagnostic scans yet</strong><p>Run a scan to check your saved Compose environments and current owned deployments.</p></div> : <>
      <div className="doctor-score-row"><div className={`doctor-score ${report.healthScore < 60 ? 'score-low' : report.healthScore < 85 ? 'score-mid' : ''}`}><strong>{report.healthScore}</strong><span>HEALTH SCORE</span></div><div className="doctor-stat"><strong>{report.checksPerformed}</strong><span>CHECKS</span></div><div className="doctor-stat"><strong>{report.passedChecks}</strong><span>PASSED</span></div><div className="doctor-stat"><strong>{report.warningCount}</strong><span>WARNINGS</span></div><div className="doctor-stat"><strong>{report.criticalCount}</strong><span>CRITICAL</span></div><div className="doctor-scan-time">Scanned {new Date(report.scannedAt).toLocaleString()}</div></div>
      {comparison && <div className="doctor-comparison"><strong>Compared with previous scan</strong><span>{comparison.resolved.length} resolved</span><span>{comparison.outstanding.length} remain</span><span>{comparison.newIssues.length} new</span></div>}
      {(['CRITICAL', 'WARNING', 'INFORMATIONAL'] as const).map((severity) => <section className="doctor-issues" key={severity}><h3 className={`doctor-severity severity-${severity.toLowerCase()}`}>{severity === 'INFORMATIONAL' ? 'Suggestions' : severity === 'CRITICAL' ? 'Critical issues' : 'Warnings'} <span>{grouped[severity].length}</span></h3>{grouped[severity].length ? grouped[severity].map((issue) => <details className="doctor-issue" key={issue.key}><summary><strong>{issue.title}</strong><span>{issue.service ?? 'Project'} <i>›</i></span></summary><div className="doctor-issue-body"><p>{issue.description}</p><p><b>Why it matters</b>{issue.whyItMatters}</p><p><b>Suggested fix</b>{issue.recommendation}</p><pre>{issue.evidence}</pre></div></details>) : <p className="doctor-none">No {severity.toLowerCase()} findings.</p>}</section>)}
    </>}
    <section className="doctor-history"><div className="doctor-history-heading"><h3>Scan history</h3><span>Latest {history.length} reports</span></div>{history.length ? history.map((item) => <div className="doctor-history-row" key={item.id}><span>{new Date(item.createdAt).toLocaleString()}</span><strong>{item.report.healthScore}/100</strong><span>{item.report.criticalCount} critical · {item.report.warningCount} warnings</span><button className="secondary-button" onClick={() => { setReport(item.report); void compare(item); }}>Compare</button></div>) : !loading && <p className="doctor-none">Your completed scans will appear here.</p>}</section>
  </section>;
}
