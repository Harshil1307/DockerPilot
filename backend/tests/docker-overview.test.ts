import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import cookieParser from 'cookie-parser';
import express from 'express';
import { test, type TestContext } from 'node:test';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants.js';
import { createSessionToken } from '../src/auth/session-token.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { dockerRouter } from '../src/routes/docker.routes.js';
import { createDockerOverviewService, summarizeDockerDiskUsage, type DockerOverviewDependencies } from '../src/services/docker-overview.service.js';
import type { DockerContainerSummary, DockerEngineStatus } from '../src/services/docker.service.js';
import type { DockerImageSummary } from '../src/services/docker-image.service.js';
import type { DockerNetworkSummary } from '../src/services/docker-network.service.js';
import type { DockerVolumeSummary } from '../src/services/docker-volume.service.js';

const engine: DockerEngineStatus = {
  reachable: true,
  engine: { version: '29.8.0', apiVersion: '1.56', operatingSystem: 'Docker Desktop', architecture: 'arm64' },
};
const containers: DockerContainerSummary[] = [
  { id: '111111111111', name: 'api', image: 'api:latest', state: 'running', status: 'Up', createdAt: '2026-10-31T10:00:00.000Z', publishedPorts: [], managed: false, managedByCurrentUser: false },
  { id: '222222222222', name: 'worker', image: 'worker:latest', state: 'paused', status: 'Paused', createdAt: '2026-10-30T10:00:00.000Z', publishedPorts: [], managed: false, managedByCurrentUser: false },
  { id: '333333333333', name: 'database', image: 'postgres:17', state: 'exited', status: 'Exited', createdAt: '2026-10-29T10:00:00.000Z', publishedPorts: [], managed: false, managedByCurrentUser: false },
];
const images: DockerImageSummary[] = [
  { id: `sha256:${'a'.repeat(64)}`, repositoryTags: ['api:latest'], sizeBytes: 12, createdAt: '2026-10-30T10:00:00.000Z', containerCount: 1, protected: false },
];
const volumes: DockerVolumeSummary[] = [
  { name: 'used', driver: 'local', mountpoint: '/private/path', createdAt: null, scope: 'local', labels: {}, containerCount: 1, inUse: true, protected: false },
  { name: 'unused', driver: 'local', mountpoint: '/private/path', createdAt: null, scope: 'local', labels: {}, containerCount: 0, inUse: false, protected: false },
];
const networks: DockerNetworkSummary[] = [
  { id: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'used_net', driver: 'bridge', scope: 'local', internal: false, enableIPv6: false, createdAt: null, labels: {}, subnets: [], containerCount: 2, protected: false },
  { id: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'empty_net', driver: 'bridge', scope: 'local', internal: false, enableIPv6: false, createdAt: null, labels: {}, subnets: [], containerCount: 0, protected: false },
];
const disk = {
  Images: [{ Size: 100, SharedSize: 40 }, { Size: 80, SharedSize: 20 }],
  Containers: [{ SizeRw: 30 }],
  Volumes: [{ UsageData: { Size: 40 } }],
  BuildCache: [{ Size: 50 }],
};

function dependencies(overrides: Partial<DockerOverviewDependencies> = {}): DockerOverviewDependencies {
  return {
    getEngineStatus: async () => engine,
    listContainers: async () => containers,
    listImages: async () => images,
    listVolumes: async () => volumes,
    listNetworks: async () => ({ networks, ipv6Supported: false }),
    getDiskUsage: async () => disk,
    ...overrides,
  };
}

test('disk usage distinguishes image unique bytes and non-overlapping Engine categories', () => {
  const metrics = summarizeDockerDiskUsage(disk);
  assert.deepEqual(metrics, {
    images: { bytes: 120, quality: 'exact' },
    containerWritable: { bytes: 30, quality: 'exact' },
    volumes: { bytes: 40, quality: 'exact' },
    buildCache: { bytes: 50, quality: 'exact' },
    total: { bytes: 240, quality: 'exact' },
  });
});

test('disk usage reads modern aggregate fields and keeps unsupported metrics unavailable', () => {
  const modern = summarizeDockerDiskUsage({
    ImagesUsage: { TotalSize: 120 }, ContainersUsage: { TotalSize: 30 },
    VolumesUsage: { TotalSize: 40 }, BuildCacheUsage: { TotalSize: 50 },
  });
  assert.equal(modern.total.bytes, 240);
  const partial = summarizeDockerDiskUsage({ ImagesUsage: { TotalSize: 90 } });
  assert.equal(partial.images.bytes, 90);
  assert.equal(partial.containerWritable.bytes, null);
  assert.equal(partial.total.bytes, null);
});

test('overview returns Engine data, correct counts, recent items, and reference based volume/network counts', async () => {
  const overview = await createDockerOverviewService(dependencies()).getOverview('user-id');
  assert.equal(overview.daemon.status, 'connected');
  assert.equal(overview.engine?.version, '29.8.0');
  assert.equal(overview.containers.total, 3);
  assert.equal(overview.containers.running, 1);
  assert.equal(overview.containers.paused, 1);
  assert.equal(overview.containers.stopped, 1);
  assert.equal(overview.containers.recent?.[0]?.name, 'api');
  assert.equal(overview.images.total, 1);
  assert.equal(overview.images.recent?.[0]?.name, 'api:latest');
  assert.deepEqual(overview.volumes, { total: 2, inUse: 1, unused: 1 });
  assert.deepEqual(overview.networks, { total: 2, connected: 1, unused: 1 });
  assert.equal(overview.storage.total.bytes, 240);
  assert.equal(overview.lastSuccessfulRefreshAt, overview.collectedAt);
});

test('daemon unavailability and metric failures are reported without replacing other available data', async () => {
  const service = createDockerOverviewService(dependencies({
    getEngineStatus: async () => ({ reachable: false, engine: null, message: 'Docker Engine is unavailable.' }),
    listImages: async () => { throw new Error('private registry/socket detail'); },
    listVolumes: async () => { throw new Error('private volume path'); },
    getDiskUsage: async () => { throw new Error('private Docker error'); },
  }));
  const overview = await service.getOverview('user-id');
  assert.equal(overview.daemon.status, 'unavailable');
  assert.equal(overview.engine, null);
  assert.equal(overview.containers.total, 3);
  assert.equal(overview.images.total, null);
  assert.equal(overview.volumes.total, null);
  assert.equal(overview.networks.total, 2);
  assert.equal(overview.storage.total.bytes, null);
  assert.equal(overview.lastSuccessfulRefreshAt, null);
  assert.equal(JSON.stringify(overview).includes('private'), false);
  assert.match(overview.errors.images ?? '', /Could not load image inventory/);
});

test('overview timeout is bounded and returned as a safe partial metric failure', async () => {
  const overview = await createDockerOverviewService(dependencies({
    getDiskUsage: () => new Promise(() => undefined),
  }), 5).getOverview('user-id');
  assert.equal(overview.daemon.status, 'connected');
  assert.equal(overview.containers.total, 3);
  assert.equal(overview.storage.total.bytes, null);
  assert.match(overview.errors.storage ?? '', /too long/);
});

test('simultaneous refreshes for the same user share one collection', async () => {
  let containerCalls = 0;
  const service = createDockerOverviewService(dependencies({
    async listContainers() {
      containerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return containers;
    },
  }));
  const [first, second] = await Promise.all([service.getOverview('same-user'), service.getOverview('same-user')]);
  assert.equal(containerCalls, 1);
  assert.equal(first.collectedAt, second.collectedAt);
});

async function overviewTestServer(context: TestContext) {
  const app = express();
  app.use(cookieParser());
  app.use('/api/docker', dockerRouter);
  app.use(errorHandler);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}/api/docker`, url: `http://127.0.0.1:${address.port}/api/docker/overview`, cookie: `${SESSION_COOKIE_NAME}=${createSessionToken('overview-test-user')}` };
}

test('Docker overview endpoint requires authentication', async (context) => {
  const { url } = await overviewTestServer(context);
  const response = await fetch(url);
  assert.equal(response.status, 401);
  assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
});

test('container detail, monitoring, and logs endpoints require authentication', async (context) => {
  const { baseUrl } = await overviewTestServer(context);
  for (const path of ['/containers/monitoring', `/containers/${'a'.repeat(12)}`, `/containers/${'a'.repeat(12)}/logs?tail=100`]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
  }
});

test('container log endpoint rejects an unsupported tail before contacting Docker', async (context) => {
  const { baseUrl, cookie } = await overviewTestServer(context);
  const response = await fetch(`${baseUrl}/containers/${'a'.repeat(12)}/logs?tail=25`, { headers: { cookie } });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, 'INVALID_LOG_TAIL');
});
