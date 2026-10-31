import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import { prisma } from '../config/prisma.js';
import type Docker from 'dockerode';
import {
  dockerService,
  type ComposeContainerDetails,
  type ComposeDockerResource,
} from './docker.service.js';
import {
  assertComposeResourceLabels,
  createComposeDeploymentOwnershipVerifier,
  type ComposeDeploymentOwnershipRepository,
  type ComposeDeploymentResourceReader,
  type RegisteredComposeDeployment,
} from './compose-ownership.service.js';

const STATS_TIMEOUT_MS = 12_000;
const LOG_TIMEOUT_MS = 12_000;
export const COMPOSE_LOG_MAX_BYTES = 64 * 1024;
export const COMPOSE_LOG_MAX_LINES = 100;
const MAX_CONTAINERS_WITH_STATS = 20;

export interface ContainerMetrics {
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
}

export interface MonitoringDocker extends ComposeDeploymentResourceReader {
  inspectComposeContainer(id: string): Promise<ComposeContainerDetails | null>;
  getComposeContainerStats(id: string): Promise<Docker.ContainerStats>;
  getComposeContainerLogs(id: string, tail?: number): Promise<{ data: Buffer; tty: boolean }>;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function calculateContainerMetrics(stats: Partial<Docker.ContainerStats> | null | undefined): ContainerMetrics {
  if (!stats) return { cpuPercent: null, memoryUsageBytes: null, memoryLimitBytes: null, memoryPercent: null };
  const cpu = stats.cpu_stats;
  const previousCpu = stats.precpu_stats;
  const cpuDelta = cpu?.cpu_usage?.total_usage !== undefined && previousCpu?.cpu_usage?.total_usage !== undefined
    ? cpu.cpu_usage.total_usage - previousCpu.cpu_usage.total_usage
    : Number.NaN;
  const systemDelta = cpu?.system_cpu_usage !== undefined && previousCpu?.system_cpu_usage !== undefined
    ? cpu.system_cpu_usage - previousCpu.system_cpu_usage
    : Number.NaN;
  const cpuCount = finite(cpu?.online_cpus) && cpu.online_cpus > 0
    ? cpu.online_cpus
    : Array.isArray(cpu?.cpu_usage?.percpu_usage) && cpu.cpu_usage.percpu_usage.length > 0
      ? cpu.cpu_usage.percpu_usage.length
      : Number.NaN;
  const cpuPercent = Number.isFinite(cpuDelta) && cpuDelta >= 0 && Number.isFinite(systemDelta) && systemDelta > 0
    && Number.isFinite(cpuCount)
    ? (cpuDelta / systemDelta) * cpuCount * 100
    : null;

  const memory = stats.memory_stats;
  const rawUsage = memory?.usage;
  const rawLimit = memory?.limit;
  const inactiveCache = memory?.stats?.total_inactive_file ?? memory?.stats?.inactive_file ?? memory?.stats?.cache;
  const validCache = !finite(inactiveCache) || (finite(rawUsage) && inactiveCache <= rawUsage);
  const memoryUsageBytes = finite(rawUsage) && validCache
    ? rawUsage - (finite(inactiveCache) ? inactiveCache : 0)
    : null;
  const memoryLimitBytes = finite(rawLimit) && rawLimit > 0 ? rawLimit : null;
  const memoryPercent = memoryUsageBytes !== null && memoryLimitBytes !== null
    ? (memoryUsageBytes / memoryLimitBytes) * 100
    : null;

  return {
    cpuPercent: cpuPercent !== null && Number.isFinite(cpuPercent) ? cpuPercent : null,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent: memoryPercent !== null && Number.isFinite(memoryPercent) ? memoryPercent : null,
  };
}

export function withMonitoringTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('Docker Engine did not respond in time. Refresh and try again.', 504, code)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function safeServiceName(value: string | null): string | null {
  return value && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) ? value : null;
}

export interface ComposeContainerInventoryItem {
  id: string;
  serviceName: string | null;
  name: string | null;
  state: string;
  health: string | null;
  image: string | null;
  createdAt: string | null;
  startedAt: string | null;
  metrics: ContainerMetrics;
  metricsUnavailableReason: string | null;
}

function missingContainer(id: string): ComposeContainerInventoryItem {
  return {
    id,
    serviceName: null,
    name: null,
    state: 'removed',
    health: null,
    image: null,
    createdAt: null,
    startedAt: null,
    metrics: calculateContainerMetrics(null),
    metricsUnavailableReason: 'Container is no longer present in Docker.',
  };
}

export function parseDockerLogBuffer(
  data: Buffer,
  tty: boolean,
  maxBytes = COMPOSE_LOG_MAX_BYTES,
  maxLines = COMPOSE_LOG_MAX_LINES,
): { lines: { stream: 'stdout' | 'stderr'; text: string }[]; truncated: boolean } {
  const frames: { stream: 'stdout' | 'stderr'; bytes: Buffer }[] = [];
  let validFrames = !tty && data.length >= 8;
  if (validFrames) {
    let offset = 0;
    while (offset + 8 <= data.length) {
      const streamType = data[offset];
      const size = data.readUInt32BE(offset + 4);
      if ((streamType !== 1 && streamType !== 2) || size > data.length - offset - 8) {
        validFrames = false;
        break;
      }
      frames.push({ stream: streamType === 1 ? 'stdout' : 'stderr', bytes: data.subarray(offset + 8, offset + 8 + size) });
      offset += 8 + size;
    }
    if (offset !== data.length) validFrames = false;
  }
  if (!validFrames) frames.splice(0, frames.length, { stream: 'stdout', bytes: data });

  const allLines = frames.flatMap((frame) => frame.bytes.toString('utf8').split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({ stream: frame.stream, text: redactLogLine(line) })));
  let selected = allLines.slice(-maxLines);
  let usedBytes = 0;
  const tail: typeof selected = [];
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const line = selected[index]!;
    const bytes = Buffer.byteLength(line.text, 'utf8') + 1;
    if (usedBytes + bytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - usedBytes - 1);
      if (remaining > 0) tail.push({ ...line, text: Buffer.from(line.text).subarray(-remaining).toString('utf8') });
      break;
    }
    usedBytes += bytes;
    tail.push(line);
  }
  selected = tail.reverse();
  let truncated = allLines.length > selected.length || data.length > maxBytes;
  const payloadBudget = Math.max(0, maxBytes - 256);
  while (selected.length > 0 && Buffer.byteLength(JSON.stringify(selected), 'utf8') > payloadBudget) {
    if (selected.length > 1) {
      selected.shift();
      truncated = true;
      continue;
    }
    const onlyLine = selected[0]!;
    const characters = Array.from(onlyLine.text);
    let low = 0;
    let high = characters.length;
    let suffix = '';
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const candidate = midpoint === 0 ? '' : characters.slice(-midpoint).join('');
      const candidateLine = [{ ...onlyLine, text: candidate }];
      if (Buffer.byteLength(JSON.stringify(candidateLine), 'utf8') <= payloadBudget) {
        suffix = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    selected = suffix ? [{ ...onlyLine, text: suffix }] : [];
    truncated = true;
  }
  return { lines: selected, truncated };
}

function redactLogLine(line: string): string {
  return line
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?\b[a-zA-Z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key)[a-zA-Z0-9_.-]*["']?)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/(\/\/[^\s/:@]+:)[^\s/@]+(@)/g, '$1[REDACTED]$2');
}

export function createComposeMonitoringService(
  repository: ComposeDeploymentOwnershipRepository,
  docker: MonitoringDocker,
) {
  const ownership = createComposeDeploymentOwnershipVerifier(repository, docker);

  return {
    async getInventory(environmentId: string, userId: string) {
      const verified = await ownership.verify(environmentId, userId);
      const registeredIds = verified.deployment.deploymentContainerIds;
      const resources = new Map(verified.resources
        .filter((resource) => resource.type === 'container')
        .map((resource) => [resource.id, resource]));
      const statsAllowed = registeredIds.length <= MAX_CONTAINERS_WITH_STATS;
      const containers = await Promise.all(registeredIds.map(async (id): Promise<ComposeContainerInventoryItem> => {
        if (!resources.has(id)) return missingContainer(id);
        const details = await docker.inspectComposeContainer(id);
        if (!details) return missingContainer(id);
        assertComposeResourceLabels({
          type: 'container', id: details.id, labels: details.labels, attachedContainerIds: [],
        }, verified.identity, 'container', id);

        let metrics = calculateContainerMetrics(null);
        let metricsUnavailableReason: string | null = details.state !== 'running' ? 'Container is not running.' : null;
        if (details.state === 'running' && !statsAllowed) {
          metricsUnavailableReason = `Statistics are limited to deployments with ${MAX_CONTAINERS_WITH_STATS} or fewer containers per refresh.`;
        } else if (details.state === 'running') {
          try {
            const stats = await withMonitoringTimeout(docker.getComposeContainerStats(id), STATS_TIMEOUT_MS, 'CONTAINER_STATS_TIMEOUT');
            metrics = calculateContainerMetrics(stats);
            if (Object.values(metrics).every((value) => value === null)) metricsUnavailableReason = 'Docker did not provide usable statistics.';
          } catch (error) {
            if (error instanceof DockerUnavailableError) throw error;
            if (error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') return missingContainer(id);
            metricsUnavailableReason = error instanceof AppError && error.code === 'CONTAINER_STATS_TIMEOUT'
              ? 'Statistics request timed out.'
              : 'Statistics are unavailable for this container.';
          }
        }

        return {
          id,
          serviceName: safeServiceName(details.serviceName),
          name: details.name,
          state: details.state,
          health: details.health,
          image: details.image,
          createdAt: details.createdAt,
          startedAt: details.startedAt,
          metrics,
          metricsUnavailableReason,
        };
      }));
      return { environmentId, sampledAt: new Date().toISOString(), containers };
    },

    async getRecentLogs(environmentId: string, userId: string, containerId: string, tail = COMPOSE_LOG_MAX_LINES) {
      const verified = await ownership.verify(environmentId, userId);
      if (!verified.deployment.deploymentContainerIds.includes(containerId)) {
        throw new AppError('Container not found in this deployment.', 404, 'CONTAINER_NOT_FOUND');
      }
      if (!verified.resources.some((resource) => resource.type === 'container' && resource.id === containerId)) {
        throw new AppError('Container is no longer present in Docker.', 404, 'CONTAINER_NOT_FOUND');
      }
      const details = await docker.inspectComposeContainer(containerId);
      if (!details) throw new AppError('Container is no longer present in Docker.', 404, 'CONTAINER_NOT_FOUND');
      assertComposeResourceLabels({
        type: 'container', id: details.id, labels: details.labels, attachedContainerIds: [],
      }, verified.identity, 'container', containerId);

      let logResult: { data: Buffer; tty: boolean };
      try {
        logResult = await withMonitoringTimeout(docker.getComposeContainerLogs(containerId, tail), LOG_TIMEOUT_MS, 'CONTAINER_LOGS_TIMEOUT');
      } catch (error) {
        if (error instanceof AppError || error instanceof DockerUnavailableError) throw error;
        throw new AppError('Recent container logs could not be loaded. Try again.', 502, 'CONTAINER_LOGS_FAILED');
      }
      const parsed = parseDockerLogBuffer(logResult.data, logResult.tty, COMPOSE_LOG_MAX_BYTES, tail);
      return { environmentId, containerId, lines: parsed.lines, truncated: parsed.truncated, tail };
    },
  };
}

const monitoringRepository: ComposeDeploymentOwnershipRepository = {
  async findDeployment(environmentId) {
    const record = await prisma.composeEnvironment.findUnique({
      where: { id: environmentId },
      include: { project: { select: { id: true, userId: true } } },
    });
    return record as RegisteredComposeDeployment | null;
  },
};

export const composeMonitoringService = createComposeMonitoringService(monitoringRepository, dockerService);
