import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';

const IMAGE_ID = /^sha256:[a-f\d]{64}$/i;
const REGISTRY_HOST = '(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)';
const IMAGE_REFERENCE = new RegExp(`^(?:(?<registry>${REGISTRY_HOST}(?::(?<port>\\d{1,5}))?)/)?(?<repository>[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*)(?::(?<tag>[\\w][\\w.-]{0,127}))?$`);
const PULL_TIMEOUT_MS = 10 * 60 * 1000;
const INFRASTRUCTURE_LABEL = 'com.dockerpilot.infrastructure';

export interface DockerImageRecord {
  id: string;
  repositoryTags: string[];
  sizeBytes: number;
  createdAt: number | string;
  os?: string;
  architecture?: string;
  variant?: string;
  labels?: Record<string, string>;
  config?: {
    user?: string;
    workingDir?: string;
    exposedPorts?: string[];
    volumes?: string[];
  };
}

export interface DockerImageContainerReference {
  id: string;
  imageId: string;
  image: string;
  names: string[];
  state: string;
  labels: Record<string, string>;
}

export interface DockerImagePullProgress {
  status: string;
  id?: string;
  current?: number;
  total?: number;
}

export interface DockerImageClient {
  listImages(): Promise<DockerImageRecord[]>;
  inspectImage(id: string): Promise<DockerImageRecord>;
  listContainers(): Promise<DockerImageContainerReference[]>;
  pullImage(reference: string, onProgress: (progress: DockerImagePullProgress) => void, signal: AbortSignal): Promise<void>;
  removeImage(id: string): Promise<void>;
}

export interface DockerImageSummary {
  id: string;
  repositoryTags: string[];
  sizeBytes: number;
  createdAt: string | null;
  containerCount: number;
  protected: boolean;
}

export interface DockerImageInspection extends DockerImageSummary {
  operatingSystem: string | null;
  architecture: string | null;
  variant: string | null;
  config: NonNullable<DockerImageRecord['config']>;
}

export interface ImagePullOperation {
  reference: string;
  run(onProgress: (progress: DockerImagePullProgress) => void): Promise<void>;
}

export function normalizeImageReference(input: unknown): string {
  if (typeof input !== 'string') {
    throw new AppError('Enter a valid image name and optional tag.', 400, 'INVALID_IMAGE_REFERENCE');
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 300) {
    throw new AppError('Image references must be 300 characters or fewer.', 400, 'INVALID_IMAGE_REFERENCE');
  }
  const match = IMAGE_REFERENCE.exec(trimmed);
  if (!match?.groups) {
    throw new AppError('Enter a valid image name and optional tag, such as nginx:alpine.', 400, 'INVALID_IMAGE_REFERENCE');
  }
  const port = match.groups.port ? Number(match.groups.port) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new AppError('The registry port must be between 1 and 65535.', 400, 'INVALID_IMAGE_REFERENCE');
  }
  const repository = `${match.groups.registry ? `${match.groups.registry}/` : ''}${match.groups.repository}`;
  if (repository.length > 255) {
    throw new AppError('Image repository names must be 255 characters or fewer.', 400, 'INVALID_IMAGE_REFERENCE');
  }
  return `${repository}:${match.groups.tag ?? 'latest'}`;
}

function assertImageId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !IMAGE_ID.test(id)) {
    throw new AppError('A full Docker image ID is required.', 400, 'INVALID_IMAGE_ID');
  }
}

function imageCreatedAt(value: number | string): string | null {
  const date = typeof value === 'number'
    ? new Date(value * 1000)
    : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isInfrastructureContainer(container: DockerImageContainerReference): boolean {
  return container.labels[INFRASTRUCTURE_LABEL] === 'true'
    || container.labels['com.docker.compose.project']?.toLowerCase() === 'dockerpilot'
    || container.names.some((name) => /^\/?dockerpilot-postgres(?:-\d+)?$/i.test(name));
}

function imageIsProtected(image: DockerImageRecord, containers: DockerImageContainerReference[]): boolean {
  if (image.labels?.[INFRASTRUCTURE_LABEL] === 'true') return true;
  return containers.some((container) => container.imageId.toLowerCase() === image.id.toLowerCase() && isInfrastructureContainer(container));
}

function safeConfig(config: DockerImageRecord['config']): NonNullable<DockerImageRecord['config']> {
  return {
    user: config?.user ?? '',
    workingDir: config?.workingDir ?? '',
    exposedPorts: config?.exposedPorts ?? [],
    volumes: config?.volumes ?? [],
  };
}

function dockerErrorFields(error: unknown): { code?: string; statusCode?: number; message?: string } {
  if (!error || typeof error !== 'object') return {};
  const value = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    statusCode: typeof value.statusCode === 'number' ? value.statusCode : undefined,
    message: typeof value.message === 'string' ? value.message.slice(0, 500) : undefined,
  };
}

function translateImageError(error: unknown, operation: 'read' | 'pull' | 'remove'): Error {
  if (error instanceof AppError || error instanceof DockerUnavailableError) return error;
  const { code, statusCode, message = '' } = dockerErrorFields(error);
  if (operation === 'pull') {
    if (statusCode === 401 || statusCode === 403 || /unauthorized|authentication required|pull access denied/i.test(message)) {
      return new AppError('The registry requires authentication or does not allow this image pull.', 401, 'IMAGE_REGISTRY_AUTH_REQUIRED');
    }
    if (statusCode === 404 || /manifest unknown|repository does not exist|not found/i.test(message)) {
      return new AppError('The image or tag was not found in the registry.', 404, 'IMAGE_NOT_FOUND');
    }
    if (['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(code ?? '')
      || /network|dns|timed out|timeout|connection reset/i.test(message)) {
      return new AppError('Docker could not reach the image registry. Check the network and try again.', 502, 'IMAGE_PULL_NETWORK_ERROR');
    }
    return new AppError('Docker could not pull this image. Check the image reference and registry access.', 502, 'IMAGE_PULL_FAILED');
  }
  if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPIPE'].includes(code ?? '') || statusCode === 503) {
    return new DockerUnavailableError();
  }
  if (statusCode === 404) return new AppError('The selected image is no longer available.', 404, 'IMAGE_NOT_FOUND');
  if (statusCode === 409) return new AppError('Docker is using this image and cannot remove it safely.', 409, 'IMAGE_IN_USE');
  return new AppError(operation === 'remove'
    ? 'Docker could not remove this image safely.'
    : 'Docker could not read image details.', 502, 'IMAGE_OPERATION_FAILED');
}

function toSummary(image: DockerImageRecord, containers: DockerImageContainerReference[]): DockerImageSummary {
  return {
    id: image.id,
    repositoryTags: (image.repositoryTags ?? []).filter((tag) => tag !== '<none>:<none>'),
    sizeBytes: Number.isFinite(image.sizeBytes) ? Math.max(0, image.sizeBytes) : 0,
    createdAt: imageCreatedAt(image.createdAt),
    containerCount: containers.filter((container) => container.imageId.toLowerCase() === image.id.toLowerCase()).length,
    protected: imageIsProtected(image, containers),
  };
}

export function createDockerImageService(client: DockerImageClient, pullTimeoutMs = PULL_TIMEOUT_MS) {
  const activePulls = new Set<string>();

  async function listImages(): Promise<DockerImageSummary[]> {
    try {
      const [images, containers] = await Promise.all([client.listImages(), client.listContainers()]);
      return images.map((image) => toSummary(image, containers))
        .sort((left, right) => left.id.localeCompare(right.id));
    } catch (error) {
      throw translateImageError(error, 'read');
    }
  }

  async function inspectImage(id: unknown): Promise<DockerImageInspection> {
    assertImageId(id);
    try {
      const [image, containers] = await Promise.all([client.inspectImage(id), client.listContainers()]);
      const summary = toSummary(image, containers);
      return {
        ...summary,
        operatingSystem: image.os || null,
        architecture: image.architecture || null,
        variant: image.variant || null,
        config: safeConfig(image.config),
      };
    } catch (error) {
      throw translateImageError(error, 'read');
    }
  }

  function beginPull(input: unknown): ImagePullOperation {
    const reference = normalizeImageReference(input);
    const key = reference;
    if (activePulls.has(key)) {
      throw new AppError('A pull for this image is already in progress.', 409, 'IMAGE_PULL_IN_PROGRESS');
    }
    activePulls.add(key);
    let started = false;
    return {
      reference,
      async run(onProgress) {
        if (started) throw new AppError('This image pull has already started.', 409, 'IMAGE_PULL_IN_PROGRESS');
        started = true;
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const timedOut = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new AppError('The image pull timed out. Try again when the registry is reachable.', 504, 'IMAGE_PULL_TIMEOUT'));
            }, pullTimeoutMs);
          });
          await Promise.race([client.pullImage(reference, onProgress, controller.signal), timedOut]);
        } catch (error) {
          throw translateImageError(error, 'pull');
        } finally {
          if (timeout) clearTimeout(timeout);
          activePulls.delete(key);
        }
      },
    };
  }

  async function removeImage(id: unknown): Promise<void> {
    assertImageId(id);
    try {
      const [image, containers] = await Promise.all([client.inspectImage(id), client.listContainers()]);
      if (imageIsProtected(image, containers)) {
        throw new AppError('This image is used by DockerPilot infrastructure and is protected.', 403, 'IMAGE_PROTECTED');
      }
      const references = containers.filter((container) => container.imageId === image.id);
      if (references.length > 0) {
        const running = references.filter((container) => container.state.toLowerCase() === 'running').length;
        const stopped = references.length - running;
        throw new AppError(
          `This image is in use by ${references.length} container${references.length === 1 ? '' : 's'} (${running} running, ${stopped} stopped). Remove those containers first.`,
          409,
          'IMAGE_IN_USE',
        );
      }
      await client.removeImage(image.id);
    } catch (error) {
      throw translateImageError(error, 'remove');
    }
  }

  return { listImages, inspectImage, beginPull, removeImage };
}
