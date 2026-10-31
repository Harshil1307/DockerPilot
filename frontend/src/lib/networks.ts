import type { DockerNetwork } from './api';

export type DockerNetworkSort = 'name' | 'driver' | 'created';

export function filterAndSortDockerNetworks(
  networks: DockerNetwork[],
  query: string,
  driver: string,
  sort: DockerNetworkSort,
): DockerNetwork[] {
  const normalized = query.trim().toLowerCase();
  return networks
    .filter((network) => (!normalized || `${network.name} ${network.id} ${network.shortId}`.toLowerCase().includes(normalized)))
    .filter((network) => !driver || network.driver === driver)
    .slice()
    .sort((left, right) => {
      if (sort === 'driver') return left.driver.localeCompare(right.driver) || left.name.localeCompare(right.name);
      if (sort === 'created') return (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name);
    });
}

export function formatNetworkCreatedAt(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable';
}
