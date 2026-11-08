import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import { createDockerImageService, type DockerImageClient } from './docker-image.service.js';
import { createDockerVolumeService, type DockerVolumeClient } from './docker-volume.service.js';
import { createDockerNetworkService, type DockerNetworkClient, type DockerNetworkRecord } from './docker-network.service.js';
import { createDockerOverviewService, type DockerSystemDiskUsage } from './docker-overview.service.js';
import { readDockerStats } from './docker-stats.js';

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

export interface DockerContainerSummary {
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

export type ContainerControlAction = 'start' | 'stop' | 'restart';

export interface DockerContainerOperationResult {
  id: string;
  name: string;
  state: string;
  status: string;
  action: ContainerControlAction;
}

export interface ComposeDeploymentIdentity {
  ownerId: string;
  projectId: string;
  environmentId: string;
  composeProjectName: string;
}

export interface ComposeDeploymentResources {
  resourceCount: number;
  containerCount: number;
  runningContainerCount: number;
  safeToOperate: boolean;
  containerIds: string[];
  networkIds: string[];
}

export type ComposeDockerResourceType = 'container' | 'network';

export interface ComposeDockerResource {
  type: ComposeDockerResourceType;
  id: string;
  labels: Record<string, string>;
  attachedContainerIds: string[];
  running?: boolean;
}

export interface ComposeContainerDetails {
  id: string;
  name: string;
  serviceName: string | null;
  state: string;
  health: string | null;
  image: string;
  createdAt: string | null;
  startedAt: string | null;
  labels: Record<string, string>;
}

export interface DockerContainerDetails extends ComposeContainerDetails {
  restartPolicy: { name: string; maximumRetryCount: number };
  publishedPorts: string[];
  networks: { name: string; id: string | null }[];
  mounts: { type: string; name: string | null; destination: string; readOnly: boolean }[];
  memoryLimitBytes: number | null;
  cpuLimitCores: number | null;
}

const MANAGED_LABEL = 'com.dockerpilot.managed';
const OWNER_LABEL = 'com.dockerpilot.owner-id';
const PROJECT_ID_LABEL = 'com.dockerpilot.project-id';
const ENVIRONMENT_ID_LABEL = 'com.dockerpilot.environment-id';
const INFRASTRUCTURE_LABEL = 'com.dockerpilot.infrastructure';
const inFlightOperations = new Set<string>();

function createDockerClient(): Docker {
  if (env.DOCKER_SOCKET_PATH) {
    return new Docker({ socketPath: env.DOCKER_SOCKET_PATH, timeout: 30_000 });
  }

  // Docker Desktop for macOS keeps its context socket under the current user's
  // home directory. Resolve it dynamically; don't bake a developer path in.
  const desktopSocket = join(homedir(), '.docker', 'run', 'docker.sock');
  if (!process.env.DOCKER_HOST && process.platform === 'darwin' && existsSync(desktopSocket)) {
    return new Docker({ socketPath: desktopSocket, timeout: 30_000 });
  }

  // Dockerode uses its normal local endpoint (or DOCKER_HOST when configured).
  return new Docker({ timeout: 30_000 });
}

const docker = createDockerClient();

const imageClient: DockerImageClient = {
  async listImages() {
    return (await docker.listImages({ all: true })).map((image) => ({
      id: image.Id,
      repositoryTags: image.RepoTags ?? [],
      sizeBytes: image.Size,
      createdAt: image.Created,
      labels: image.Labels ?? {},
    }));
  },
  async inspectImage(id) {
    const image = await docker.getImage(id).inspect();
    const config = image.Config;
    return {
      id: image.Id,
      repositoryTags: image.RepoTags ?? [],
      sizeBytes: image.Size,
      createdAt: image.Created,
      os: image.Os,
      architecture: image.Architecture,
      variant: image.Variant,
      labels: config.Labels ?? {},
      config: {
        user: config.User,
        workingDir: config.WorkingDir,
        exposedPorts: Object.keys(config.ExposedPorts ?? {}),
        volumes: Object.keys(config.Volumes ?? {}),
      },
    };
  },
  async listContainers() {
    return (await docker.listContainers({ all: true })).map((container) => ({
      id: container.Id,
      imageId: container.ImageID,
      image: container.Image,
      names: container.Names ?? [],
      state: container.State,
      labels: container.Labels ?? {},
    }));
  },
  async pullImage(reference, onProgress, signal) {
    const stream = await docker.pull(reference);
    const destroyable = stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
    const abort = () => destroyable.destroy?.(new Error('Image pull was aborted.'));
    if (signal.aborted) {
      abort();
      throw new Error('Image pull was aborted.');
    }
    signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve(), (event: unknown) => {
          if (!event || typeof event !== 'object') return;
          const value = event as { status?: unknown; id?: unknown; progressDetail?: { current?: unknown; total?: unknown } };
          if (typeof value.status !== 'string') return;
          onProgress({
            status: value.status.slice(0, 160),
            ...(typeof value.id === 'string' ? { id: value.id.slice(0, 80) } : {}),
            ...(typeof value.progressDetail?.current === 'number' && Number.isFinite(value.progressDetail.current)
              ? { current: Math.max(0, value.progressDetail.current) } : {}),
            ...(typeof value.progressDetail?.total === 'number' && Number.isFinite(value.progressDetail.total)
              ? { total: Math.max(0, value.progressDetail.total) } : {}),
          });
        });
      });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  },
  async removeImage(id) {
    await docker.getImage(id).remove({ force: false, noprune: true });
  },
};

export const dockerImageService = createDockerImageService(imageClient);

const volumeClient: DockerVolumeClient = {
  async listVolumes() {
    const result = await docker.listVolumes();
    return (result.Volumes ?? []).map((volume) => ({
      name: volume.Name,
      driver: volume.Driver,
      mountpoint: volume.Mountpoint,
      createdAt: (volume as Docker.VolumeInspectInfo & { CreatedAt?: string }).CreatedAt ?? null,
      scope: volume.Scope,
      labels: volume.Labels ?? {},
    }));
  },
  async inspectVolume(name) {
    const volume = await docker.getVolume(name).inspect();
    return {
      name: volume.Name,
      driver: volume.Driver,
      mountpoint: volume.Mountpoint,
      createdAt: (volume as Docker.VolumeInspectInfo & { CreatedAt?: string }).CreatedAt ?? null,
      scope: volume.Scope,
      labels: volume.Labels ?? {},
    };
  },
  async listContainers() {
    const containers = await docker.listContainers({ all: true });
    return containers.flatMap((container) => (container.Mounts ?? [])
      .filter((mount) => mount.Type === 'volume' && Boolean(mount.Name))
      .map((mount) => ({
        id: container.Id.slice(0, 12),
        name: mount.Name!,
        state: container.State,
      })));
  },
  async createVolume(name) {
    await docker.createVolume({ Name: name, Driver: 'local' });
    const volume = await docker.getVolume(name).inspect();
    return {
      name: volume.Name,
      driver: volume.Driver,
      mountpoint: volume.Mountpoint,
      createdAt: (volume as Docker.VolumeInspectInfo & { CreatedAt?: string }).CreatedAt ?? null,
      scope: volume.Scope,
      labels: volume.Labels ?? {},
    };
  },
  async removeVolume(name) {
    await docker.getVolume(name).remove({ force: false });
  },
};

export const dockerVolumeService = createDockerVolumeService(volumeClient);

function toDockerNetworkRecord(network: Docker.NetworkInspectInfo): DockerNetworkRecord {
  return {
    id: network.Id,
    name: network.Name,
    driver: network.Driver,
    scope: network.Scope,
    internal: network.Internal,
    enableIPv6: network.EnableIPv6,
    createdAt: network.Created ?? null,
    labels: network.Labels ?? {},
    subnets: (network.IPAM?.Config ?? []).map((config) => ({ subnet: config.Subnet ?? null, gateway: config.Gateway ?? null })),
  };
}

const networkClient: DockerNetworkClient = {
  async listNetworks() {
    return (await docker.listNetworks()).map(toDockerNetworkRecord);
  },
  async inspectNetwork(id) {
    return toDockerNetworkRecord(await docker.getNetwork(id).inspect());
  },
  async listContainers() {
    const containers = await docker.listContainers({ all: true });
    return containers.map((container) => ({
      id: container.Id,
      name: (container.Names[0] ?? '').replace(/^\/+/, '') || container.Id.slice(0, 12),
      state: container.State?.toLowerCase() ?? null,
      networkIds: Object.values(container.NetworkSettings?.Networks ?? {})
        .map((network) => network.NetworkID)
        .filter((networkId): networkId is string => Boolean(networkId)),
    }));
  },
  async supportsIPv6() {
    const info = await docker.info() as { IPv6?: unknown };
    return info.IPv6 === true;
  },
  async createNetwork(name, options) {
    const network = await docker.createNetwork({
      Name: name,
      CheckDuplicate: true,
      Driver: 'bridge',
      Internal: options.internal,
      EnableIPv6: options.enableIPv6,
    });
    return toDockerNetworkRecord(await docker.getNetwork(network.id).inspect());
  },
  async removeNetwork(id) {
    await docker.getNetwork(id).remove();
  },
};

export const dockerNetworkService = createDockerNetworkService(networkClient);

function labelsMatchDeployment(labels: Record<string, string> | undefined, identity: ComposeDeploymentIdentity): boolean {
  if (!labels
    || labels[MANAGED_LABEL] !== 'true'
    || labels[OWNER_LABEL] !== identity.ownerId
    || labels[PROJECT_ID_LABEL] !== identity.projectId
    || labels[ENVIRONMENT_ID_LABEL] !== identity.environmentId
    || labels['com.docker.compose.project'] !== identity.composeProjectName) return false;
  return Object.keys(labels).every((label) => !label.startsWith('com.dockerpilot.')
    || [MANAGED_LABEL, OWNER_LABEL, PROJECT_ID_LABEL, ENVIRONMENT_ID_LABEL].includes(label));
}

function isDockerNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404);
}

function isInfrastructureContainer(labels: Record<string, string>, names: string[]): boolean {
  return labels[INFRASTRUCTURE_LABEL] === 'true'
    || labels['com.docker.compose.project']?.toLowerCase() === 'dockerpilot'
    || names.some((name) => /^\/?dockerpilot-postgres(?:-\d+)?$/i.test(name));
}

function toContainerSummary(container: Docker.ContainerInfo, userId: string): DockerContainerSummary {
  const rawName = container.Names[0] ?? '';
  const name = rawName.replace(/^\/+/, '') || container.Id.slice(0, 12);
  const managedLabel = container.Labels[MANAGED_LABEL] === 'true';
  const infrastructure = isInfrastructureContainer(container.Labels, container.Names);
  const managed = managedLabel && !infrastructure;

  return {
    id: container.Id.slice(0, 12),
    name,
    image: container.Image,
    state: container.State.toLowerCase(),
    status: container.Status,
    createdAt: new Date(container.Created * 1000).toISOString(),
    publishedPorts: [...new Set((container.Ports ?? [])
      .filter((port) => port.PublicPort > 0)
      .map((port) => `${port.PublicPort}:${port.PrivatePort}/${port.Type}`))],
    managed,
    managedByCurrentUser: managed && container.Labels[OWNER_LABEL] === userId,
  };
}

function getDockerErrorDetails(error: unknown): { statusCode?: number; code?: string } {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return {
    statusCode: typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined,
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
  };
}

function translateDockerError(error: unknown): Error {
  if (error instanceof DockerUnavailableError || error instanceof AppError) return error;

  const { statusCode, code } = getDockerErrorDetails(error);
  if (statusCode === 404) {
    return new AppError('Container not found or not available to this account.', 404, 'CONTAINER_NOT_FOUND');
  }
  if (statusCode === 304 || statusCode === 409) {
    return new AppError('Container state changed or conflicts with the requested operation.', 409, 'CONTAINER_STATE_CONFLICT');
  }
  if (statusCode === 503 || ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPIPE', 'ETIMEDOUT'].includes(code ?? '')) {
    return new DockerUnavailableError();
  }
  return new AppError('Docker Engine could not complete the container operation.', 502, 'DOCKER_OPERATION_FAILED');
}

function assertControllableContainer(info: Docker.ContainerInspectInfo, userId: string): void {
  const labels = info.Config?.Labels ?? {};
  const infrastructure = isInfrastructureContainer(labels, info.Name ? [info.Name] : []);
  if (infrastructure || labels[MANAGED_LABEL] !== 'true' || labels[OWNER_LABEL] !== userId) {
    throw new AppError('Container not found or not available to this account.', 404, 'CONTAINER_NOT_FOUND');
  }
}

async function inspectOwnedContainer(container: Docker.Container, userId: string): Promise<Docker.ContainerInspectInfo> {
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch (error) {
    throw translateDockerError(error);
  }
  assertControllableContainer(info, userId);
  return info;
}

export const dockerService = {
  async getStatus(): Promise<DockerEngineStatus> {
    try {
      const version = await docker.version();
      return {
        reachable: true,
        engine: {
          version: version.Version,
          apiVersion: version.ApiVersion,
          operatingSystem: version.Os,
          architecture: version.Arch,
        },
      };
    } catch {
      return {
        reachable: false,
        engine: null,
        message: 'Docker Engine is unavailable. Start Docker Desktop and check its local socket connection.',
      };
    }
  },

  async listContainers(userId: string): Promise<DockerContainerSummary[]> {
    try {
      const containers = await docker.listContainers({ all: true });
      return containers.map((container) => toContainerSummary(container, userId));
    } catch (error) {
      throw translateDockerError(error);
    }
  },

  async inspectContainer(id: string): Promise<DockerContainerDetails | null> {
    try {
      const info = await docker.getContainer(id).inspect();
      const labels = info.Config?.Labels ?? {};
      const cpuPeriod = info.HostConfig?.CpuPeriod;
      const cpu = info.HostConfig?.NanoCpus && info.HostConfig.NanoCpus > 0
        ? info.HostConfig.NanoCpus / 1_000_000_000
        : info.HostConfig?.CpuQuota && info.HostConfig.CpuQuota > 0 && cpuPeriod && cpuPeriod > 0
          ? info.HostConfig.CpuQuota / cpuPeriod
          : null;
      return {
        id: info.Id,
        name: info.Name.replace(/^\/+/, '') || info.Id.slice(0, 12),
        serviceName: labels['com.docker.compose.service'] ?? null,
        state: info.State.Status.toLowerCase(),
        health: info.State.Health?.Status?.toLowerCase() ?? null,
        image: info.Config.Image,
        createdAt: info.Created && Number.isFinite(Date.parse(info.Created)) ? new Date(info.Created).toISOString() : null,
        startedAt: info.State.StartedAt && Number.isFinite(Date.parse(info.State.StartedAt)) ? new Date(info.State.StartedAt).toISOString() : null,
        labels,
        restartPolicy: { name: info.HostConfig?.RestartPolicy?.Name ?? 'no', maximumRetryCount: info.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0 },
        publishedPorts: [...new Set(Object.entries(info.NetworkSettings?.Ports ?? {}).flatMap(([containerPort, bindings]) =>
          (bindings ?? []).map((binding) => `${binding.HostPort}:${containerPort}`)))],
        networks: Object.entries(info.NetworkSettings?.Networks ?? {}).map(([name, network]) => ({ name, id: network.NetworkID ?? null })),
        mounts: (info.Mounts ?? []).map((mount) => ({ type: mount.Type, name: mount.Type === 'volume' ? mount.Name ?? null : null, destination: mount.Destination, readOnly: !mount.RW })),
        memoryLimitBytes: info.HostConfig?.Memory && info.HostConfig.Memory > 0 ? info.HostConfig.Memory : null,
        cpuLimitCores: cpu,
      };
    } catch (error) {
      if (isDockerNotFound(error)) return null;
      throw translateDockerError(error);
    }
  },

  async getContainerStats(id: string): Promise<Docker.ContainerStats> {
    try {
      const stream = await docker.getContainer(id).stats({ stream: true });
      return await readDockerStats(stream as NodeJS.ReadableStream & { destroy: () => void });
    }
    catch (error) { throw translateDockerError(error); }
  },

  async listComposeDeploymentResources(
    identity: ComposeDeploymentIdentity,
    registeredContainerIds: string[],
    registeredNetworkIds: string[],
  ): Promise<ComposeDockerResource[]> {
    try {
      const [containers, networks] = await Promise.all([
        docker.listContainers({ all: true }),
        docker.listNetworks(),
      ]);
      const knownContainers = new Set(registeredContainerIds);
      const knownNetworks = new Set(registeredNetworkIds);
      const isCandidate = (labels: Record<string, string> | undefined, id: string, known: Set<string>) =>
        known.has(id)
        || labels?.['com.docker.compose.project'] === identity.composeProjectName
        || labels?.[ENVIRONMENT_ID_LABEL] === identity.environmentId;
      return [
        ...containers
          .filter((container) => isCandidate(container.Labels, container.Id, knownContainers))
          .map((container): ComposeDockerResource => ({
            type: 'container',
            id: container.Id,
            labels: container.Labels ?? {},
            attachedContainerIds: [],
            running: container.State.toLowerCase() === 'running',
          })),
        ...networks
          .filter((network) => isCandidate(network.Labels, network.Id, knownNetworks))
          .map((network): ComposeDockerResource => ({
            type: 'network',
            id: network.Id,
            labels: network.Labels ?? {},
            attachedContainerIds: [],
          })),
      ];
    } catch (error) {
      throw translateDockerError(error);
    }
  },

  async inspectComposeDeployment(identity: ComposeDeploymentIdentity): Promise<ComposeDeploymentResources> {
    const resources = await this.listComposeDeploymentResources(identity, [], []);
    const containers = resources.filter((resource) => resource.type === 'container');
    const networks = resources.filter((resource) => resource.type === 'network');
    return {
      resourceCount: resources.length,
      containerCount: containers.length,
      runningContainerCount: containers.filter((resource) => resource.running).length,
      safeToOperate: resources.every((resource) => labelsMatchDeployment(resource.labels, identity)),
      containerIds: containers.map((resource) => resource.id),
      networkIds: networks.map((resource) => resource.id),
    };
  },

  async inspectComposeResource(type: ComposeDockerResourceType, id: string): Promise<ComposeDockerResource | null> {
    try {
      if (type === 'container') {
        const info = await docker.getContainer(id).inspect();
        return { type, id: info.Id, labels: info.Config?.Labels ?? {}, attachedContainerIds: [] };
      }
      const info = await docker.getNetwork(id).inspect();
      return {
        type,
        id: info.Id,
        labels: info.Labels ?? {},
        attachedContainerIds: Object.keys(info.Containers ?? {}),
      };
    } catch (error) {
      if (isDockerNotFound(error)) return null;
      throw translateDockerError(error);
    }
  },

  async inspectComposeContainer(id: string): Promise<ComposeContainerDetails | null> {
    try {
      const info = await docker.getContainer(id).inspect();
      const labels = info.Config?.Labels ?? {};
      return {
        id: info.Id,
        name: info.Name.replace(/^\/+/, '') || info.Id.slice(0, 12),
        serviceName: labels['com.docker.compose.service'] ?? null,
        state: info.State.Status.toLowerCase(),
        health: info.State.Health?.Status?.toLowerCase() ?? null,
        image: info.Config.Image,
        createdAt: info.Created && Number.isFinite(Date.parse(info.Created)) ? new Date(info.Created).toISOString() : null,
        startedAt: info.State.StartedAt && Number.isFinite(Date.parse(info.State.StartedAt))
          ? new Date(info.State.StartedAt).toISOString()
          : null,
        labels,
      };
    } catch (error) {
      if (isDockerNotFound(error)) return null;
      throw translateDockerError(error);
    }
  },

  async getComposeContainerStats(id: string): Promise<Docker.ContainerStats> {
    try {
      const stream = await docker.getContainer(id).stats({ stream: true });
      return await readDockerStats(stream as NodeJS.ReadableStream & { destroy: () => void });
    } catch (error) {
      throw translateDockerError(error);
    }
  },

  async getComposeContainerLogs(id: string, tail = 100): Promise<{ data: Buffer; tty: boolean }> {
    try {
      const container = docker.getContainer(id);
      const [info, data] = await Promise.all([
        container.inspect(),
        container.logs({
          stdout: true,
          stderr: true,
          follow: false,
          tail,
          timestamps: true,
          details: false,
          abortSignal: AbortSignal.timeout(15_000),
        }),
      ]);
      return { data, tty: Boolean(info.Config?.Tty) };
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'TimeoutError') {
        throw new AppError('Docker did not return recent logs in time. Try again.', 504, 'CONTAINER_LOGS_TIMEOUT');
      }
      throw translateDockerError(error);
    }
  },

  async removeComposeResource(type: ComposeDockerResourceType, id: string): Promise<void> {
    try {
      if (type === 'container') {
        await docker.getContainer(id).remove({ force: true, v: false, link: false });
      } else {
        await docker.getNetwork(id).remove();
      }
    } catch (error) {
      if (isDockerNotFound(error)) return;
      throw translateDockerError(error);
    }
  },

  async controlContainer(
    id: string,
    userId: string,
    action: ContainerControlAction,
    verifyDeploymentOwnership?: (container: Docker.ContainerInspectInfo) => Promise<void>,
  ): Promise<DockerContainerOperationResult> {
    const container = docker.getContainer(id);
    const initialInfo = await inspectOwnedContainer(container, userId);
    const operationKey = initialInfo.Id.toLowerCase();

    if (inFlightOperations.has(operationKey)) {
      throw new AppError('Another operation is already in progress for this container.', 409, 'CONTAINER_OPERATION_IN_PROGRESS');
    }

    inFlightOperations.add(operationKey);
    try {
      const currentInfo = await inspectOwnedContainer(container, userId);
      await verifyDeploymentOwnership?.(currentInfo);
      const state = currentInfo.State.Status.toLowerCase();
      const allowedStates: Record<ContainerControlAction, string[]> = {
        start: ['created', 'exited'],
        stop: ['running'],
        restart: ['running'],
      };

      if (!allowedStates[action].includes(state)) {
        throw new AppError(`Cannot ${action} a container in the ${state} state.`, 409, 'CONTAINER_STATE_CONFLICT');
      }

      try {
        if (action === 'start') await container.start();
        else if (action === 'stop') await container.stop();
        else await container.restart();
      } catch (error) {
        throw translateDockerError(error);
      }

      const finalInfo = await inspectOwnedContainer(container, userId);
      await verifyDeploymentOwnership?.(finalInfo);
      const finalState = finalInfo.State.Status.toLowerCase();
      const expectedState = action === 'stop' ? 'exited' : 'running';
      if (finalState !== expectedState) {
        throw new AppError(`Docker did not move the container to the expected ${expectedState} state.`, 409, 'CONTAINER_STATE_CONFLICT');
      }

      return {
        id: finalInfo.Id.slice(0, 12),
        name: finalInfo.Name.replace(/^\/+/, '') || finalInfo.Id.slice(0, 12),
        state: finalState,
        status: finalState === 'running' ? 'Running' : 'Stopped',
        action,
      };
    } finally {
      inFlightOperations.delete(operationKey);
    }
  },
};

export const dockerOverviewService = createDockerOverviewService({
  getEngineStatus: () => dockerService.getStatus(),
  listContainers: (userId) => dockerService.listContainers(userId),
  listImages: () => dockerImageService.listImages(),
  listVolumes: () => dockerVolumeService.listVolumes(),
  listNetworks: () => dockerNetworkService.listNetworks(),
  async getDiskUsage() {
    return await docker.df() as DockerSystemDiskUsage;
  },
});
