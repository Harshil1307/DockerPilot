import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import cookieParser from 'cookie-parser';
import express from 'express';
import { test, type TestContext } from 'node:test';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants.js';
import { createSessionToken } from '../src/auth/session-token.js';
import { AppError } from '../src/errors/app-error.js';
import { DockerUnavailableError } from '../src/errors/docker-unavailable-error.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { dockerRouter } from '../src/routes/docker.routes.js';
import { createDockerVolumeService, validateDockerVolumeName, type DockerVolumeClient, type DockerVolumeRecord } from '../src/services/docker-volume.service.js';

const volume = (overrides: Partial<DockerVolumeRecord> = {}): DockerVolumeRecord => ({
  name: 'project_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/project_data/_data',
  createdAt: '2026-10-31T10:00:00.000Z', scope: 'local', labels: {}, ...overrides,
});

class FakeDockerVolumeClient implements DockerVolumeClient {
  volumes = [volume()];
  references: { id: string; name: string; state: string }[] = [];
  listError: unknown;
  created: string[] = [];
  removed: string[] = [];
  createDelay: Promise<void> | null = null;
  async listVolumes() { if (this.listError) throw this.listError; return this.volumes; }
  async inspectVolume(name: string) {
    if (this.listError) throw this.listError;
    const found = this.volumes.find((entry) => entry.name === name);
    if (!found) throw Object.assign(new Error('raw docker message'), { statusCode: 404 });
    return found;
  }
  async listContainers() { if (this.listError) throw this.listError; return this.references; }
  async createVolume(name: string) {
    if (this.createDelay) await this.createDelay;
    this.created.push(name);
    const result = volume({ name });
    this.volumes.push(result);
    return result;
  }
  async removeVolume(name: string) { this.removed.push(name); this.volumes = this.volumes.filter((entry) => entry.name !== name); }
}

test('validates Docker volume names and rejects invalid input', () => {
  assert.equal(validateDockerVolumeName('team.data-1'), 'team.data-1');
  for (const name of ['', '-leading', 'contains/slash', 'space name', 'bad;name', 'x'.repeat(256), null]) {
    assert.throws(() => validateDockerVolumeName(name), (error: unknown) => error instanceof AppError && error.code === 'INVALID_VOLUME_NAME');
  }
});

test('volume inventory is sorted, summarizes references including stopped containers, and hides unsafe labels', async () => {
  const client = new FakeDockerVolumeClient();
  client.volumes = [volume({ name: 'z_data', labels: { 'private.token': 'secret', 'com.docker.compose.volume': 'data' } }), volume({ name: 'a_data' })];
  client.references = [{ id: 'running-id', name: 'z_data', state: 'running' }, { id: 'stopped-id', name: 'z_data', state: 'exited' }];
  const results = await createDockerVolumeService(client).listVolumes();
  assert.deepEqual(results.map((entry) => entry.name), ['a_data', 'z_data']);
  assert.equal(results[1]?.containerCount, 2);
  assert.equal(results[1]?.inUse, true);
  assert.deepEqual(results[1]?.labels, { 'com.docker.compose.volume': 'data' });
  assert.equal(JSON.stringify(results).includes('secret'), false);
});

test('volume inspection shows safe container names and running or stopped states', async () => {
  const client = new FakeDockerVolumeClient();
  client.references = [{ id: 'running-id', name: 'project_data', state: 'running' }, { id: 'stopped-id', name: 'project_data', state: 'exited' }];
  const result = await createDockerVolumeService(client).inspectVolume('project_data');
  assert.equal(result.driver, 'local');
  assert.equal(result.scope, 'local');
  assert.deepEqual(result.containers.map(({ id, state }) => [id, state]), [['running-id', 'running'], ['stopped-id', 'exited']]);
  assert.equal('environment' in result.containers[0]!, false);
});

test('inspection returns a safe not-found error and daemon unavailability is handled', async () => {
  const client = new FakeDockerVolumeClient();
  await assert.rejects(createDockerVolumeService(client).inspectVolume('missing'), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_NOT_FOUND' && !error.message.includes('raw docker'));
  client.listError = Object.assign(new Error('private socket path'), { code: 'ECONNREFUSED' });
  await assert.rejects(createDockerVolumeService(client).listVolumes(), DockerUnavailableError);
});

test('creation uses a validated name and rejects existing volumes', async () => {
  const client = new FakeDockerVolumeClient();
  const service = createDockerVolumeService(client);
  const created = await service.createVolume('cache_data');
  assert.equal(created.name, 'cache_data');
  assert.deepEqual(client.created, ['cache_data']);
  await assert.rejects(service.createVolume('project_data'), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_ALREADY_EXISTS');
  await assert.rejects(service.createVolume('invalid/name'), (error: unknown) => error instanceof AppError && error.code === 'INVALID_VOLUME_NAME');
});

test('duplicate concurrent creation requests are rejected', async () => {
  const client = new FakeDockerVolumeClient();
  let release!: () => void;
  client.createDelay = new Promise<void>((resolve) => { release = resolve; });
  const service = createDockerVolumeService(client);
  const first = service.createVolume('parallel_data');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.createVolume('parallel_data'), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_CREATE_IN_PROGRESS');
  release();
  await first;
  assert.deepEqual(client.created, ['parallel_data']);
});

test('removal requires exact explicit confirmation and blocks running and stopped references', async () => {
  const client = new FakeDockerVolumeClient();
  const service = createDockerVolumeService(client);
  await assert.rejects(service.removeVolume('project_data', undefined), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_CONFIRMATION_REQUIRED');
  for (const state of ['running', 'exited']) {
    client.references = [{ id: `${state}-id`, name: 'project_data', state }];
    await assert.rejects(service.removeVolume('project_data', 'project_data'), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_IN_USE' && error.message.includes(state === 'running' ? '1 running' : '1 stopped'));
  }
  assert.deepEqual(client.removed, []);
});

test('removal protects DockerPilot infrastructure volumes identified by name or labels', async () => {
  const client = new FakeDockerVolumeClient();
  const service = createDockerVolumeService(client);
  client.volumes = [volume({ name: 'dockerpilot_postgres_data' })];
  await assert.rejects(service.removeVolume('dockerpilot_postgres_data', 'dockerpilot_postgres_data'), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_PROTECTED');
  client.volumes = [volume({ name: 'internal_data', labels: { 'com.dockerpilot.infrastructure': 'true' } })];
  await assert.rejects(service.removeVolume('internal_data', 'internal_data'), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_PROTECTED');
  client.volumes = [volume({ name: 'compose_data', labels: { 'com.docker.compose.project': 'DockerPilot' } })];
  await assert.rejects(service.removeVolume('compose_data', 'compose_data'), (error: unknown) => error instanceof AppError && error.code === 'VOLUME_PROTECTED');
  assert.deepEqual(client.removed, []);
});

test('eligible removal targets only the exact selected volume and refuses when Docker reports references', async () => {
  const client = new FakeDockerVolumeClient();
  client.volumes = [volume(), volume({ name: 'other_data' })];
  await createDockerVolumeService(client).removeVolume('project_data', 'project_data');
  assert.deepEqual(client.removed, ['project_data']);
  assert.deepEqual(client.volumes.map(({ name }) => name), ['other_data']);
});

async function volumeTestServer(context: TestContext) {
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
  return { baseUrl: `http://127.0.0.1:${address.port}/api/docker`, cookie: `${SESSION_COOKIE_NAME}=${createSessionToken('volume-test-user')}` };
}

test('all volume endpoints require authentication', async (context) => {
  const { baseUrl } = await volumeTestServer(context);
  for (const [path, method] of [['/volumes', 'GET'], ['/volumes', 'POST'], ['/volumes/project_data', 'GET'], ['/volumes/project_data', 'DELETE']] as const) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === 'POST' || method === 'DELETE' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? JSON.stringify({ name: 'valid_data' }) : method === 'DELETE' ? JSON.stringify({ confirmation: 'project_data' }) : undefined,
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
  }
});

test('volume endpoints reject invalid names and unconfirmed removal before Docker calls', async (context) => {
  const { baseUrl, cookie } = await volumeTestServer(context);
  const create = await fetch(`${baseUrl}/volumes`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'bad/name' }) });
  assert.equal(create.status, 400);
  assert.equal((await create.json() as { code: string }).code, 'INVALID_VOLUME_NAME');
  const remove = await fetch(`${baseUrl}/volumes/project_data`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ confirmation: 'other_data' }) });
  assert.equal(remove.status, 400);
  assert.equal((await remove.json() as { code: string }).code, 'VOLUME_CONFIRMATION_REQUIRED');
});
