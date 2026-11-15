import assert from 'node:assert/strict';
import test from 'node:test';
import type Docker from 'dockerode';
import { DockerUnavailableError } from '../src/errors/docker-unavailable-error.js';
import { createContainerMonitoringService } from '../src/services/container-monitoring.service.js';
import type { DockerContainerSummary } from '../src/services/docker.service.js';

const containers: DockerContainerSummary[] = [
  { id: 'a'.repeat(12), name: 'api', image: 'api:latest', state: 'running', status: 'Up', createdAt: new Date().toISOString(), publishedPorts: [], managed: false, managedByCurrentUser: false },
  { id: 'b'.repeat(12), name: 'db', image: 'postgres:17', state: 'exited', status: 'Exited', createdAt: new Date().toISOString(), publishedPorts: [], managed: false, managedByCurrentUser: false },
];
function stats(): Docker.ContainerStats {
  return {
    cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 40 * 1024 * 1024, limit: 100 * 1024 * 1024, stats: {} },
  } as Docker.ContainerStats;
}

test('samples fresh real Engine stats for running containers and labels stopped containers', async () => {
  const called: [string, string | undefined][] = [];
  const service = createContainerMonitoringService({
    listContainers: async () => containers,
    getContainerStats: async (id, userId) => { called.push([id, userId]); return stats(); },
  });
  const result = await service.sample('owner-id');
  assert.deepEqual(called, [['a'.repeat(12), 'owner-id']]);
  assert.equal(result.containers[0]?.metrics.cpuPercent, 20);
  assert.equal(result.containers[0]?.metrics.memoryUsageBytes, 40 * 1024 * 1024);
  assert.equal(result.containers[0]?.metrics.memoryPercent, 40);
  assert.equal(result.containers[1]?.metricsUnavailableReason, 'Not running');
  assert.equal(result.containers[1]?.metrics.memoryUsageBytes, null);
});

test('surfaces a safe per-container daemon failure without fabricating a metric', async () => {
  const service = createContainerMonitoringService({ listContainers: async () => containers.slice(0, 1), getContainerStats: async () => { throw new DockerUnavailableError(); } });
  const result = await service.sample('owner-id');
  assert.equal(result.containers[0]?.metrics.cpuPercent, null);
  assert.match(result.containers[0]?.metricsUnavailableReason ?? '', /Docker Engine is unavailable/);
});
