import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type Docker from 'dockerode';
import { readDockerStats } from '../src/services/docker-stats.js';

function sample(totalUsage: number, systemUsage: number, memoryUsage: number): Docker.ContainerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: totalUsage, percpu_usage: [totalUsage], usage_in_kernelmode: 0, usage_in_usermode: totalUsage },
      system_cpu_usage: systemUsage,
      online_cpus: 1,
      throttling_data: { periods: 0, throttled_periods: 0, throttled_time: 0 },
    },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    memory_stats: { usage: memoryUsage, limit: 1024, stats: {} },
    name: '/test', id: 'test', read: new Date().toISOString(), preread: new Date().toISOString(),
    pids_stats: { current: 1 }, blkio_stats: { io_service_bytes_recursive: null, io_serviced_recursive: null },
    networks: {}, storage_stats: {}, num_procs: 1,
  } as Docker.ContainerStats;
}

test('Docker streaming stats pair consecutive CPU samples while retaining current memory', async () => {
  const previous = sample(100, 1_000, 10);
  const current = sample(300, 2_000, 40);
  const stream = Readable.from([`${JSON.stringify(previous)}\n${JSON.stringify(current)}\n`]);
  const result = await readDockerStats(stream as NodeJS.ReadableStream & { destroy: () => void });

  assert.deepEqual(result.precpu_stats, previous.cpu_stats);
  assert.deepEqual(result.cpu_stats, current.cpu_stats);
  assert.equal(result.memory_stats.usage, 40);
});

test('Docker streaming stats keep a single sample when the stream ends early', async () => {
  const onlySample = sample(100, 1_000, 25);
  const stream = Readable.from([`${JSON.stringify(onlySample)}\n`]);
  const result = await readDockerStats(stream as NodeJS.ReadableStream & { destroy: () => void });

  assert.deepEqual(result.cpu_stats, onlySample.cpu_stats);
  assert.equal(result.memory_stats.usage, 25);
});
