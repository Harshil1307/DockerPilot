import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { dockerOverviewService, dockerService } from '../services/docker.service.js';
import { composeDeploymentOwnershipService } from '../services/compose-ownership.service.js';
import { calculateContainerMetrics, parseDockerLogBuffer, withMonitoringTimeout } from '../services/compose-monitoring.service.js';

const containerIdSchema = z.string().regex(/^(?:[a-f\d]{12}|[a-f\d]{64})$/i, 'Container ID must be a 12 or 64 character Docker ID.');

export const getDockerStatus: RequestHandler = async (_request, response) => {
  response.status(200).json(await dockerService.getStatus());
};

export const getDockerOverview: RequestHandler = async (request, response) => {
  response.status(200).json(await dockerOverviewService.getOverview(requireUserId(request.userId)));
};

export const listDockerContainers: RequestHandler = async (request, response) => {
  response.status(200).json(await dockerService.listContainers(requireUserId(request.userId)));
};

export const inspectDockerContainer: RequestHandler = async (request, response) => {
  const details = await dockerService.inspectContainer(requireContainerId(request.params.id));
  if (!details) throw new AppError('Container not found.', 404, 'CONTAINER_NOT_FOUND');
  const { labels: _labels, ...safeDetails } = details;
  response.status(200).json(safeDetails);
};

export const getDockerContainerLogs: RequestHandler = async (request, response) => {
  const tail = Number(request.query.tail ?? 100);
  if (![50, 100, 250, 500].includes(tail)) throw new AppError('Log tail must be 50, 100, 250, or 500 lines.', 400, 'INVALID_LOG_TAIL');
  const id = requireContainerId(request.params.id);
  const result = await withMonitoringTimeout(dockerService.getComposeContainerLogs(id, tail), 12_000, 'CONTAINER_LOGS_TIMEOUT');
  const parsed = parseDockerLogBuffer(result.data, result.tty, undefined, tail);
  response.status(200).json({ containerId: id, lines: parsed.lines, truncated: parsed.truncated, tail });
};

export const getDockerContainerMonitoring: RequestHandler = async (request, response) => {
  const userId = requireUserId(request.userId);
  const containers = await dockerService.listContainers(userId);
  const eligible = containers.filter((container) => container.state === 'running').slice(0, 20);
  const metrics = new Map<string, { cpuPercent: number | null; memoryUsageBytes: number | null; memoryLimitBytes: number | null; memoryPercent: number | null }>();
  for (let index = 0; index < eligible.length; index += 4) {
    await Promise.all(eligible.slice(index, index + 4).map(async (container) => {
      try {
        const stats = await withMonitoringTimeout(dockerService.getContainerStats(container.id), 12_000, 'CONTAINER_STATS_TIMEOUT');
        metrics.set(container.id, calculateContainerMetrics(stats));
      } catch { metrics.set(container.id, calculateContainerMetrics(null)); }
    }));
  }
  response.status(200).json({ sampledAt: new Date().toISOString(), containers: containers.map((container) => ({
    id: container.id,
    metrics: metrics.get(container.id) ?? calculateContainerMetrics(null),
    metricsUnavailableReason: container.state !== 'running' ? 'Container is not running.' : eligible.includes(container) ? 'Statistics are unavailable.' : 'Statistics are limited to the first 20 running containers per refresh.',
  })) });
};

function requireContainerId(value: unknown): string {
  const parsed = containerIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('Container ID must be a valid Docker ID.', 400, 'INVALID_CONTAINER_ID');
  }
  return parsed.data;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  return value;
}

function makeContainerControlHandler(action: 'start' | 'stop' | 'restart'): RequestHandler {
  return async (request, response) => {
    const result = await dockerService.controlContainer(
      requireContainerId(request.params.id),
      requireUserId(request.userId),
      action,
      async (container) => composeDeploymentOwnershipService.verifyLifecycleResource(
        container.Id,
        requireUserId(request.userId),
        container.Config?.Labels ?? {},
      ),
    );
    response.status(200).json(result);
  };
}

export const startContainer: RequestHandler = makeContainerControlHandler('start');
export const stopContainer: RequestHandler = makeContainerControlHandler('stop');
export const restartContainer: RequestHandler = makeContainerControlHandler('restart');
