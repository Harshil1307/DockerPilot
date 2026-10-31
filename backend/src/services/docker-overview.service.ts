import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import type { DockerContainerSummary, DockerEngineStatus } from './docker.service.js';
import type { DockerImageSummary } from './docker-image.service.js';
import type { DockerNetworkSummary } from './docker-network.service.js';
import type { DockerVolumeSummary } from './docker-volume.service.js';

const REQUEST_TIMEOUT_MS = 20_000;

export interface DockerOverviewDiskMetrics {
  images: { bytes: number | null; quality: 'exact' | 'approximate' | 'unavailable' };
  containerWritable: { bytes: number | null; quality: 'exact' | 'approximate' | 'unavailable' };
  volumes: { bytes: number | null; quality: 'exact' | 'approximate' | 'unavailable' };
  buildCache: { bytes: number | null; quality: 'exact' | 'approximate' | 'unavailable' };
  total: { bytes: number | null; quality: 'exact' | 'approximate' | 'unavailable' };
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
  storage: DockerOverviewDiskMetrics;
  errors: Partial<Record<'engine' | 'containers' | 'images' | 'volumes' | 'networks' | 'storage', string>>;
}

export interface DockerSystemDiskUsage {
  [key: string]: unknown;
}

export interface DockerOverviewDependencies {
  getEngineStatus(): Promise<DockerEngineStatus>;
  listContainers(userId: string): Promise<DockerContainerSummary[]>;
  listImages(): Promise<DockerImageSummary[]>;
  listVolumes(): Promise<DockerVolumeSummary[]>;
  listNetworks(): Promise<{ networks: DockerNetworkSummary[]; ipv6Supported: boolean }>;
  getDiskUsage(): Promise<DockerSystemDiskUsage>;
}

function finiteSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumRecords(value: unknown, field: string, subtractField?: string): number | null {
  if (!Array.isArray(value)) return null;
  let sum = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const size = finiteSize(record[field]);
    const subtract = subtractField ? finiteSize(record[subtractField]) : 0;
    if (size === null || subtract === null) return null;
    sum += Math.max(0, size - subtract);
  }
  return sum;
}

function sumVolumeRecords(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let sum = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || !('UsageData' in item)) return null;
    const usage = (item as { UsageData?: unknown }).UsageData;
    if (!usage || typeof usage !== 'object') return null;
    const size = finiteSize((usage as Record<string, unknown>).Size);
    if (size === null) return null;
    sum += size;
  }
  return sum;
}

function usageTotal(data: DockerSystemDiskUsage, keys: string[], legacyKey: string, legacySizeField: string, subtractField?: string): number | null {
  for (const key of keys) {
    const section = data[key];
    if (section && typeof section === 'object') {
      const record = section as Record<string, unknown>;
      const value = finiteSize(record.TotalSize ?? record.SizeBytes ?? record.Size);
      if (value !== null) return value;
    }
  }
  if (legacySizeField === 'UsageDataSize') return sumVolumeRecords(data[legacyKey]);
  return sumRecords(data[legacyKey], legacySizeField, subtractField);
}

function metric(bytes: number | null, quality: 'exact' | 'approximate' = 'exact') {
  return { bytes, quality: bytes === null ? 'unavailable' as const : quality };
}

export function summarizeDockerDiskUsage(data: DockerSystemDiskUsage): DockerOverviewDiskMetrics {
  const images = metric(usageTotal(data, ['ImagesUsage', 'ImageUsage', 'ImagesDiskUsage', 'ImageDiskUsage'], 'Images', 'Size', 'SharedSize'));
  const containerWritable = metric(usageTotal(data, ['ContainersUsage', 'ContainerUsage', 'ContainersDiskUsage', 'ContainerDiskUsage'], 'Containers', 'SizeRw'));
  const volumes = metric(usageTotal(data, ['VolumesUsage', 'VolumeUsage', 'VolumesDiskUsage', 'VolumeDiskUsage'], 'Volumes', 'UsageDataSize'));
  const buildCache = metric(usageTotal(data, ['BuildCacheUsage', 'BuildCacheDiskUsage'], 'BuildCache', 'Size'));
  const parts = [images.bytes, containerWritable.bytes, volumes.bytes, buildCache.bytes];
  const totalBytes = parts.every((part): part is number => part !== null) ? parts.reduce((sum, part) => sum + part, 0) : null;
  const totalQuality = totalBytes === null ? 'unavailable' as const
    : [images.quality, containerWritable.quality, volumes.quality, buildCache.quality].includes('approximate') ? 'approximate' as const : 'exact' as const;
  return { images, containerWritable, volumes, buildCache, total: { bytes: totalBytes, quality: totalQuality } };
}

function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof DockerUnavailableError || error instanceof AppError) return error.message;
  return fallback;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new AppError('Docker took too long to return overview data. Refresh and try again.', 504, 'DOCKER_OVERVIEW_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createDockerOverviewService(dependencies: DockerOverviewDependencies, timeoutMs = REQUEST_TIMEOUT_MS) {
  const inFlight = new Map<string, Promise<DockerOverview>>();

  function getOverview(userId: string): Promise<DockerOverview> {
    const existing = inFlight.get(userId);
    if (existing) return existing;
    const result = collect(userId).finally(() => inFlight.delete(userId));
    inFlight.set(userId, result);
    return result;
  }

  async function collect(userId: string): Promise<DockerOverview> {
    const errors: DockerOverview['errors'] = {};
    const [engineResult, containersResult, imagesResult, volumesResult, networksResult, diskResult] = await Promise.allSettled([
      withTimeout(dependencies.getEngineStatus(), timeoutMs),
      withTimeout(dependencies.listContainers(userId), timeoutMs),
      withTimeout(dependencies.listImages(), timeoutMs),
      withTimeout(dependencies.listVolumes(), timeoutMs),
      withTimeout(dependencies.listNetworks(), timeoutMs),
      withTimeout(dependencies.getDiskUsage(), timeoutMs),
    ]);
    const engineStatus = engineResult.status === 'fulfilled' ? engineResult.value : null;
    if (engineResult.status === 'rejected') errors.engine = safeMessage(engineResult.reason, 'Could not check Docker Engine status.');
    const daemon: DockerOverview['daemon'] = engineStatus
      ? engineStatus.reachable
        ? { status: 'connected', message: null }
        : { status: 'unavailable', message: engineStatus.message ?? 'Docker Engine is unavailable.' }
      : { status: 'error', message: errors.engine ?? 'Could not check Docker Engine status.' };

    const containers = containersResult.status === 'fulfilled' ? containersResult.value : null;
    if (containersResult.status === 'rejected') errors.containers = safeMessage(containersResult.reason, 'Could not load container inventory.');
    const images = imagesResult.status === 'fulfilled' ? imagesResult.value : null;
    if (imagesResult.status === 'rejected') errors.images = safeMessage(imagesResult.reason, 'Could not load image inventory.');
    const volumes = volumesResult.status === 'fulfilled' ? volumesResult.value : null;
    if (volumesResult.status === 'rejected') errors.volumes = safeMessage(volumesResult.reason, 'Could not load volume inventory.');
    const networkResult = networksResult.status === 'fulfilled' ? networksResult.value.networks : null;
    if (networksResult.status === 'rejected') errors.networks = safeMessage(networksResult.reason, 'Could not load network inventory.');
    const diskMetrics = diskResult.status === 'fulfilled' ? summarizeDockerDiskUsage(diskResult.value) : {
      images: metric(null), containerWritable: metric(null), volumes: metric(null), buildCache: metric(null), total: metric(null),
    };
    if (diskResult.status === 'rejected') {
      errors.storage = safeMessage(diskResult.reason, 'Docker storage usage is unavailable.');
    } else if (Object.values(diskMetrics).some((item) => item.bytes === null)) {
      errors.storage = 'One or more Docker storage usage metrics are unavailable from this Engine.';
    }

    const running = containers?.filter((container) => container.state === 'running').length ?? null;
    const paused = containers?.filter((container) => container.state === 'paused').length ?? null;
    const stopped = containers ? containers.length - (running ?? 0) - (paused ?? 0) : null;
    const recentContainers = containers?.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 5)
      .map(({ id, name, image, state, createdAt }) => ({ id, name, image, state, createdAt })) ?? null;
    const recentImages = images?.slice().sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '')).slice(0, 5)
      .map((image) => ({ id: image.id, name: image.repositoryTags[0] ?? 'Untagged image', createdAt: image.createdAt })) ?? null;
    const collectedAt = new Date().toISOString();
    return {
      collectedAt,
      lastSuccessfulRefreshAt: daemon.status === 'connected' && Object.keys(errors).length === 0 ? collectedAt : null,
      daemon,
      engine: engineStatus?.engine ?? null,
      containers: {
        total: containers?.length ?? null,
        running,
        stopped,
        paused,
        recent: recentContainers,
      },
      images: { total: images?.length ?? null, recent: recentImages },
      volumes: {
        total: volumes?.length ?? null,
        inUse: volumes ? volumes.filter((volume) => volume.inUse).length : null,
        unused: volumes ? volumes.filter((volume) => !volume.inUse).length : null,
      },
      networks: {
        total: networkResult?.length ?? null,
        connected: networkResult ? networkResult.filter((network) => network.containerCount > 0).length : null,
        unused: networkResult ? networkResult.filter((network) => network.containerCount === 0).length : null,
      },
      storage: diskMetrics,
      errors,
    };
  }

  return { getOverview };
}
