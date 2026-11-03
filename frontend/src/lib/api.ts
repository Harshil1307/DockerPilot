// Production requests stay on the frontend origin so the session cookie is first-party.
// Vercel rewrites /api to Render; Vite proxies it locally during development.
const apiBaseUrl = import.meta.env.PROD
  ? ''
  : (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '').replace(/\/api$/, '');

export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

export type ActivityActionType =
  | 'PROJECT_CREATED' | 'PROJECT_UPDATED' | 'PROJECT_DELETED'
  | 'COMPOSE_ENVIRONMENT_CREATED' | 'COMPOSE_ENVIRONMENT_UPDATED' | 'COMPOSE_ENVIRONMENT_DELETED'
  | 'COMPOSE_DEPLOYMENT_CREATED' | 'COMPOSE_DEPLOYMENT_STARTED' | 'COMPOSE_DEPLOYMENT_STOPPED'
  | 'COMPOSE_DEPLOYMENT_RESTARTED' | 'COMPOSE_DEPLOYMENT_CLEANED'
  | 'CONTAINER_STARTED' | 'CONTAINER_STOPPED' | 'CONTAINER_RESTARTED'
  | 'IMAGE_PULLED' | 'IMAGE_REMOVED' | 'VOLUME_CREATED' | 'VOLUME_REMOVED' | 'NETWORK_CREATED' | 'NETWORK_REMOVED';
export type ActivityResourceType = 'project' | 'compose_environment' | 'compose_deployment' | 'container' | 'image' | 'volume' | 'network';
export interface ActivityRecord {
  id: string; actionType: ActivityActionType; resourceType: ActivityResourceType; resourceId: string | null;
  resourceName: string | null; status: 'SUCCEEDED' | 'FAILED'; summary: string; createdAt: string;
}
export interface ActivityPage {
  activities: ActivityRecord[]; page: number; pageSize: number; hasMore: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  repositoryUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
  description: string | null;
  repositoryUrl: string | null;
}

export type ComposeValidationStatus = 'NOT_VALIDATED' | 'VALID' | 'INVALID';
export type ComposeDeploymentStatus = 'NOT_DEPLOYED' | 'DEPLOYING' | 'RUNNING' | 'FAILED' | 'STOPPED' | 'CLEANING' | 'CLEANUP_FAILED' | 'REMOVED';

export interface ComposeEnvironmentSummary {
  id: string;
  name: string;
  validationStatus: ComposeValidationStatus;
  deploymentStatus: ComposeDeploymentStatus;
  deploymentProjectName: string | null;
  deploymentStartedAt: string | null;
  deploymentCompletedAt: string | null;
  lastDeploymentError: string | null;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  servicesCount: number;
}

export interface ComposeEnvironment extends ComposeEnvironmentSummary {
  composeYaml: string;
}

export interface ComposeEnvironmentInput {
  name: string;
  composeYaml: string;
}

export interface ComposeValidationResult {
  valid: boolean;
  validationStatus: 'VALID' | 'INVALID';
  servicesCount: number;
  errors: string[];
}

export interface ComposeDeploymentResult {
  environmentId: string;
  status: ComposeDeploymentStatus;
  projectName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  servicesCount?: number;
  lastError?: string | null;
}

export interface ComposeLifecycleResult {
  environmentId: string;
  action: DockerContainerAction;
  status: 'RUNNING' | 'STOPPED';
  completedAt: string;
}

export interface ComposeCleanupResult {
  environmentId: string;
  status: 'REMOVED';
  removedContainers: number;
  removedNetworks: number;
}

export interface ComposeContainerMetrics {
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
}

export interface ComposeContainerMonitoring {
  id: string;
  serviceName: string | null;
  name: string | null;
  state: string;
  health: string | null;
  image: string | null;
  createdAt: string | null;
  startedAt: string | null;
  metrics: ComposeContainerMetrics;
  metricsUnavailableReason: string | null;
}

export interface ComposeMonitoringResult {
  environmentId: string;
  sampledAt: string;
  containers: ComposeContainerMonitoring[];
}

export interface ComposeContainerLogs {
  environmentId: string;
  containerId: string;
  lines: { stream: 'stdout' | 'stderr'; text: string }[];
  truncated: boolean;
  tail?: number;
}

export interface DockerEngineStatus {
  reachable: boolean;
  engine: {
    version: string;
    apiVersion: string;
    operatingSystem: string;
    architecture: string;
  } | null;
  message?: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  createdAt: string;
  publishedPorts: string[];
  managed: boolean;
  managedByCurrentUser: boolean;
}

export interface DockerContainerMetrics {
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
}

export interface DockerContainerMonitoring {
  sampledAt: string;
  containers: { id: string; metrics: DockerContainerMetrics; metricsUnavailableReason: string | null }[];
}

export interface DockerContainerDetails {
  id: string; name: string; serviceName: string | null; state: string; health: string | null; image: string;
  createdAt: string | null; startedAt: string | null; restartPolicy: { name: string; maximumRetryCount: number };
  publishedPorts: string[]; networks: { name: string; id: string | null }[];
  mounts: { type: string; name: string | null; destination: string; readOnly: boolean }[];
  memoryLimitBytes: number | null; cpuLimitCores: number | null;
}

export interface DockerContainerLogs {
  containerId: string; lines: { stream: 'stdout' | 'stderr'; text: string }[]; truncated: boolean; tail: number;
}

export type DockerContainerAction = 'start' | 'stop' | 'restart';

export interface DockerContainerOperationResult {
  id: string;
  name: string;
  state: string;
  status: string;
  action: DockerContainerAction;
}

export interface DockerImage {
  id: string;
  repositoryTags: string[];
  sizeBytes: number;
  createdAt: string | null;
  containerCount: number;
  protected: boolean;
}

export interface DockerImageInspection extends DockerImage {
  operatingSystem: string | null;
  architecture: string | null;
  variant: string | null;
  config: {
    user: string;
    workingDir: string;
    exposedPorts: string[];
    volumes: string[];
  };
}

export interface DockerImagePullProgress {
  status: string;
  id?: string;
  current?: number;
  total?: number;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string | null;
  scope: string;
  labels: Record<string, string>;
  containerCount: number;
  inUse: boolean;
  protected: boolean;
}

export interface DockerVolumeContainer {
  id: string;
  name: string;
  state: string;
}

export interface DockerVolumeDetails extends DockerVolume {
  containers: DockerVolumeContainer[];
}

export interface DockerNetwork {
  id: string;
  shortId: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  enableIPv6: boolean;
  createdAt: string | null;
  labels: Record<string, string>;
  subnets: { subnet: string | null; gateway: string | null }[];
  containerCount: number;
  protected: boolean;
}

export interface DockerNetworkContainer {
  id: string;
  name: string;
  state: string | null;
}

export interface DockerNetworkDetails extends DockerNetwork {
  containers: DockerNetworkContainer[];
}

export interface DockerNetworkInventory {
  networks: DockerNetwork[];
  ipv6Supported: boolean;
}

export type DockerMetricQuality = 'exact' | 'approximate' | 'unavailable';

export interface DockerStorageMetric {
  bytes: number | null;
  quality: DockerMetricQuality;
}

export interface DockerOverview {
  collectedAt: string;
  lastSuccessfulRefreshAt: string | null;
  daemon: { status: 'connected' | 'unavailable' | 'error'; message: string | null };
  engine: DockerEngineStatus['engine'];
  containers: {
    total: number | null;
    running: number | null;
    stopped: number | null;
    paused: number | null;
    recent: { id: string; name: string; image: string; state: string; createdAt: string }[] | null;
  };
  images: { total: number | null; recent: { id: string; name: string; createdAt: string | null }[] | null };
  volumes: { total: number | null; inUse: number | null; unused: number | null };
  networks: { total: number | null; connected: number | null; unused: number | null };
  storage: {
    images: DockerStorageMetric;
    containerWritable: DockerStorageMetric;
    volumes: DockerStorageMetric;
    buildCache: DockerStorageMetric;
    total: DockerStorageMetric;
  };
  errors: Partial<Record<'engine' | 'containers' | 'images' | 'volumes' | 'networks' | 'storage', string>>;
}

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path.startsWith('/api/') ? path : `/api${path}`}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError('Could not reach the DockerPilot API. Check that the backend is running.', 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; details?: { message: string }[] } | null;
    const detail = body?.details?.map((item) => item.message).join(' ');
    let fallbackMessage = `Request failed (${response.status}).`;
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retrySeconds = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter)
        : retryAfter ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) : 0;
      fallbackMessage = retrySeconds > 0
        ? `Too many requests. Try again in ${retrySeconds} seconds.`
        : 'Too many requests. Try again shortly.';
    }
    throw new ApiError(detail || body?.error || fallbackMessage, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export function listActivity(filters: { actionType?: ActivityActionType; resourceType?: ActivityResourceType; page?: number } = {}): Promise<ActivityPage> {
  const query = new URLSearchParams();
  if (filters.actionType) query.set('actionType', filters.actionType);
  if (filters.resourceType) query.set('resourceType', filters.resourceType);
  if (filters.page && filters.page > 1) query.set('page', String(filters.page));
  return request<ActivityPage>(`/activity${query.size ? `?${query.toString()}` : ''}`);
}

export function fetchDockerStatus(): Promise<DockerEngineStatus> {
  return request<DockerEngineStatus>('/docker/status');
}

export function fetchDockerOverview(): Promise<DockerOverview> {
  return request<DockerOverview>('/docker/overview');
}

export function listDockerContainers(): Promise<DockerContainer[]> {
  return request<DockerContainer[]>('/docker/containers');
}

export function getDockerContainerMonitoring(): Promise<DockerContainerMonitoring> {
  return request<DockerContainerMonitoring>('/docker/containers/monitoring');
}

export function inspectDockerContainer(id: string): Promise<DockerContainerDetails> {
  return request<DockerContainerDetails>(`/docker/containers/${encodeURIComponent(id)}`);
}

export function getDockerContainerLogs(id: string, tail = 100): Promise<DockerContainerLogs> {
  return request<DockerContainerLogs>(`/docker/containers/${encodeURIComponent(id)}/logs?tail=${tail}`);
}

export function controlDockerContainer(id: string, action: DockerContainerAction): Promise<DockerContainerOperationResult> {
  return request<DockerContainerOperationResult>(`/docker/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
}

export function listDockerImages(): Promise<DockerImage[]> {
  return request<DockerImage[]>('/docker/images');
}

export function inspectDockerImage(id: string): Promise<DockerImageInspection> {
  return request<DockerImageInspection>(`/docker/images/${encodeURIComponent(id)}`);
}

export function removeDockerImage(id: string): Promise<void> {
  return request<void>(`/docker/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listDockerVolumes(): Promise<DockerVolume[]> {
  return request<DockerVolume[]>('/docker/volumes');
}

export function inspectDockerVolume(name: string): Promise<DockerVolumeDetails> {
  return request<DockerVolumeDetails>(`/docker/volumes/${encodeURIComponent(name)}`);
}

export function createDockerVolume(name: string): Promise<DockerVolume> {
  return request<DockerVolume>('/docker/volumes', { method: 'POST', body: JSON.stringify({ name }) });
}

export function removeDockerVolume(name: string, confirmation: string): Promise<void> {
  return request<void>(`/docker/volumes/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  });
}

export function listDockerNetworks(): Promise<DockerNetworkInventory> {
  return request<DockerNetworkInventory>('/docker/networks');
}

export function inspectDockerNetwork(id: string): Promise<DockerNetworkDetails> {
  return request<DockerNetworkDetails>(`/docker/networks/${encodeURIComponent(id)}`);
}

export function createDockerNetwork(input: { name: string; internal: boolean; enableIPv6: boolean }): Promise<DockerNetwork> {
  return request<DockerNetwork>('/docker/networks', { method: 'POST', body: JSON.stringify(input) });
}

export function removeDockerNetwork(id: string, confirmationName: string): Promise<void> {
  return request<void>(`/docker/networks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmationName }),
  });
}

export type DockerImagePullEvent =
  | ({ type: 'progress' } & DockerImagePullProgress)
  | { type: 'complete'; reference: string }
  | { type: 'error'; code: string; message: string };

export async function pullDockerImage(
  reference: string,
  onProgress: (progress: DockerImagePullProgress) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/api/docker/images/pull`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference }),
    });
  } catch {
    throw new ApiError('Could not reach the DockerPilot API. Check that the backend is running.', 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  if (!response.body) throw new ApiError('The image pull connection closed before progress was received.', 502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let completed = false;
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as DockerImagePullEvent;
    if (event.type === 'progress') onProgress(event);
    else if (event.type === 'complete') completed = true;
    else if (event.type === 'error') throw new ApiError(event.message, 502);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffered.trim()) consumeLine(buffered);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('The image pull connection ended unexpectedly.', 502);
  } finally {
    reader.releaseLock();
  }
  if (!completed) throw new ApiError('The image pull ended before Docker confirmed completion.', 502);
}

export function listProjects(): Promise<Project[]> {
  return request<Project[]>('/projects');
}

export function getProject(id: string): Promise<Project> {
  return request<Project>(`/projects/${encodeURIComponent(id)}`);
}

export function createProject(input: ProjectInput): Promise<Project> {
  return request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) });
}

export function updateProject(id: string, input: ProjectInput): Promise<Project> {
  return request<Project>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function createComposeEnvironment(projectId: string, input: ComposeEnvironmentInput): Promise<ComposeEnvironmentSummary> {
  return request<ComposeEnvironmentSummary>(`/projects/${encodeURIComponent(projectId)}/compose`, { method: 'POST', body: JSON.stringify(input) });
}

export function listComposeEnvironments(projectId: string): Promise<ComposeEnvironmentSummary[]> {
  return request<ComposeEnvironmentSummary[]>(`/projects/${encodeURIComponent(projectId)}/compose`);
}

export function getComposeEnvironment(id: string): Promise<ComposeEnvironment> {
  return request<ComposeEnvironment>(`/compose/${encodeURIComponent(id)}`);
}

export function updateComposeEnvironment(id: string, input: ComposeEnvironmentInput): Promise<ComposeEnvironmentSummary> {
  return request<ComposeEnvironmentSummary>(`/compose/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteComposeEnvironment(id: string): Promise<void> {
  return request<void>(`/compose/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function validateComposeEnvironment(id: string): Promise<ComposeValidationResult> {
  return request<ComposeValidationResult>(`/compose/${encodeURIComponent(id)}/validate`, { method: 'POST' });
}

export function deployComposeEnvironment(id: string): Promise<ComposeDeploymentResult> {
  return request<ComposeDeploymentResult>(`/compose/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
}

export function getComposeDeploymentStatus(id: string): Promise<ComposeDeploymentResult> {
  return request<ComposeDeploymentResult>(`/compose/${encodeURIComponent(id)}/deployment`);
}

export function operateComposeDeployment(id: string, action: DockerContainerAction): Promise<ComposeLifecycleResult> {
  return request<ComposeLifecycleResult>(`/compose/${encodeURIComponent(id)}/deployment/${action}`, { method: 'POST' });
}

export function cleanupComposeDeployment(id: string): Promise<ComposeCleanupResult> {
  return request<ComposeCleanupResult>(`/compose/${encodeURIComponent(id)}/deployment`, { method: 'DELETE' });
}

export function getComposeMonitoring(id: string): Promise<ComposeMonitoringResult> {
  return request<ComposeMonitoringResult>(`/compose/${encodeURIComponent(id)}/monitoring`);
}

export function getComposeContainerLogs(id: string, containerId: string, tail = 100): Promise<ComposeContainerLogs> {
  return request<ComposeContainerLogs>(`/compose/${encodeURIComponent(id)}/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`);
}

export function deleteProject(id: string): Promise<void> {
  return request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function registerAccount(input: Credentials & { name: string }): Promise<User> {
  const result = await request<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(input) });
  return result.user;
}

export async function loginAccount(input: Credentials): Promise<User> {
  const result = await request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
  return result.user;
}

export function logoutAccount(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

let currentUserRequest: Promise<User> | undefined;

export async function fetchCurrentUser(): Promise<User> {
  if (!currentUserRequest) {
    currentUserRequest = request<{ user: User }>('/auth/me')
      .then((result) => result.user)
      .finally(() => { currentUserRequest = undefined; });
  }
  return currentUserRequest;
}
