import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProjects, runGitDetectiveAnalysis, type Project, type StackDoctorGitAnalysis } from '../lib/api';

export function GitDetectivePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [analysis, setAnalysis] = useState<StackDoctorGitAnalysis | null>(null);
  const [basedOnScanAt, setBasedOnScanAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((item) => item.id === projectId) ?? null;

  useEffect(() => {
    let active = true;
    listProjects().then((items) => {
      if (!active) return;
      setProjects(items);
      setProjectId(items[0]?.id ?? '');
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load projects.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  async function analyze() {
    if (!project) return;
    setAnalyzing(true); setError(null); setAnalysis(null);
    try {
      const result = await runGitDetectiveAnalysis(project.id);
      setAnalysis(result.analysis); setBasedOnScanAt(result.basedOnScanAt);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Git Detective could not analyze this repository.'); }
    finally { setAnalyzing(false); }
  }

  return <main className="brain-page git-detective-page">
    <div className="page-heading"><div className="eyebrow"><span className="eyebrow-line" /> DOCKER INTELLIGENCE</div><h1>Git Detective</h1><p>Review recent changes from a public GitHub repository alongside the latest Stack Doctor findings.</p></div>
    {error && <div className="form-message error-message" role="alert">{error}</div>}
    <section className="brain-card git-detective-project">
      <div className="brain-card-heading"><div><span className="eyebrow">REPOSITORY ANALYSIS</span><h2>Choose a project</h2></div></div>
      {loading ? <p className="brain-empty" role="status">Loading projects…</p> : projects.length ? <>
        <label className="form-field"><span>Project</span><select value={projectId} onChange={(event) => { setProjectId(event.target.value); setAnalysis(null); }} aria-label="Project for Git Detective">{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {project?.repositoryUrl ? <><p className={`repository-connection repository-${project.repositoryStatus}`}>{project.repositoryStatus === 'connected' ? `Connected · ${project.repositoryName ?? project.repositoryUrl} · ${project.repositoryDefaultBranch ?? 'default branch'}` : `Repository status: ${project.repositoryStatus}${project.repositoryError ? ` · ${project.repositoryError}` : ''}`}</p><a className="git-repository-link" href={project.repositoryUrl} target="_blank" rel="noreferrer">Open repository on GitHub ↗</a></> : <p className="brain-empty">This project has no GitHub repository connected. Add a public repository in <Link to={`/projects/${project?.id}`}>project settings</Link>.</p>}
        {project?.repositoryUrl && <button className="primary-button" onClick={() => void analyze()} disabled={analyzing || project.repositoryStatus !== 'connected'}>{analyzing ? <><span className="loading-indicator" /> Analyzing commits…</> : 'Analyze recent commits'}</button>}
      </> : !loading && <p className="brain-empty">Create a project and connect a public GitHub repository to use Git Detective.</p>}
      <p className="git-detective-context">Analysis uses the selected project’s latest Stack Doctor findings when available. Run Stack Doctor first for stronger links between Docker issues and code changes. Commit ranking is a lead for review, not proof of cause.</p>
    </section>
    {analysis && <section className="git-report git-detective-results" aria-labelledby="git-detective-results-heading">
      <header className="git-report-header"><div><div className="eyebrow"><span className="eyebrow-line" /> GIT DETECTIVE REPORT</div><h2 id="git-detective-results-heading">{analysis.repository ?? project?.name}</h2><p>{analysis.branch ? `Branch: ${analysis.branch}` : analysis.message}{basedOnScanAt ? ` · Docker scan: ${new Date(basedOnScanAt).toLocaleString()}` : ' · No Stack Doctor scan was available'}</p></div><span className={`git-report-status status-${analysis.status}`}>{analysis.status === 'available' ? 'Repository checked' : analysis.status === 'not_connected' ? 'Not connected' : 'GitHub unavailable'}</span></header>
      {analysis.message && <p className="git-report-message">{analysis.message}</p>}
      {analysis.rootCause && <>
        <article className="git-conclusion"><div className="git-conclusion-kicker">CONCLUSION · BEST MATCH IN THE AVAILABLE EVIDENCE</div><h3>{analysis.commits[0]?.score ? <>Most likely point where things went wrong: <a href={analysis.commits[0].githubUrl ?? undefined} target="_blank" rel="noreferrer"><code>{analysis.commits[0].shortHash}</code></a> — {analysis.commits[0].message}</> : 'No specific commit can be identified as the point where things went wrong.'}</h3><p>{analysis.commits[0]?.score ? 'This is the strongest commit match to the Docker issue. Treat it as the leading suspect until the change and service logs confirm it.' : 'The available Docker findings and commit history do not point to a clear failure commit.'}</p></article>
        <article className="git-finding-card"><div className="git-section-heading"><div><span className="eyebrow">WHAT DOCKERPILOT FOUND</span><h3>{analysis.rootCause.problem}</h3></div><span className={`git-confidence confidence-${analysis.rootCause.confidence}`}>{analysis.rootCause.confidence} confidence</span></div>
          {analysis.rootCause.affectedService && <p className="git-service">Affected service: <strong>{analysis.rootCause.affectedService}</strong></p>}
          <div className="git-report-block"><h4>Why this commit stands out</h4><p>{analysis.rootCause.explanation}</p></div>
          <div className="git-report-block"><h4>What to try next</h4><p>{analysis.rootCause.recommendedFix}</p></div>
          <details className="git-evidence"><summary>Show evidence and how to verify</summary><div className="git-evidence-columns"><div><h4>Evidence</h4><ul>{analysis.rootCause.supportingEvidence.map((item, index) => <li key={`e-${index}`}>{item}</li>)}</ul></div><div><h4>Verify</h4><ul>{analysis.rootCause.verificationSteps.map((item, index) => <li key={`v-${index}`}>{item}</li>)}</ul></div></div></details>
          <p className="git-analysis-mode">{analysis.rootCause.provider ? `AI assessment · ${analysis.rootCause.provider}` : 'Evidence-based summary · Add a Gemini key in backend/.env for an AI assessment.'}</p>
        </article>
      </>}
      <div className="git-commits-heading"><div><span className="eyebrow">RECENT HISTORY</span><h3>Commits reviewed</h3></div><p>Sorted by relevance to the Docker finding</p></div>
      {analysis.commits.length ? <div className="git-commit-list">{analysis.commits.map((commit, index) => <details className="git-commit-card" key={commit.hash}><summary><span className="git-commit-rank">{index === 0 && commit.score ? 'TOP MATCH' : commit.shortHash}</span><span className="git-commit-title"><strong>{commit.message}</strong><small>{commit.author} · {new Date(commit.committedAt).toLocaleString()}</small></span><span className={`git-confidence confidence-${commit.confidence}`}>{commit.confidence} match</span></summary><div className="git-commit-details"><p>{commit.relationship}</p><h4>Changed files</h4><ul>{commit.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul>{commit.diff && <details className="git-diff"><summary>View code changes</summary><pre>{commit.diff}</pre></details>}{commit.githubUrl && <a href={commit.githubUrl} target="_blank" rel="noreferrer">View this commit on GitHub ↗</a>}</div></details>)}</div> : analysis.status === 'available' && <p className="brain-empty">No recent commits were available to compare with this scan.</p>}
      {analysis.status === 'available' && <p className="git-report-note">Commit timing and file changes help rank likely leads; they do not prove a commit caused the issue.</p>}
    </section>}
  </main>;
}
