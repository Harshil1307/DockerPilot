import type { DockerImage } from './api';

export type DockerImageSort = 'name' | 'size' | 'created';

export function dockerImageName(image: Pick<DockerImage, 'repositoryTags'>): string {
  return [...image.repositoryTags].sort((left, right) => left.localeCompare(right))[0] ?? '<none>:<none>';
}

export function filterAndSortDockerImages(
  images: DockerImage[],
  query: string,
  sort: DockerImageSort,
): DockerImage[] {
  const needle = query.trim().toLocaleLowerCase();
  return images
    .filter((image) => !needle || image.repositoryTags.some((tag) => tag.toLocaleLowerCase().includes(needle)))
    .slice()
    .sort((left, right) => {
      if (sort === 'size') return right.sizeBytes - left.sizeBytes || dockerImageName(left).localeCompare(dockerImageName(right));
      if (sort === 'created') {
        const leftCreated = left.createdAt ? Date.parse(left.createdAt) : Number.NEGATIVE_INFINITY;
        const rightCreated = right.createdAt ? Date.parse(right.createdAt) : Number.NEGATIVE_INFINITY;
        return rightCreated - leftCreated || dockerImageName(left).localeCompare(dockerImageName(right));
      }
      return dockerImageName(left).localeCompare(dockerImageName(right), undefined, { sensitivity: 'base' });
    });
}

export function formatImageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  const mib = bytes / (1024 ** 2);
  return `${mib >= 100 ? Math.round(mib) : mib.toFixed(1)} MB`;
}

