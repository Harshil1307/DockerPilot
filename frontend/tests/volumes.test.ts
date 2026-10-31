import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DockerVolume } from '../src/lib/api';
import { filterAndSortDockerVolumes, formatVolumeCreatedAt } from '../src/lib/volumes';

const volume = (overrides: Partial<DockerVolume> = {}): DockerVolume => ({
  name: 'cache_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/cache_data/_data',
  createdAt: '2026-10-31T10:00:00.000Z', scope: 'local', labels: {}, containerCount: 0,
  inUse: false, protected: false, ...overrides,
});

test('volume filtering is case-insensitive and sorting supports name, driver, and creation time', () => {
  const volumes = [
    volume({ name: 'z-data', driver: 'local', createdAt: '2026-10-30T10:00:00.000Z' }),
    volume({ name: 'a-data', driver: 'custom', createdAt: '2026-10-31T10:00:00.000Z' }),
  ];
  assert.equal(filterAndSortDockerVolumes(volumes, 'Z-D', 'name').length, 1);
  assert.deepEqual(filterAndSortDockerVolumes(volumes, '', 'name').map(({ name }) => name), ['a-data', 'z-data']);
  assert.deepEqual(filterAndSortDockerVolumes(volumes, '', 'driver').map(({ name }) => name), ['a-data', 'z-data']);
  assert.deepEqual(filterAndSortDockerVolumes(volumes, '', 'created').map(({ name }) => name), ['a-data', 'z-data']);
  assert.equal(volumes[0]?.name, 'z-data');
});

test('volume date formatting handles valid and unavailable dates', () => {
  assert.notEqual(formatVolumeCreatedAt('2026-10-31T10:00:00.000Z'), 'Unavailable');
  assert.equal(formatVolumeCreatedAt(null), 'Unavailable');
  assert.equal(formatVolumeCreatedAt('bad-date'), 'Unavailable');
});
