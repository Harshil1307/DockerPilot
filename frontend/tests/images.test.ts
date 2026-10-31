import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DockerImage } from '../src/lib/api';
import { dockerImageName, filterAndSortDockerImages, formatImageSize } from '../src/lib/images';

function image(overrides: Partial<DockerImage>): DockerImage {
  return {
    id: `sha256:${'a'.repeat(64)}`,
    repositoryTags: ['example:latest'],
    sizeBytes: 1024 ** 2,
    createdAt: '2026-10-31T10:00:00.000Z',
    containerCount: 0,
    protected: false,
    ...overrides,
  };
}

test('image filtering matches repository and tag case-insensitively', () => {
  const images = [image({ repositoryTags: ['registry.example.com/team/api:v2'] }), image({ id: `sha256:${'b'.repeat(64)}`, repositoryTags: ['nginx:alpine'] })];
  assert.equal(filterAndSortDockerImages(images, 'TEAM', 'name').length, 1);
  assert.equal(filterAndSortDockerImages(images, 'ALPINE', 'name').length, 1);
  assert.equal(filterAndSortDockerImages(images, 'missing', 'name').length, 0);
});

test('image sorting supports name, size, and creation time without mutating inventory', () => {
  const images = [
    image({ repositoryTags: ['zulu:latest'], sizeBytes: 50, createdAt: '2026-10-30T10:00:00.000Z' }),
    image({ id: `sha256:${'b'.repeat(64)}`, repositoryTags: ['alpha:latest'], sizeBytes: 100, createdAt: '2026-10-31T10:00:00.000Z' }),
  ];
  assert.deepEqual(filterAndSortDockerImages(images, '', 'name').map(dockerImageName), ['alpha:latest', 'zulu:latest']);
  assert.deepEqual(filterAndSortDockerImages(images, '', 'size').map(dockerImageName), ['alpha:latest', 'zulu:latest']);
  assert.deepEqual(filterAndSortDockerImages(images, '', 'created').map(dockerImageName), ['alpha:latest', 'zulu:latest']);
  assert.equal(dockerImageName(images[0]!), 'zulu:latest');
});

test('image size formatting handles typical values and invalid data', () => {
  assert.equal(formatImageSize(1024 ** 2), '1.0 MB');
  assert.equal(formatImageSize(-1), 'Unavailable');
  assert.equal(formatImageSize(Number.NaN), 'Unavailable');
});

