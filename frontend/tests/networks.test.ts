import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DockerNetwork } from '../src/lib/api';
import { filterAndSortDockerNetworks, formatNetworkCreatedAt } from '../src/lib/networks';

const network = (overrides: Partial<DockerNetwork> = {}): DockerNetwork => ({
  id: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'app_net', driver: 'bridge', scope: 'local',
  internal: false, enableIPv6: false, createdAt: '2026-10-31T10:00:00.000Z', labels: {}, subnets: [],
  containerCount: 0, protected: false, ...overrides,
});

test('network filter searches names and full or short IDs and applies driver filtering', () => {
  const networks = [network({ name: 'zeta_net', driver: 'bridge' }), network({ id: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'alpha_private', driver: 'overlay' })];
  assert.equal(filterAndSortDockerNetworks(networks, 'ALPHA', '', 'name').length, 1);
  assert.equal(filterAndSortDockerNetworks(networks, 'b'.repeat(64), '', 'name').length, 1);
  assert.equal(filterAndSortDockerNetworks(networks, 'b'.repeat(12), '', 'name').length, 1);
  assert.deepEqual(filterAndSortDockerNetworks(networks, '', 'bridge', 'name').map(({ name }) => name), ['zeta_net']);
});

test('network sorting supports name, driver, and creation date without mutating input', () => {
  const networks = [
    network({ name: 'zeta_net', driver: 'bridge', createdAt: '2026-10-30T10:00:00.000Z' }),
    network({ id: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'alpha_net', driver: 'macvlan', createdAt: '2026-10-31T10:00:00.000Z' }),
  ];
  assert.deepEqual(filterAndSortDockerNetworks(networks, '', '', 'name').map(({ name }) => name), ['alpha_net', 'zeta_net']);
  assert.deepEqual(filterAndSortDockerNetworks(networks, '', '', 'driver').map(({ name }) => name), ['zeta_net', 'alpha_net']);
  assert.deepEqual(filterAndSortDockerNetworks(networks, '', '', 'created').map(({ name }) => name), ['alpha_net', 'zeta_net']);
  assert.equal(networks[0]?.name, 'zeta_net');
});

test('network creation date formatting handles valid and unavailable values', () => {
  assert.notEqual(formatNetworkCreatedAt('2026-10-31T10:00:00.000Z'), 'Unavailable');
  assert.equal(formatNetworkCreatedAt(null), 'Unavailable');
  assert.equal(formatNetworkCreatedAt('not-a-date'), 'Unavailable');
});
