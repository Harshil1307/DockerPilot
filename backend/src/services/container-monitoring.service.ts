import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import { calculateContainerMetrics, withMonitoringTimeout, type ContainerMetrics } from './compose-monitoring.service.js';
import type { DockerContainerSummary } from './docker.service.js';

export interface ContainerMonitoringDocker {
  listContainers(userId: string): Promise<DockerContainerSummary[]>;
  getContainerStats(id: string, userId?: string): Promise<import('dockerode').ContainerStats>;
}
export interface ContainerMonitoringItem {
  id: string; state: string; metrics: ContainerMetrics; metricsUnavailableReason: string | null;
}

function unavailableReason(error: unknown): string {
  if (error instanceof DockerUnavailableError) return 'Docker Engine is unavailable. Check the Engine connection and try again.';
  if (error instanceof AppError && error.code === 'CONTAINER_STATS_TIMEOUT') return 'Docker did not return statistics before the request timed out.';
  if (error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') return 'Container is no longer available.';
  return 'Docker could not provide statistics for this container.';
}

export function createContainerMonitoringService(docker: ContainerMonitoringDocker, timeoutMs = 12_000) {
  return {
    async sample(userId: string): Promise<{ sampledAt: string; containers: ContainerMonitoringItem[] }> {
      const containers = await docker.listContainers(userId);
      const running = containers.filter((container) => container.state === 'running');
      const samples = new Map<string, ContainerMonitoringItem>();
      for (let index = 0; index < running.length; index += 4) {
        await Promise.all(running.slice(index, index + 4).map(async (container) => {
          try {
            const stats = await withMonitoringTimeout(docker.getContainerStats(container.id, userId), timeoutMs, 'CONTAINER_STATS_TIMEOUT');
            const metrics = calculateContainerMetrics(stats);
            const unavailable = Object.values(metrics).every((value) => value === null);
            samples.set(container.id, {
              id: container.id, state: container.state, metrics,
              metricsUnavailableReason: unavailable ? 'Docker returned no usable CPU or memory sample.' : null,
            });
          } catch (error) {
            samples.set(container.id, { id: container.id, state: container.state, metrics: calculateContainerMetrics(null), metricsUnavailableReason: unavailableReason(error) });
          }
        }));
      }
      return {
        sampledAt: new Date().toISOString(),
        containers: containers.map((container) => container.state === 'running'
          ? samples.get(container.id) ?? { id: container.id, state: container.state, metrics: calculateContainerMetrics(null), metricsUnavailableReason: 'Statistics were not collected.' }
          : { id: container.id, state: container.state, metrics: calculateContainerMetrics(null), metricsUnavailableReason: 'Not running' }),
      };
    },
  };
}
