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
import { createDockerNetworkService, validateDockerNetworkName, type DockerNetworkClient, type DockerNetworkRecord } from '../src/services/docker-network.service.js';

const idA = 'a'.repeat(64);
const idB = 'b'.repeat(64);
const network = (overrides: Partial<DockerNetworkRecord> = {}): DockerNetworkRecord => ({
  id: idA, name: 'project_network', driver: 'bridge', scope: 'local', internal: false, enableIPv6: false,
  createdAt: '2026-10-31T10:00:00.000Z', labels: {}, subnets: [{ subnet: '172.28.0.0/16', gateway: '172.28.0.1' }], ...overrides,
});

class FakeDockerNetworkClient implements DockerNetworkClient {
  networks = [network()];
  containers: { id: string; name: string; state: string | null; networkIds: string[] }[] = [];
  ipv6Supported = false;
  listError: unknown;
  created: { name: string; internal: boolean; enableIPv6: boolean }[] = [];
  removed: string[] = [];
  createDelay: Promise<void> | null = null;
  async listNetworks() { if (this.listError) throw this.listError; return this.networks; }
  async inspectNetwork(id: string) {
    if (this.listError) throw this.listError;
    const result = this.networks.find((entry) => entry.id === id);
    if (!result) throw Object.assign(new Error('private network detail'), { statusCode: 404 });
    return result;
  }
  async listContainers() { if (this.listError) throw this.listError; return this.containers; }
  async supportsIPv6() { if (this.listError) throw this.listError; return this.ipv6Supported; }
  async createNetwork(name: string, options: { internal: boolean; enableIPv6: boolean }) {
    if (this.createDelay) await this.createDelay;
    this.created.push({ name, ...options });
    const result = network({ id: idB, name, internal: options.internal, enableIPv6: options.enableIPv6 });
    this.networks.push(result);
    return result;
  }
  async removeNetwork(id: string) { this.removed.push(id); this.networks = this.networks.filter((entry) => entry.id !== id); }
}

test('validates safe Docker network names', () => {
  assert.equal(validateDockerNetworkName('team.net-1'), 'team.net-1');
  for (const name of ['', '-leading', 'bad/name', 'space name', 'bad;name', 'x'.repeat(256), null]) {
    assert.throws(() => validateDockerNetworkName(name), (error: unknown) => error instanceof AppError && error.code === 'INVALID_NETWORK_NAME');
  }
});

test('network inventory returns sorted safe metadata and all attached container counts', async () => {
  const client = new FakeDockerNetworkClient();
  client.networks = [network({ id: idB, name: 'z_network', labels: { 'private.token': 'secret', 'com.docker.compose.project': 'z-stack' } }), network({ name: 'a_network' })];
  client.containers = [
    { id: 'running-id', name: 'running_app', state: 'running', networkIds: [idB] },
    { id: 'stopped-id', name: 'stopped_app', state: 'exited', networkIds: [idB] },
  ];
  const result = await createDockerNetworkService(client).listNetworks();
  assert.deepEqual(result.networks.map((entry) => entry.name), ['a_network', 'z_network']);
  assert.equal(result.networks[1]?.shortId, idB.slice(0, 12));
  assert.equal(result.networks[1]?.containerCount, 2);
  assert.deepEqual(result.networks[1]?.labels, { 'com.docker.compose.project': 'z-stack' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('network inspection includes safe container identity and state and handles no attachments', async () => {
  const client = new FakeDockerNetworkClient();
  client.containers = [
    { id: 'full-running-container', name: 'app_running', state: 'running', networkIds: [idA] },
    { id: 'full-stopped-container', name: 'app_stopped', state: 'exited', networkIds: [idA] },
  ];
  const service = createDockerNetworkService(client);
  const details = await service.inspectNetwork(idA);
  assert.deepEqual(details.containers.map(({ name, state }) => [name, state]), [['app_running', 'running'], ['app_stopped', 'exited']]);
  client.containers = [];
  assert.deepEqual((await service.inspectNetwork(idA)).containers, []);
});

test('inspection validates full IDs, verifies exact identity, and maps missing network safely', async () => {
  const client = new FakeDockerNetworkClient();
  const service = createDockerNetworkService(client);
  await assert.rejects(service.inspectNetwork('project_network'), (error: unknown) => error instanceof AppError && error.code === 'INVALID_NETWORK_ID');
  await assert.rejects(service.inspectNetwork(idB), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_NOT_FOUND' && !error.message.includes('private network detail'));
  client.inspectNetwork = async () => network({ id: idB });
  await assert.rejects(service.inspectNetwork(idA), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_IDENTITY_CHANGED');
});

test('Docker daemon unavailability is translated safely', async () => {
  const client = new FakeDockerNetworkClient();
  client.listError = Object.assign(new Error('private socket path'), { code: 'ECONNREFUSED' });
  await assert.rejects(createDockerNetworkService(client).listNetworks(), DockerUnavailableError);
});

test('network creation uses the bridge driver contract, options, and rejects duplicate names', async () => {
  const client = new FakeDockerNetworkClient();
  client.ipv6Supported = true;
  const service = createDockerNetworkService(client);
  const created = await service.createNetwork('private_network', { internal: true, enableIPv6: true });
  assert.equal(created.name, 'private_network');
  assert.deepEqual(client.created, [{ name: 'private_network', internal: true, enableIPv6: true }]);
  await assert.rejects(service.createNetwork('project_network'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_ALREADY_EXISTS');
  await assert.rejects(service.createNetwork('invalid/name'), (error: unknown) => error instanceof AppError && error.code === 'INVALID_NETWORK_NAME');
});

test('network creation rejects unsupported IPv6 and invalid configuration', async () => {
  const client = new FakeDockerNetworkClient();
  const service = createDockerNetworkService(client);
  await assert.rejects(service.createNetwork('ipv6_network', { enableIPv6: true }), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_IPV6_UNSUPPORTED');
  await assert.rejects(service.createNetwork('bad_configuration', { internal: 'yes' }), (error: unknown) => error instanceof AppError && error.code === 'INVALID_NETWORK_CONFIGURATION');
  assert.deepEqual(client.created, []);
});

test('duplicate network creation requests are rejected while the first is pending', async () => {
  const client = new FakeDockerNetworkClient();
  let release!: () => void;
  client.createDelay = new Promise<void>((resolve) => { release = resolve; });
  const service = createDockerNetworkService(client);
  const first = service.createNetwork('parallel_network');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.createNetwork('parallel_network'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_CREATE_IN_PROGRESS');
  release();
  await first;
  assert.equal(client.created.length, 1);
});

test('network removal requires exact confirmation and refuses running or stopped connections', async () => {
  const client = new FakeDockerNetworkClient();
  const service = createDockerNetworkService(client);
  await assert.rejects(service.removeNetwork(idA, undefined), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_CONFIRMATION_REQUIRED');
  await assert.rejects(service.removeNetwork(idA, 'different_name'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_CONFIRMATION_REQUIRED');
  for (const state of ['running', 'exited']) {
    client.containers = [{ id: `${state}-id`, name: `${state}_service`, state, networkIds: [idA] }];
    await assert.rejects(service.removeNetwork(idA, 'project_network'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_IN_USE' && error.message.includes(`${state}_service`));
  }
  assert.deepEqual(client.removed, []);
});

test('network removal protects DockerPilot and system networks and rejects changed identity', async () => {
  const client = new FakeDockerNetworkClient();
  const service = createDockerNetworkService(client);
  client.networks = [network({ name: 'dockerpilot_default' })];
  await assert.rejects(service.removeNetwork(idA, 'dockerpilot_default'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_PROTECTED');
  client.networks = [network({ name: 'custom_internal', labels: { 'com.dockerpilot.infrastructure': 'true' } })];
  await assert.rejects(service.removeNetwork(idA, 'custom_internal'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_PROTECTED');
  client.networks = [network({ name: 'bridge' })];
  await assert.rejects(service.removeNetwork(idA, 'bridge'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_PROTECTED');
  client.networks = [network({ id: idB })];
  await assert.rejects(service.removeNetwork(idA, 'project_network'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_NOT_FOUND');
  assert.deepEqual(client.removed, []);
});

test('successful network removal targets the full selected ID only', async () => {
  const client = new FakeDockerNetworkClient();
  client.networks = [network(), network({ id: idB, name: 'other_network' })];
  await createDockerNetworkService(client).removeNetwork(idA, 'project_network');
  assert.deepEqual(client.removed, [idA]);
  assert.deepEqual(client.networks.map(({ id }) => id), [idB]);
});

test('network removal refuses if inspection returns a different full network ID', async () => {
  const client = new FakeDockerNetworkClient();
  client.inspectNetwork = async () => network({ id: idB, name: 'project_network' });
  await assert.rejects(createDockerNetworkService(client).removeNetwork(idA, 'project_network'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_IDENTITY_CHANGED');
  assert.deepEqual(client.removed, []);
});

async function networkTestServer(context: TestContext) {
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
  return { baseUrl: `http://127.0.0.1:${address.port}/api/docker`, cookie: `${SESSION_COOKIE_NAME}=${createSessionToken('network-test-user')}` };
}

test('all network endpoints require authentication', async (context) => {
  const { baseUrl } = await networkTestServer(context);
  for (const [path, method] of [['/networks', 'GET'], ['/networks', 'POST'], [`/networks/${idA}`, 'GET'], [`/networks/${idA}`, 'DELETE']] as const) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === 'POST' || method === 'DELETE' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? JSON.stringify({ name: 'safe_network' }) : method === 'DELETE' ? JSON.stringify({ confirmationName: 'network' }) : undefined,
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
  }
});

test('network endpoints reject invalid names, IDs, and removal confirmation before Docker calls', async (context) => {
  const { baseUrl, cookie } = await networkTestServer(context);
  const create = await fetch(`${baseUrl}/networks`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'bad/name' }) });
  assert.equal(create.status, 400);
  assert.equal((await create.json() as { code: string }).code, 'INVALID_NETWORK_NAME');
  const inspect = await fetch(`${baseUrl}/networks/short-id`, { headers: { cookie } });
  assert.equal(inspect.status, 400);
  assert.equal((await inspect.json() as { code: string }).code, 'INVALID_NETWORK_ID');
  const remove = await fetch(`${baseUrl}/networks/${idA}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({}) });
  assert.equal(remove.status, 400);
  assert.equal((await remove.json() as { code: string }).code, 'NETWORK_CONFIRMATION_REQUIRED');
});
