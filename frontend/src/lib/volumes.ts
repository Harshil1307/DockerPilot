import type { DockerVolume } from './api';

export type DockerVolumeSort = 'name' | 'driver' | 'created';

export function filterAndSortDockerVolumes(volumes: DockerVolume[], query: string, sort: DockerVolumeSort): DockerVolume[] {
  const normalized = query.trim().toLowerCase();
  return volumes
    .filter((volume) => volume.name.toLowerCase().includes(normalized))
    .slice()
    .sort((left, right) => {
      if (sort === 'driver') return left.driver.localeCompare(right.driver) || left.name.localeCompare(right.name);
      if (sort === 'created') return (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name);
    });
}

export function formatVolumeCreatedAt(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable';
}
