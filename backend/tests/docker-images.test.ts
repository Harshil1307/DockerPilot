import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import cookieParser from 'cookie-parser';
import { test, type TestContext } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import { DockerUnavailableError } from '../src/errors/docker-unavailable-error.js';
import { createDockerImageService, normalizeImageReference, type DockerImageClient, type DockerImageRecord } from '../src/services/docker-image.service.js';
import { dockerRouter } from '../src/routes/docker.routes.js';
import { createSessionToken } from '../src/auth/session-token.js';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const imageId = `sha256:${'a'.repeat(64)}`;
const imageB = `sha256:${'b'.repeat(64)}`;

function image(overrides: Partial<DockerImageRecord> = {}): DockerImageRecord {
  return {
    id: imageId,
    repositoryTags: ['nginx:alpine'],
    sizeBytes: 1024,
    createdAt: 1_791_000_000,
    os: 'linux',
    architecture: 'arm64',
    labels: {},
    config: { user: 'nginx', workingDir: '/usr/share/nginx/html', exposedPorts: ['80/tcp'], volumes: [] },
    ...overrides,
  };
}

function container(overrides: Partial<Awaited<ReturnType<DockerImageClient['listContainers']>>[number]> = {}) {
  return {
    id: 'container-id',
    imageId,
    image: 'nginx:alpine',
    names: ['/app-1'],
    state: 'exited',
    labels: {},
    ...overrides,
  };
}

class FakeDockerImageClient implements DockerImageClient {
  images = [image()];
  containers = [] as ReturnType<typeof container>[];
  inspectError: unknown;
  listError: unknown;
  pullImplementation: DockerImageClient['pullImage'] = async (_reference, onProgress) => {
    onProgress({ status: 'Downloading', id: 'layer-1', current: 50, total: 100 });
  };
  pulled: string[] = [];
  removed: string[] = [];

  async listImages() { if (this.listError) throw this.listError; return this.images; }
  async inspectImage(id: string) {
    if (this.inspectError) throw this.inspectError;
    const result = this.images.find((entry) => entry.id === id);
    if (!result) throw Object.assign(new Error('not found'), { statusCode: 404 });
    return result;
  }
  async listContainers() { if (this.listError) throw this.listError; return this.containers; }
  async pullImage(reference: string, onProgress: Parameters<DockerImageClient['pullImage']>[1], signal: AbortSignal) {
    this.pulled.push(reference);
    return this.pullImplementation(reference, onProgress, signal);
  }
  async removeImage(id: string) { this.removed.push(id); }
}

test('normalizes safe image references and rejects invalid references', () => {
  assert.equal(normalizeImageReference(' nginx '), 'nginx:latest');
  assert.equal(normalizeImageReference('registry.example.com:5000/team/api:v2.1'), 'registry.example.com:5000/team/api:v2.1');
  for (const reference of ['', 'UPPER/image', 'https://registry/image', 'image;rm -rf /', 'image@sha256:abc', 'localhost:70000/app']) {
    assert.throws(() => normalizeImageReference(reference), (error: unknown) => error instanceof AppError && error.code === 'INVALID_IMAGE_REFERENCE');
  }
});

test('image inventory returns safe summaries and counts running and stopped references', async () => {
  const client = new FakeDockerImageClient();
  client.containers = [container({ state: 'running' }), container({ id: 'other', state: 'exited' })];
  const [summary] = await createDockerImageService(client).listImages();
  assert.equal(summary?.id, imageId);
  assert.equal(summary?.containerCount, 2);
  assert.deepEqual(summary?.repositoryTags, ['nginx:alpine']);
  assert.equal(summary?.protected, false);
  assert.equal('labels' in (summary ?? {}), false);
});

test('image inspection whitelists configuration and never returns environment or labels', async () => {
  const client = new FakeDockerImageClient();
  client.images = [image({ labels: { 'private.label': 'value' }, config: {
    user: 'nginx', workingDir: '/srv', exposedPorts: ['8080/tcp'], volumes: [],
  } })];
  const result = await createDockerImageService(client).inspectImage(imageId);
  assert.equal(result.operatingSystem, 'linux');
  assert.equal(result.architecture, 'arm64');
  assert.deepEqual(result.config.exposedPorts, ['8080/tcp']);
  assert.equal('Env' in result.config, false);
  assert.equal('labels' in result, false);
});

test('image inspection requires a full image ID and translates missing images', async () => {
  const service = createDockerImageService(new FakeDockerImageClient());
  await assert.rejects(service.inspectImage('nginx:alpine'), (error: unknown) => error instanceof AppError && error.code === 'INVALID_IMAGE_ID');
  await assert.rejects(service.inspectImage(imageB), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_NOT_FOUND');
});

test('image pulls normalize references and report progress', async () => {
  const client = new FakeDockerImageClient();
  const service = createDockerImageService(client);
  const operation = service.beginPull('nginx');
  const progress: string[] = [];
  await operation.run((event) => progress.push(event.status));
  assert.equal(operation.reference, 'nginx:latest');
  assert.deepEqual(client.pulled, ['nginx:latest']);
  assert.deepEqual(progress, ['Downloading']);
});

test('duplicate pull requests for the same normalized reference are rejected', async () => {
  const client = new FakeDockerImageClient();
  let finishPull!: () => void;
  client.pullImplementation = () => new Promise<void>((resolve) => { finishPull = resolve; });
  const service = createDockerImageService(client);
  const first = service.beginPull('nginx');
  const pending = first.run(() => undefined);
  assert.throws(() => service.beginPull('nginx:latest'), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_PULL_IN_PROGRESS');
  finishPull();
  await pending;
});

test('pull errors are mapped safely for registry auth, missing images, and network failures', async () => {
  const client = new FakeDockerImageClient();
  const service = createDockerImageService(client);
  client.pullImplementation = async () => { throw Object.assign(new Error('unauthorized: raw registry detail'), { statusCode: 401 }); };
  await assert.rejects(service.beginPull('nginx').run(() => undefined), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_REGISTRY_AUTH_REQUIRED' && !error.message.includes('raw registry'));
  client.pullImplementation = async () => { throw Object.assign(new Error('manifest unknown'), { statusCode: 404 }); };
  await assert.rejects(service.beginPull('nginx:missing').run(() => undefined), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_NOT_FOUND');
  client.pullImplementation = async () => { throw Object.assign(new Error('ECONNRESET: private detail'), { code: 'ECONNRESET' }); };
  await assert.rejects(service.beginPull('nginx').run(() => undefined), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_PULL_NETWORK_ERROR' && !error.message.includes('private detail'));
  client.pullImplementation = async () => { throw new DockerUnavailableError(); };
  await assert.rejects(service.beginPull('nginx').run(() => undefined), DockerUnavailableError);
});

test('pull timeout aborts the Docker request and releases the duplicate-pull lock', async () => {
  const client = new FakeDockerImageClient();
  client.pullImplementation = (_reference, _progress, signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const service = createDockerImageService(client, 10);
  await assert.rejects(service.beginPull('nginx').run(() => undefined), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_PULL_TIMEOUT');
  client.pullImplementation = async () => undefined;
  const retry = service.beginPull('nginx');
  await retry.run(() => undefined);
});

test('removal rejects images referenced by running or stopped containers', async () => {
  for (const state of ['running', 'exited']) {
    const client = new FakeDockerImageClient();
    client.containers = [container({ state })];
    await assert.rejects(createDockerImageService(client).removeImage(imageId), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_IN_USE' && error.message.includes(state === 'running' ? '1 running' : '1 stopped'));
    assert.deepEqual(client.removed, []);
  }
});

test('removal refuses DockerPilot infrastructure images and never forces an image removal', async () => {
  const client = new FakeDockerImageClient();
  client.containers = [container({ names: ['/dockerpilot-postgres-1'], labels: { 'com.docker.compose.project': 'dockerpilot' } })];
  const service = createDockerImageService(client);
  const inventory = await service.listImages();
  assert.equal(inventory[0]?.protected, true);
  await assert.rejects(service.removeImage(imageId), (error: unknown) => error instanceof AppError && error.code === 'IMAGE_PROTECTED');
  assert.deepEqual(client.removed, []);
});

test('removal accepts only the selected full image ID and removes only an unused image', async () => {
  const client = new FakeDockerImageClient();
  client.images = [image(), image({ id: imageB, repositoryTags: ['busybox:latest'] })];
  await createDockerImageService(client).removeImage(imageId);
  assert.deepEqual(client.removed, [imageId]);
});

test('Docker daemon failures are translated safely for image inventory', async () => {
  const client = new FakeDockerImageClient();
  client.listError = new DockerUnavailableError();
  await assert.rejects(createDockerImageService(client).listImages(), DockerUnavailableError);
});

async function imageTestServer(context: TestContext) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/docker', dockerRouter);
  app.use(errorHandler);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}/api/docker`, cookie: `${SESSION_COOKIE_NAME}=${createSessionToken('image-test-user')}` };
}

test('image endpoints require authentication before any Docker operation', async (context) => {
  const { baseUrl } = await imageTestServer(context);
  for (const [path, method] of [['/images', 'GET'], ['/images/pull', 'POST'], [`/images/${imageId}`, 'GET'], [`/images/${imageId}`, 'DELETE']] as const) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? JSON.stringify({ reference: 'nginx' }) : undefined,
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
  }
});

test('image endpoints reject invalid references and IDs before Docker calls', async (context) => {
  const { baseUrl, cookie } = await imageTestServer(context);
  const pull = await fetch(`${baseUrl}/images/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ reference: 'nginx;invalid' }),
  });
  assert.equal(pull.status, 400);
  assert.equal((await pull.json() as { code: string }).code, 'INVALID_IMAGE_REFERENCE');
  const inspect = await fetch(`${baseUrl}/images/not-an-image-id`, { headers: { cookie } });
  assert.equal(inspect.status, 400);
  assert.equal((await inspect.json() as { code: string }).code, 'INVALID_IMAGE_ID');
  const remove = await fetch(`${baseUrl}/images/nginx%3Alatest`, { method: 'DELETE', headers: { cookie } });
  assert.equal(remove.status, 400);
  assert.equal((await remove.json() as { code: string }).code, 'INVALID_IMAGE_ID');
});
