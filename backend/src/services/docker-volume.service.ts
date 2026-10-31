import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const INFRASTRUCTURE_LABEL = 'com.dockerpilot.infrastructure';
const SAFE_LABELS = new Set([
  'com.docker.compose.project',
  'com.docker.compose.volume',
  'com.dockerpilot.managed',
  INFRASTRUCTURE_LABEL,
]);

export interface DockerVolumeReference {
  id: string;
  name: string;
  state: string;
}

export interface DockerVolumeRecord {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt?: string | null;
  scope: string;
  labels?: Record<string, string>;
}

export interface DockerVolumeClient {
  listVolumes(): Promise<DockerVolumeRecord[]>;
  inspectVolume(name: string): Promise<DockerVolumeRecord>;
  listContainers(): Promise<DockerVolumeReference[]>;
  createVolume(name: string): Promise<DockerVolumeRecord>;
  removeVolume(name: string): Promise<void>;
}

export interface DockerVolumeContainer {
  id: string;
  name: string;
  state: string;
}

export interface DockerVolumeSummary extends DockerVolumeRecord {
  createdAt: string | null;
  labels: Record<string, string>;
  containerCount: number;
  inUse: boolean;
  protected: boolean;
}

export interface DockerVolumeDetails extends DockerVolumeSummary {
  containers: DockerVolumeContainer[];
}

export function validateDockerVolumeName(input: unknown): string {
  if (typeof input !== 'string' || !VOLUME_NAME.test(input)) {
    throw new AppError('Use a volume name starting with a letter or number and containing only letters, numbers, dots, underscores, or hyphens (up to 255 characters).', 400, 'INVALID_VOLUME_NAME');
  }
  return input;
}

function errorInfo(error: unknown): { statusCode?: number; code?: string } {
  if (!error || typeof error !== 'object') return {};
  const value = error as { statusCode?: unknown; code?: unknown };
  return {
    statusCode: typeof value.statusCode === 'number' ? value.statusCode : undefined,
    code: typeof value.code === 'string' ? value.code : undefined,
  };
}

function translateVolumeError(error: unknown): Error {
  if (error instanceof AppError || error instanceof DockerUnavailableError) return error;
  const { statusCode, code } = errorInfo(error);
  if (statusCode === 404) return new AppError('The selected Docker volume was not found.', 404, 'VOLUME_NOT_FOUND');
  if (statusCode === 409) return new AppError('Docker could not change the volume because it is in use or already exists.', 409, 'VOLUME_CONFLICT');
  if (statusCode === 503 || ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPIPE', 'ETIMEDOUT'].includes(code ?? '')) {
    return new DockerUnavailableError();
  }
  return new AppError('Docker Engine could not complete the volume operation.', 502, 'VOLUME_OPERATION_FAILED');
}

function safeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => SAFE_LABELS.has(key)));
}

function isProtected(volume: DockerVolumeRecord, labels: Record<string, string>): boolean {
  return labels[INFRASTRUCTURE_LABEL] === 'true'
    || labels['com.docker.compose.project']?.toLowerCase() === 'dockerpilot'
    || /^dockerpilot[-_]postgres(?:[-_].*)?$/i.test(volume.name);
}

function summary(volume: DockerVolumeRecord, references: DockerVolumeReference[]): DockerVolumeSummary {
  const containers = references.filter((container) => container.name === volume.name);
  const labels = safeLabels(volume.labels);
  return {
    name: volume.name,
    driver: volume.driver,
    mountpoint: volume.mountpoint,
    createdAt: volume.createdAt && Number.isFinite(Date.parse(volume.createdAt)) ? new Date(volume.createdAt).toISOString() : null,
    scope: volume.scope,
    labels,
    containerCount: containers.length,
    inUse: containers.length > 0,
    protected: isProtected(volume, labels),
  };
}

export function createDockerVolumeService(client: DockerVolumeClient) {
  const creating = new Set<string>();
  const removing = new Set<string>();

  async function getInventory(): Promise<{ volumes: DockerVolumeRecord[]; references: DockerVolumeReference[] }> {
    try {
      const [volumes, references] = await Promise.all([client.listVolumes(), client.listContainers()]);
      return { volumes, references };
    } catch (error) {
      throw translateVolumeError(error);
    }
  }

  return {
    async listVolumes(): Promise<DockerVolumeSummary[]> {
      const { volumes, references } = await getInventory();
      return volumes.map((volume) => summary(volume, references)).sort((a, b) => a.name.localeCompare(b.name));
    },

    async inspectVolume(input: unknown): Promise<DockerVolumeDetails> {
      const name = validateDockerVolumeName(input);
      try {
        const [volume, references] = await Promise.all([client.inspectVolume(name), client.listContainers()]);
        const result = summary(volume, references);
        return {
          ...result,
          containers: references.filter((container) => container.name === name)
            .map(({ id, name: containerName, state }) => ({ id, name: containerName, state }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      } catch (error) {
        throw translateVolumeError(error);
      }
    },

    async createVolume(input: unknown): Promise<DockerVolumeSummary> {
      const name = validateDockerVolumeName(input);
      if (creating.has(name)) throw new AppError('A request to create this volume is already in progress.', 409, 'VOLUME_CREATE_IN_PROGRESS');
      creating.add(name);
      try {
        const { volumes, references } = await getInventory();
        if (volumes.some((volume) => volume.name === name)) {
          throw new AppError('A Docker volume with this name already exists.', 409, 'VOLUME_ALREADY_EXISTS');
        }
        const created = await client.createVolume(name);
        return summary(created, references);
      } catch (error) {
        throw translateVolumeError(error);
      } finally {
        creating.delete(name);
      }
    },

    async removeVolume(input: unknown, confirmation: unknown): Promise<void> {
      const name = validateDockerVolumeName(input);
      if (confirmation !== name) throw new AppError('Confirm removal by providing the exact volume name.', 400, 'VOLUME_CONFIRMATION_REQUIRED');
      if (removing.has(name)) throw new AppError('A request to remove this volume is already in progress.', 409, 'VOLUME_REMOVE_IN_PROGRESS');
      removing.add(name);
      try {
        const [volume, references] = await Promise.all([client.inspectVolume(name), client.listContainers()]);
        const details = summary(volume, references);
        if (details.protected) throw new AppError('DockerPilot infrastructure volumes are protected and cannot be removed.', 403, 'VOLUME_PROTECTED');
        const attached = references.filter((container) => container.name === name);
        if (attached.length) {
          const running = attached.filter((container) => container.state.toLowerCase() === 'running').length;
          const stopped = attached.length - running;
          throw new AppError(`This volume is referenced by ${attached.length} container${attached.length === 1 ? '' : 's'} (${running} running, ${stopped} stopped). Remove those containers first.`, 409, 'VOLUME_IN_USE');
        }
        await client.removeVolume(name);
      } catch (error) {
        throw translateVolumeError(error);
      } finally {
        removing.delete(name);
      }
    },
  };
}
