import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AuthPage } from './components/AuthPage';
import { ComposeEnvironments } from './components/ComposeEnvironments';
import { ImageManagementPage } from './components/ImageManagementPage';
import { VolumeManagementPage } from './components/VolumeManagementPage';
import { NetworkManagementPage } from './components/NetworkManagementPage';
import { DockerOverviewPage } from './components/DockerOverviewPage';
import { ContainerInventory } from './components/ContainerInventory';
import { ActivityHistoryPage } from './components/ActivityHistoryPage';
import { ProjectForm } from './components/ProjectForm';
import { ProtectedRoute, PublicOnlyRoute } from './components/ProtectedRoute';
import { StatusBadge } from './components/StatusBadge';
import {
  createProject,
  deleteProject,
  fetchDockerStatus,
  fetchHealth,
  getProject,
  listDockerContainers,
  listProjects,
  updateProject,
  type DockerContainer,
  type DockerEngineStatus,
  type Project,
  type ProjectInput,
} from './lib/api';

function AppShell({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    fetchHealth().then(
      () => active && setConnected(true),
      () => active && setConnected(false),
    );
    return () => { active = false; };
  }, []);

  async function handleLogout() {
    setLogoutError(null);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : 'Could not sign out.');
    }
  }

  return (
    <div className="page-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label="DockerPilot home">
          <span className="brand-mark" aria-hidden="true">D</span>
          <span>docker<span className="brand-accent">pilot</span></span>
        </Link>
        <div className="topbar-right"><Link className="topbar-nav-link" to="/images">Images</Link><Link className="topbar-nav-link" to="/volumes">Volumes</Link><Link className="topbar-nav-link" to="/networks">Networks</Link><Link className="topbar-nav-link" to="/activity">Activity</Link><span className="environment-label">LOCAL ENVIRONMENT</span><StatusBadge connected={connected} /><span className="user-greeting">{user?.name}</span><button className="logout-button" onClick={() => void handleLogout()}>Log out</button></div>
      </header>
      {logoutError && <div className="form-message error-message logout-message" role="alert">{logoutError}</div>}
      {children}
      <footer className="page-footer"><span>DOCKERPILOT <span className="footer-divider">/</span> DEVELOPMENT FOUNDATION</span><span>BUILT FOR THE WAY YOU SHIP</span></footer>
    </div>
  );
}

function Overview() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dockerStatus, setDockerStatus] = useState<DockerEngineStatus | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [dockerLoading, setDockerLoading] = useState(true);
  const [dockerError, setDockerError] = useState<string | null>(null);
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load projects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const loadDocker = useCallback(async () => {
    setDockerLoading(true);
    setDockerError(null);
    const [statusResult, containersResult] = await Promise.allSettled([fetchDockerStatus(), listDockerContainers()]);
    if (statusResult.status === 'fulfilled') {
      setDockerStatus(statusResult.value);
    } else {
      setDockerStatus({ reachable: false, engine: null, message: 'Could not check Docker Engine status.' });
    }
    if (containersResult.status === 'fulfilled') {
      setContainers(containersResult.value);
    } else {
      setContainers([]);
      setDockerError(containersResult.reason instanceof Error ? containersResult.reason.message : 'Could not load Docker containers.');
    }
    setDockerLoading(false);
  }, []);

  useEffect(() => { void loadDocker(); }, [loadDocker]);
  const runningContainerCount = containers.filter((container) => container.state === 'running').length;

  return (
    <>
      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-line" /> DEPLOYMENT CONTROL CENTER</div>
        <h1>Your projects,<br /><span>under control.</span></h1>
        <p className="hero-copy">A clear view of your application deployments starts here.<br className="desktop-break" /> Register a project to begin organizing its environment.</p>
        <div className="hero-actions"><Link className="primary-button" to="/projects/new"><span aria-hidden="true">＋</span> Register a project</Link><Link className="host-overview-link" to="/docker">Docker host overview <span aria-hidden="true">→</span></Link><span className="phase-note">YOUR PROJECTS, AT A GLANCE</span></div>
      </section>

      {notice && <div className="form-message success-message" role="status">{notice}</div>}

      <section className="overview-grid" aria-label="Platform overview">
        <article className="overview-card"><div className="card-icon icon-box" aria-hidden="true">▣</div><div className="card-label">REGISTERED PROJECTS</div><div className="card-value">{loading ? '…' : error ? '—' : projects.length}</div><p>{error ? 'Project count unavailable.' : 'Projects registered in DockerPilot.'}</p></article>
        <article className="overview-card"><div className="card-icon icon-pulse" aria-hidden="true">⌁</div><div className="card-label">RUNNING CONTAINERS</div><div className="card-value">{dockerLoading ? '…' : dockerError ? '—' : runningContainerCount}</div><p>{dockerError ? 'Docker count unavailable.' : 'Currently running in Docker Desktop.'}</p></article>
        <article className="overview-card"><div className="card-icon icon-clock" aria-hidden="true">◷</div><div className="card-label">LATEST DEPLOYMENT</div><div className="card-value card-value-small">Not yet deployed</div><p>Deployment history will appear here in a later phase.</p></article>
      </section>

      <ContainerInventory status={dockerStatus} containers={containers} loading={dockerLoading} error={dockerError} onRefresh={() => loadDocker()} />

      <section className="projects-section" aria-labelledby="projects-heading">
        <div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE</div><h2 id="projects-heading">Your projects</h2></div><span className="section-count">{loading ? 'LOADING' : `${projects.length} ${projects.length === 1 ? 'PROJECT' : 'PROJECTS'}`}</span></div>
        {loading ? (
          <div className="state-panel" role="status"><span className="loading-indicator" /> Loading your projects…</div>
        ) : error ? (
          <div className="state-panel error-panel" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => void loadProjects()}>Try again</button></div>
        ) : projects.length === 0 ? (
          <div className="state-panel empty-state"><div className="empty-icon" aria-hidden="true">▱</div><h3>No projects registered yet</h3><p>Register your first project to keep its deployment setup organized.</p><Link className="secondary-button" to="/projects/new">Register your first project <span aria-hidden="true">→</span></Link></div>
        ) : (
          <div className="projects-list">
            {projects.map((project) => (
              <Link className="project-card" to={`/projects/${project.id}`} key={project.id}>
                <span className="project-card-icon" aria-hidden="true">▣</span>
                <span className="project-card-main"><span className="project-card-name">{project.name}</span><span className="project-card-description">{project.description || 'No description provided.'}</span></span>
                <span className="project-card-meta">{project.repositoryUrl ? 'REPOSITORY ADDED' : 'REGISTERED'}<span>{new Date(project.createdAt).toLocaleDateString()}</span></span>
                <span className="project-card-arrow" aria-hidden="true">↗</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function ProjectCreatePage() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(values: ProjectInput) {
    setSaving(true);
    setError(null);
    try {
      const project = await createProject(values);
      navigate(`/projects/${project.id}`, { replace: true, state: { notice: 'Project registered successfully.' } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not register this project.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <main className="form-page">
        <Link className="back-link" to="/">← Back to projects</Link>
        <div className="page-heading"><div className="eyebrow"><span className="eyebrow-line" /> PROJECT WORKSPACE</div><h1>Register a project</h1><p>Add the project details you want to keep in DockerPilot.</p></div>
        <section className="form-panel"><ProjectForm submitLabel="Register project" onSubmit={handleCreate} onCancel={() => navigate('/')} saving={saving} error={error} /></section>
      </main>
    </AppShell>
  );
}

function ProjectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState((location.state as { notice?: string } | null)?.notice ?? null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getProject(id).then(
      (result) => { if (active) { setProject(result); setError(null); } },
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load this project.'); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);

  async function handleUpdate(values: ProjectInput) {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      setProject(await updateProject(project.id, values));
      setEditing(false);
      setNotice('Project changes saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update this project.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!project || !window.confirm(`Delete “${project.name}”? This action cannot be undone.`)) return;
    setError(null);
    try {
      await deleteProject(project.id);
      navigate('/', { replace: true, state: { notice: 'Project deleted.' } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this project.');
    }
  }

  return (
    <AppShell>
      <main className="form-page detail-page">
        <Link className="back-link" to="/">← Back to projects</Link>
        {loading ? <div className="state-panel" role="status"><span className="loading-indicator" /> Loading project…</div> : !project ? (
          <div className="state-panel error-panel" role="alert"><h2>Project unavailable</h2><p>{error}</p><Link className="secondary-button" to="/">Return to projects</Link></div>
        ) : (
          <>
            <div className="detail-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> REGISTERED PROJECT</div><h1>{project.name}</h1></div><div className="detail-actions"><button className="secondary-button" onClick={() => { setEditing((value) => !value); setError(null); }}>{editing ? 'Cancel edit' : 'Edit project'}</button><button className="danger-button" onClick={() => void handleDelete()}>Delete</button></div></div>
            {notice && <div className="form-message success-message" role="status">{notice}</div>}
            {error && !editing && <div className="form-message error-message" role="alert">{error}</div>}
            {editing ? (
              <section className="form-panel"><ProjectForm key={project.updatedAt} initialValues={{ name: project.name, description: project.description, repositoryUrl: project.repositoryUrl }} submitLabel="Save changes" onSubmit={handleUpdate} onCancel={() => { setEditing(false); setError(null); }} saving={saving} error={error} /></section>
            ) : (
              <section className="detail-panel">
                <div className="detail-field"><span className="card-label">DESCRIPTION</span><p>{project.description || 'No description provided.'}</p></div>
                <div className="detail-field"><span className="card-label">REPOSITORY URL</span>{project.repositoryUrl ? <a href={project.repositoryUrl} target="_blank" rel="noreferrer">{project.repositoryUrl} <span aria-hidden="true">↗</span></a> : <p>No repository linked.</p>}</div>
                <div className="detail-timestamps"><span>CREATED {new Date(project.createdAt).toLocaleString()}</span><span>UPDATED {new Date(project.updatedAt).toLocaleString()}</span></div>
              </section>
            )}
            <ComposeEnvironments projectId={project.id} />
          </>
        )}
      </main>
    </AppShell>
  );
}

function NotFound() {
  return <main className="not-found"><span className="brand-mark" aria-hidden="true">D</span><h1>Page not found</h1><Link to="/">Return to overview</Link></main>;
}

export default function App() {
  return <Routes>
    <Route element={<PublicOnlyRoute />}>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
    </Route>
    <Route element={<ProtectedRoute />}>
      <Route path="/" element={<AppShell><Overview /></AppShell>} />
      <Route path="/images" element={<AppShell><ImageManagementPage /></AppShell>} />
      <Route path="/volumes" element={<AppShell><VolumeManagementPage /></AppShell>} />
      <Route path="/networks" element={<AppShell><NetworkManagementPage /></AppShell>} />
      <Route path="/docker" element={<AppShell><DockerOverviewPage /></AppShell>} />
      <Route path="/activity" element={<AppShell><ActivityHistoryPage /></AppShell>} />
      <Route path="/projects/new" element={<ProjectCreatePage />} />
      <Route path="/projects/:id" element={<ProjectDetailPage />} />
    </Route>
    <Route path="*" element={<NotFound />} />
  </Routes>;
}
