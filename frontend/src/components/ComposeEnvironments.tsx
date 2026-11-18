import { useCallback, useEffect, useState } from 'react';
import {
  createComposeEnvironment,
  cleanupComposeDeployment,
  deployComposeEnvironment,
  deleteComposeEnvironment,
  getComposeDeploymentStatus,
  getComposeEnvironment,
  getProjectComposeTemplate,
  listComposeEnvironments,
  listDockerContainers,
  operateComposeDeployment,
  updateComposeEnvironment,
  validateComposeEnvironment,
  type ComposeEnvironmentInput,
  type ComposeEnvironmentSummary,
  type ComposeValidationResult,
} from '../lib/api';
import { availableComposeActions, deploymentStatusLabel } from '../lib/composeLifecycle';
import { ComposeMonitoringPanel } from './ComposeMonitoringPanel';
import { useConfirm } from './ConfirmDialog';

function validationLabel(status: ComposeEnvironmentSummary['validationStatus']): string {
  if (status === 'VALID') return 'Valid';
  if (status === 'INVALID') return 'Needs changes';
  return 'Not validated';
}

async function loadEnvironmentsWithDeploymentStatus(projectId: string): Promise<ComposeEnvironmentSummary[]> {
  const environments = await listComposeEnvironments(projectId);
  return Promise.all(environments.map(async (environment) => {
    try {
      const deployment = await getComposeDeploymentStatus(environment.id);
      return {
        ...environment,
        deploymentStatus: deployment.status,
        deploymentProjectName: deployment.projectName,
        deploymentStartedAt: deployment.startedAt,
        deploymentCompletedAt: deployment.completedAt,
        lastDeploymentError: deployment.lastError ?? null,
        publishedPorts: deployment.publishedPorts ?? [],
      };
    } catch {
      return environment;
    }
  }));
}

export function ComposeEnvironments({ projectId, projectName }: { projectId: string; projectName: string }) {
  const confirm = useConfirm();
  const [environments, setEnvironments] = useState<ComposeEnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [composeYaml, setComposeYaml] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<ComposeValidationResult | null>(null);
  const [busy, setBusy] = useState<'save' | 'validate' | 'load' | null>(null);
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [lifecycleOperation, setLifecycleOperation] = useState<{ id: string; action: 'start' | 'stop' | 'restart' | 'cleanup' | 'delete' | 'refresh' } | null>(null);
  const [loadingTemplate, setLoadingTemplate] = useState(false);

  const refreshEnvironments = useCallback(async () => {
    setListError(null);
    try {
      setEnvironments(await loadEnvironmentsWithDeploymentStatus(projectId));
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : 'Could not load Compose environments.');
    }
  }, [projectId]);

  async function refreshDeploymentStatus(id: string) {
    const deployment = await getComposeDeploymentStatus(id);
    setEnvironments((current) => current.map((environment) => environment.id === id ? {
      ...environment,
      deploymentStatus: deployment.status,
      deploymentProjectName: deployment.projectName,
      deploymentStartedAt: deployment.startedAt,
      deploymentCompletedAt: deployment.completedAt,
      lastDeploymentError: deployment.lastError ?? null,
    } : environment));
    return deployment;
  }

  async function handleRefreshStatus(environment: ComposeEnvironmentSummary) {
    setLifecycleOperation({ id: environment.id, action: 'refresh' });
    setListError(null);
    try {
      const deployment = await refreshDeploymentStatus(environment.id);
      setNotice(`Deployment status: ${deploymentStatusLabel(deployment.status)}.`);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : 'Could not refresh deployment status.');
    } finally {
      setLifecycleOperation(null);
    }
  }

  async function handleLifecycle(environment: ComposeEnvironmentSummary, action: 'start' | 'stop' | 'restart') {
    const prompts = {
      start: `Start all registered containers for “${environment.name}”?`,
      stop: `Stop all registered containers for “${environment.name}”? The deployment and its resources will remain registered.`,
      restart: `Restart all registered containers for “${environment.name}”?`,
    };
    if (!await confirm({ title: `${action[0].toUpperCase()}${action.slice(1)} “${environment.name}”?`, message: prompts[action], confirmLabel: `${action[0].toUpperCase()}${action.slice(1)}`, destructive: action === 'stop' })) return;
    setLifecycleOperation({ id: environment.id, action });
    setListError(null);
    setNotice(`${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} “${environment.name}”…`);
    try {
      const result = await operateComposeDeployment(environment.id, action);
      const deployment = await refreshDeploymentStatus(environment.id);
      setNotice(deployment.status === result.status
        ? `“${environment.name}” ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'} successfully.`
        : `Operation completed. Current deployment status: ${deploymentStatusLabel(deployment.status)}.`);
    } catch (cause) {
      setNotice(null);
      setListError(cause instanceof Error ? cause.message : `Could not ${action} this deployment.`);
      await refreshDeploymentStatus(environment.id).catch(() => undefined);
    } finally {
      setLifecycleOperation(null);
    }
  }

  async function handleCleanup(environment: ComposeEnvironmentSummary) {
    if (!await confirm({ title: `Clean up “${environment.name}”?`, message: 'This removes only its registered containers and networks. Unlike Stop, it removes those resources; images and volumes remain.', confirmLabel: 'Clean up stack', destructive: true })) return;
    setLifecycleOperation({ id: environment.id, action: 'cleanup' });
    setListError(null);
    setNotice(`Cleaning up “${environment.name}”…`);
    try {
      const result = await cleanupComposeDeployment(environment.id);
      if (result.status !== 'REMOVED') throw new Error('Cleanup has not been confirmed as complete. Refresh status or retry cleanup.');
      const deployment = await refreshDeploymentStatus(environment.id);
      if (deployment.status !== 'REMOVED') throw new Error('Cleanup is still in progress. Refresh status before taking another action.');
      setNotice(`“${environment.name}” cleanup completed. ${result.removedContainers} containers and ${result.removedNetworks} networks removed.`);
    } catch (cause) {
      setNotice(null);
      setListError(cause instanceof Error ? cause.message : 'Cleanup did not complete. You can safely retry.');
      await refreshDeploymentStatus(environment.id).catch(() => undefined);
    } finally {
      setLifecycleOperation(null);
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadEnvironmentsWithDeploymentStatus(projectId).then(
      (result) => { if (active) { setEnvironments(result); setListError(null); } },
      (cause: unknown) => { if (active) setListError(cause instanceof Error ? cause.message : 'Could not load Compose environments.'); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  async function startNew() {
    setEnvironmentId(null);
    setName(`${projectName} stack`.slice(0, 100));
    setComposeYaml('');
    setValidation(null);
    setNotice(null);
    setFormError(null);
    setFormOpen(true);
    setLoadingTemplate(true);
    try {
      const template = await getProjectComposeTemplate(projectId);
      if (template.content) setComposeYaml(template.content);
      setNotice(template.message);
      if (!template.content) setFormError(template.message);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not load a Compose file from this project’s GitHub repository.');
    } finally { setLoadingTemplate(false); }
  }

  async function startEdit(id: string) {
    setBusy('load');
    setFormError(null);
    setNotice(null);
    try {
      const environment = await getComposeEnvironment(id);
      setEnvironmentId(environment.id);
      setName(environment.name);
      setComposeYaml(environment.composeYaml);
      setValidation(null);
      setFormOpen(true);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not load this Compose environment.');
    } finally {
      setBusy(null);
    }
  }

  function validateForm(): string | null {
    if (!name.trim()) return 'Environment name is required.';
    if (name.trim().length > 100) return 'Environment name must be 100 characters or fewer.';
    if (!composeYaml.trim()) return 'Compose YAML is required.';
    if (new TextEncoder().encode(composeYaml).byteLength > 64 * 1024) return 'Compose YAML must be 64 KB or smaller.';
    return null;
  }

  async function saveDraft(): Promise<string> {
    const issue = validateForm();
    if (issue) throw new Error(issue);
    const input: ComposeEnvironmentInput = { name: name.trim(), composeYaml };
    const environment = environmentId
      ? await updateComposeEnvironment(environmentId, input)
      : await createComposeEnvironment(projectId, input);
    setEnvironmentId(environment.id);
    await refreshEnvironments();
    return environment.id;
  }

  async function handleSave() {
    setBusy('save');
    setFormError(null);
    setNotice(null);
    setValidation(null);
    try {
      await saveDraft();
      setNotice('Compose environment saved.');
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not save this Compose environment.');
    } finally {
      setBusy(null);
    }
  }

  async function handleValidate() {
    setBusy('validate');
    setFormError(null);
    setNotice(null);
    setValidation(null);
    try {
      const id = await saveDraft();
      const result = await validateComposeEnvironment(id);
      setValidation(result);
      setNotice(result.valid ? 'Compose configuration is valid.' : 'Compose configuration needs changes.');
      await refreshEnvironments();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not validate this Compose environment.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(environment: ComposeEnvironmentSummary) {
    const needsCleanup = Boolean(environment.deploymentProjectName) && environment.deploymentStatus !== 'REMOVED';
    const message = needsCleanup
      ? 'This removes the environment’s registered containers and networks, then deletes its saved configuration. Images and volumes are kept.'
      : 'This deletes the saved environment configuration. This cannot be undone.';
    if (!await confirm({ title: `Delete Compose environment “${environment.name}”?`, message, confirmLabel: 'Delete environment', destructive: true })) return;
    setLifecycleOperation({ id: environment.id, action: 'delete' });
    setListError(null);
    setNotice(null);
    try {
      if (needsCleanup) {
        setNotice(`Cleaning up “${environment.name}” before deleting it…`);
        const cleanup = await cleanupComposeDeployment(environment.id);
        if (cleanup.status !== 'REMOVED') throw new Error('Cleanup has not been confirmed as complete. The environment was kept.');
      }
      await deleteComposeEnvironment(environment.id);
      setEnvironments((current) => current.filter((item) => item.id !== environment.id));
      if (environmentId === environment.id) setFormOpen(false);
      setNotice(`Compose environment “${environment.name}” deleted.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not delete this Compose environment.';
      try { setEnvironments(await loadEnvironmentsWithDeploymentStatus(projectId)); } catch { /* Keep the visible deletion error if refreshing also fails. */ }
      setListError(message);
    } finally {
      setLifecycleOperation(null);
    }
  }

  async function handleDeploy(environment: ComposeEnvironmentSummary) {
    if (environment.validationStatus !== 'VALID' || deployingId) return;
    if (!await confirm({ title: `Deploy “${environment.name}”?`, message: 'This will create or update its containers on the connected Docker Engine.', confirmLabel: 'Deploy stack' })) return;
    setDeployingId(environment.id);
    setListError(null);
    setNotice(`Deploying “${environment.name}”…`);
    try {
      const deployment = await deployComposeEnvironment(environment.id);
      let inventoryMessage = '';
      try {
        const containers = await listDockerContainers();
        inventoryMessage = ` Docker inventory refreshed (${containers.length} containers).`;
      } catch {
        inventoryMessage = ' Deployment succeeded; refresh the Docker dashboard to update its inventory.';
      }
      const websiteUrls = deployment.publishedPorts?.flatMap((port) => port.url ? [port.url] : []) ?? [];
      const websiteMessage = websiteUrls.length ? ` Open website: ${websiteUrls.join(', ')}.` : '';
      const publishedMessage = !websiteUrls.length && deployment.publishedPorts?.length ? ` Published TCP ports: ${deployment.publishedPorts.map((port) => `${port.serviceName} ${port.hostPort} → ${port.containerPort}`).join(', ')}.` : '';
      const noPortMessage = !deployment.publishedPorts?.length ? ' No website port was published; check the Compose file’s ports section.' : '';
      setNotice(`“${environment.name}” deployed successfully.${websiteMessage}${publishedMessage}${noPortMessage}${inventoryMessage}`);
      await refreshEnvironments();
    } catch (cause) {
      setNotice(null);
      setListError(cause instanceof Error ? cause.message : 'Compose deployment failed.');
      await refreshEnvironments();
    } finally {
      setDeployingId(null);
    }
  }

  return (
    <section className="compose-section" aria-labelledby="compose-heading">
      <div className="section-heading compose-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> CONFIGURATION</div><h2 id="compose-heading">Docker Compose environments</h2></div>
        <button className="primary-button compose-new-button" type="button" onClick={startNew} disabled={busy !== null}><span aria-hidden="true">＋</span> New environment</button>
      </div>
      <p className="compose-intro">Create and validate Compose files for this project. Validation never starts containers.</p>

      {notice && <div className="form-message success-message compose-notice" role="status">{notice}</div>}
      {listError && <div className="form-message error-message compose-notice" role="alert">{listError} <button className="text-button" type="button" onClick={() => void refreshEnvironments()}>Try again</button></div>}

      {formOpen && (
        <div className="compose-editor-panel">
        <div className="compose-editor-heading"><div><h3>{environmentId ? 'Edit environment' : 'New environment'}</h3><p>Saving changes stores configuration only. Deploy runs a validated configuration in Docker Desktop.</p></div><button className="icon-close-button" type="button" onClick={() => setFormOpen(false)} disabled={busy !== null} aria-label="Close editor">×</button></div>
          <label className="compose-field-label" htmlFor="compose-environment-name">Environment name</label>
          <input id="compose-environment-name" className="compose-name-input" value={name} onChange={(event) => { setName(event.target.value); setValidation(null); }} maxLength={100} placeholder="Local development" disabled={busy !== null} />
          <label className="compose-field-label" htmlFor="compose-yaml-editor">Compose YAML <span>64 KB maximum</span></label>
          <textarea id="compose-yaml-editor" className="compose-yaml-editor" value={composeYaml} onChange={(event) => { setComposeYaml(event.target.value); setValidation(null); }} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby="compose-editor-help" disabled={busy !== null} />
          <p id="compose-editor-help" className="compose-editor-help">{loadingTemplate ? 'Looking for a Compose file on the project’s default GitHub branch…' : 'DockerPilot uses a compatible Compose file from the connected public GitHub repository when available. If it cannot use that file, the editor loads a small Whoami demo that displays request details. Host ports are assigned automatically on deploy.'}</p>
          {formError && <div className="form-message error-message" role="alert">{formError}</div>}
          {validation && (
            <div className={`compose-validation-result ${validation.valid ? 'validation-valid' : 'validation-invalid'}`} role={validation.valid ? 'status' : 'alert'}>
              <strong>{validation.valid ? 'Configuration is valid' : 'Configuration has validation errors'}</strong>
              <span>{validation.servicesCount} {validation.servicesCount === 1 ? 'service' : 'services'} found.</span>
              {validation.errors.length > 0 && <ul>{validation.errors.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul>}
            </div>
          )}
          <div className="form-actions compose-form-actions">
            <button className="secondary-button" type="button" onClick={() => setFormOpen(false)} disabled={busy !== null}>Close</button>
            <button className="secondary-button" type="button" onClick={() => void handleValidate()} disabled={busy !== null}>{busy === 'validate' ? 'Validating…' : 'Validate'}</button>
            <button className="primary-button" type="button" onClick={() => void handleSave()} disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save environment'}</button>
          </div>
          <p className="compose-validation-note">Validate saves the current draft first so the server checks the exact saved version.</p>
        </div>
      )}

      {loading ? (
        <div className="state-panel" role="status"><span className="loading-indicator" /> Loading Compose environments…</div>
      ) : environments.length === 0 ? (
        <div className="state-panel empty-state compose-empty"><div className="empty-icon" aria-hidden="true">▱</div><h3>No Compose environments yet</h3><p>Add a configuration to keep this project’s container setup organized.</p></div>
      ) : (
        <div className="compose-environment-list">
          {environments.map((environment) => (
            <article className="compose-environment-card" key={environment.id}>
              <div className="compose-environment-main"><h3>{environment.name}</h3><span className={`compose-status status-${environment.validationStatus.toLowerCase().replaceAll('_', '-')}`}>{validationLabel(environment.validationStatus)}</span><span className={`compose-status status-${environment.deploymentStatus.toLowerCase().replaceAll('_', '-')}`}>{deploymentStatusLabel(environment.deploymentStatus)}</span></div>
              <div className="compose-environment-meta"><span>{environment.servicesCount} {environment.servicesCount === 1 ? 'service' : 'services'}</span><span>Updated {new Date(environment.updatedAt).toLocaleString()}</span>{environment.deploymentCompletedAt && <span>Deployment {new Date(environment.deploymentCompletedAt).toLocaleString()}</span>}</div>
              {environment.lastDeploymentError && <div className="form-message error-message compose-notice" role="status">{environment.lastDeploymentError}</div>}
              {environment.publishedPorts && environment.publishedPorts.length > 0 && <div className="compose-published-ports" aria-label="Published ports"><strong>Published ports</strong>{environment.publishedPorts.map((port) => <span key={`${port.serviceName}-${port.hostPort}-${port.containerPort}`}>{port.url ? <a href={port.url} target="_blank" rel="noreferrer">Open {port.serviceName} at {port.url} ↗</a> : `${port.serviceName}: localhost:${port.hostPort} → container ${port.containerPort}`}</span>)}</div>}
              {environment.deploymentProjectName && <p className="compose-editor-help">Stopping keeps registered resources. Cleanup removes only registered containers and networks; it does not remove images or volumes.</p>}
              <div className="compose-environment-actions compose-lifecycle-actions">
                {(['NOT_DEPLOYED', 'FAILED', 'REMOVED'].includes(environment.deploymentStatus) && !environment.deploymentProjectName) && <button className="primary-button" type="button" onClick={() => void handleDeploy(environment)} disabled={environment.validationStatus !== 'VALID' || deployingId !== null || busy !== null || lifecycleOperation !== null}>{deployingId === environment.id ? 'Deploying…' : 'Deploy'}</button>}
                {availableComposeActions(environment.deploymentStatus, Boolean(environment.deploymentProjectName)).includes('start') && <button className="primary-button lifecycle-start" type="button" onClick={() => void handleLifecycle(environment, 'start')} disabled={lifecycleOperation !== null || deployingId !== null || busy !== null}>{lifecycleOperation?.id === environment.id && lifecycleOperation.action === 'start' ? 'Starting…' : 'Start'}</button>}
                {availableComposeActions(environment.deploymentStatus, Boolean(environment.deploymentProjectName)).includes('stop') && <button className="secondary-button" type="button" onClick={() => void handleLifecycle(environment, 'stop')} disabled={lifecycleOperation !== null || deployingId !== null || busy !== null}>{lifecycleOperation?.id === environment.id && lifecycleOperation.action === 'stop' ? 'Stopping…' : 'Stop'}</button>}
                {availableComposeActions(environment.deploymentStatus, Boolean(environment.deploymentProjectName)).includes('restart') && <button className="secondary-button lifecycle-restart" type="button" onClick={() => void handleLifecycle(environment, 'restart')} disabled={lifecycleOperation !== null || deployingId !== null || busy !== null}>{lifecycleOperation?.id === environment.id && lifecycleOperation.action === 'restart' ? 'Restarting…' : 'Restart'}</button>}
                {availableComposeActions(environment.deploymentStatus, Boolean(environment.deploymentProjectName)).includes('refresh') && <button className="secondary-button" type="button" onClick={() => void handleRefreshStatus(environment)} disabled={lifecycleOperation !== null || deployingId !== null}>{lifecycleOperation?.id === environment.id && lifecycleOperation.action === 'refresh' ? 'Refreshing…' : 'Refresh status'}</button>}
                {availableComposeActions(environment.deploymentStatus, Boolean(environment.deploymentProjectName)).includes('cleanup') && <button className="danger-button" type="button" onClick={() => void handleCleanup(environment)} disabled={lifecycleOperation !== null || deployingId !== null || busy !== null}>{lifecycleOperation?.id === environment.id && lifecycleOperation.action === 'cleanup' ? 'Cleaning…' : environment.deploymentStatus === 'CLEANUP_FAILED' ? 'Retry cleanup' : 'Cleanup'}</button>}
                {environment.deploymentStatus === 'CLEANING' && <span className="lifecycle-progress" role="status"><span className="loading-indicator" /> Cleaning…</span>}
                <button className="secondary-button" type="button" onClick={() => void startEdit(environment.id)} disabled={busy !== null || deployingId !== null || lifecycleOperation !== null || ['DEPLOYING', 'CLEANING'].includes(environment.deploymentStatus)}>{busy === 'load' && environmentId === environment.id ? 'Loading…' : 'Edit'}</button>
                <button className="danger-button" type="button" onClick={() => void handleDelete(environment)} disabled={busy !== null || deployingId !== null || lifecycleOperation !== null || ['DEPLOYING', 'CLEANING'].includes(environment.deploymentStatus)} title={environment.deploymentProjectName && environment.deploymentStatus !== 'REMOVED' ? 'Delete will first clean up this environment’s registered containers and networks.' : undefined}>{lifecycleOperation?.id === environment.id && lifecycleOperation.action === 'delete' ? 'Deleting…' : 'Delete'}</button>
              </div>
              {environment.deploymentStatus !== 'NOT_DEPLOYED' && <ComposeMonitoringPanel environmentId={environment.id} />}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
