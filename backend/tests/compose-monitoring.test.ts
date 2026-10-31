import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import { DockerUnavailableError } from '../src/errors/docker-unavailable-error.js';
import {
  calculateContainerMetrics,
  COMPOSE_LOG_MAX_BYTES,
  COMPOSE_LOG_MAX_LINES,
  createComposeMonitoringService,
  parseDockerLogBuffer,
  withMonitoringTimeout,
  type MonitoringDocker,
} from '../src/services/compose-monitoring.service.js';
import {
  generatedComposeProjectName,
  type ComposeDeploymentOwnershipRepository,
  type RegisteredComposeDeployment,
} from '../src/services/compose-ownership.service.js';
import type { ComposeDockerResource, ComposeDeploymentIdentity } from '../src/services/docker.service.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const environmentId = '44444444-4444-4444-8444-444444444444';
const containerId = 'a'.repeat(64);
const networkId = 'b'.repeat(64);
const extraId = 'c'.repeat(64);
const composeProjectName = generatedComposeProjectName(environmentId);

function labels(extra: Record<string, string> = {}) {
  return {
    'com.dockerpilot.managed': 'true',
    'com.dockerpilot.owner-id': ownerId,
    'com.dockerpilot.project-id': projectId,
    'com.dockerpilot.environment-id': environmentId,
    'com.docker.compose.project': composeProjectName,
    'com.docker.compose.service': 'web',
    ...extra,
  };
}

function record(overrides: Partial<RegisteredComposeDeployment> = {}): RegisteredComposeDeployment {
  return {
    id: environmentId, projectId, deploymentStatus: 'RUNNING', deploymentProjectName: composeProjectName,
    deploymentCompletedAt: new Date(), lastDeploymentError: null,
    deploymentContainerIds: [containerId], deploymentNetworkIds: [networkId],
    deploymentRemovedContainerIds: [], deploymentRemovedNetworkIds: [],
    project: { id: projectId, userId: ownerId },
    ...overrides,
  };
}

function fixture(options: {
  record?: Partial<RegisteredComposeDeployment>;
  resources?: ComposeDockerResource[];
  details?: Awaited<ReturnType<MonitoringDocker['inspectComposeContainer']>>;
  stats?: Awaited<ReturnType<MonitoringDocker['getComposeContainerStats']>>;
  statsError?: Error;
  logs?: { data: Buffer; tty: boolean };
  logsError?: Error;
  listError?: Error;
} = {}) {
  let requestedLogTail: number | undefined;
  const deployment = record(options.record);
  const resourceList = options.resources ?? [
    { type: 'container', id: containerId, labels: labels(), attachedContainerIds: [], running: true },
    { type: 'network', id: networkId, labels: labels(), attachedContainerIds: [containerId] },
  ];
  const repository: ComposeDeploymentOwnershipRepository = {
    async findDeployment(id) { return id === environmentId ? structuredClone(deployment) : null; },
  };
  const docker: MonitoringDocker = {
    async listComposeDeploymentResources(_identity: ComposeDeploymentIdentity, registeredContainers, registeredNetworks) {
      if (options.listError) throw options.listError;
      return resourceList.filter((resource) =>
        (resource.type === 'container' ? registeredContainers : registeredNetworks).includes(resource.id)
        || resource.labels['com.docker.compose.project'] === composeProjectName
        || resource.labels['com.dockerpilot.environment-id'] === environmentId);
    },
    async inspectComposeContainer(id) {
      if (id !== containerId) return null;
      return options.details ?? {
        id: containerId, name: 'dockerpilot-web-1', serviceName: 'web', state: 'running', health: 'healthy',
        image: 'nginx:alpine', createdAt: '2026-10-31T10:00:00.000Z', startedAt: '2026-10-31T10:01:00.000Z', labels: labels(),
      };
    },
    async getComposeContainerStats() {
      if (options.statsError) throw options.statsError;
      return options.stats ?? ({
        cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000, online_cpus: 4 },
        memory_stats: { usage: 1000, limit: 2000, stats: { total_inactive_file: 200 } },
      } as never);
    },
    async getComposeContainerLogs(_id: string, tail = 100) {
      requestedLogTail = tail;
      if (options.logsError) throw options.logsError;
      return options.logs ?? { data: Buffer.alloc(0), tty: false };
    },
  };
  return { service: createComposeMonitoringService(repository, docker), docker, deployment, get requestedLogTail() { return requestedLogTail; } };
}

function frame(stream: 1 | 2, value: string): Buffer {
  const payload = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test('inventory returns only registered, verified deployment containers', async () => {
  const f = fixture();
  const inventory = await f.service.getInventory(environmentId, ownerId);
  assert.equal(inventory.containers.length, 1);
  assert.equal(inventory.containers[0]?.serviceName, 'web');
  assert.equal(inventory.containers[0]?.state, 'running');
  assert.equal(inventory.containers[0]?.health, 'healthy');
  assert.equal(inventory.containers[0]?.image, 'nginx:alpine');
  assert.equal(inventory.containers[0]?.metrics.cpuPercent, 40);
  assert.equal(inventory.containers[0]?.metrics.memoryUsageBytes, 800);
  assert.equal(inventory.containers[0]?.metrics.memoryPercent, 40);
});

test('cross-user monitoring is rejected before container inspection', async () => {
  const f = fixture();
  let inspected = false;
  f.docker.inspectComposeContainer = async () => { inspected = true; return null; };
  await assert.rejects(f.service.getInventory(environmentId, otherUserId), { statusCode: 404 });
  assert.equal(inspected, false);
});

test('unregistered resources with deployment labels are rejected', async () => {
  const f = fixture({ resources: [{ type: 'container', id: extraId, labels: labels(), attachedContainerIds: [] }] });
  await assert.rejects(f.service.getInventory(environmentId, ownerId), { code: 'DEPLOYMENT_OWNERSHIP_CONFLICT' });
});

test('missing registered containers are represented as removed without leaking other containers', async () => {
  const f = fixture({ resources: [] });
  const inventory = await f.service.getInventory(environmentId, ownerId);
  assert.equal(inventory.containers[0]?.state, 'removed');
  assert.equal(inventory.containers[0]?.name, null);
  assert.equal(inventory.containers[0]?.metrics.cpuPercent, null);
});

test('invalid or missing statistics remain unavailable instead of becoming zero', () => {
  assert.deepEqual(calculateContainerMetrics(undefined), {
    cpuPercent: null, memoryUsageBytes: null, memoryLimitBytes: null, memoryPercent: null,
  });
  assert.deepEqual(calculateContainerMetrics({
    cpu_stats: { cpu_usage: { total_usage: Number.NaN }, system_cpu_usage: 0, online_cpus: 0 },
    precpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 0 },
    memory_stats: { usage: Number.NaN, limit: -1 },
  } as never), {
    cpuPercent: null, memoryUsageBytes: null, memoryLimitBytes: null, memoryPercent: null,
  });
});

test('statistics failures are reported as unavailable without failing the inventory', async () => {
  const f = fixture({ statsError: new Error('private Docker response text') });
  const result = await f.service.getInventory(environmentId, ownerId);
  assert.equal(result.containers[0]?.metrics.cpuPercent, null);
  assert.equal(result.containers[0]?.metrics.memoryUsageBytes, null);
  assert.equal(result.containers[0]?.metricsUnavailableReason, 'Statistics are unavailable for this container.');
});

test('Docker log multiplexing distinguishes stdout and stderr and redacts common credentials', () => {
  const parsed = parseDockerLogBuffer(Buffer.concat([
    frame(1, '2026-10-31T10:00:00Z {"client_secret":"secret-value"}\n'),
    frame(2, '2026-10-31T10:00:01Z request failed\n'),
  ]), false);
  assert.equal(parsed.lines[0]?.stream, 'stdout');
  assert.match(parsed.lines[0]?.text ?? '', /"client_secret":\[REDACTED\]/);
  assert.equal(parsed.lines[1]?.stream, 'stderr');
});

test('Compose log tail is selectable while response bytes and redaction stay bounded', async () => {
  const f = fixture({ logs: { data: Buffer.from(Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n')), tty: true } });
  const result = await f.service.getRecentLogs(environmentId, ownerId, containerId, 50);
  assert.equal(f.requestedLogTail, 50);
  assert.equal(result.tail, 50);
  assert.equal(result.lines.length, 50);
  assert.equal(result.lines[0]?.text, 'line 70');
});

test('log redaction covers API keys, bearer tokens, passwords, private keys, and connection strings', () => {
  const sensitive = [
    'api_key=api-secret-123',
    'provider key sk-12345678901234567890abcdef',
    'Authorization: Bearer bearer-secret-123',
    'password: "password-secret-123"',
    'private_key=private-secret-123',
    'postgres://dbuser:connection-secret-123@db.internal/dockerpilot',
  ];
  const parsed = parseDockerLogBuffer(Buffer.from(`${sensitive.join('\n')}\n`), true);
  const output = parsed.lines.map((line) => line.text).join('\n');
  for (const secret of ['api-secret-123', 'sk-12345678901234567890abcdef', 'bearer-secret-123', 'password-secret-123', 'private-secret-123', 'connection-secret-123']) {
    assert.equal(output.includes(secret), false, `expected ${secret} to be redacted`);
  }
  assert.match(output, /\[REDACTED\]/);
});

test('logs enforce line and byte limits and return a useful empty result', () => {
  const manyLines = Array.from({ length: COMPOSE_LOG_MAX_LINES + 20 }, (_, index) => `line-${index}\n`).join('');
  const byLine = parseDockerLogBuffer(Buffer.from(manyLines), true);
  assert.equal(byLine.lines.length, COMPOSE_LOG_MAX_LINES);
  assert.equal(byLine.truncated, true);
  const byBytes = parseDockerLogBuffer(Buffer.from(`${'x'.repeat(COMPOSE_LOG_MAX_BYTES + 20)}\n`), true);
  assert.ok(byBytes.lines.reduce((total, line) => total + Buffer.byteLength(line.text), 0) <= COMPOSE_LOG_MAX_BYTES);
  const serializedResponse = JSON.stringify({ environmentId, containerId, lines: byBytes.lines, truncated: byBytes.truncated });
  assert.ok(Buffer.byteLength(serializedResponse, 'utf8') <= COMPOSE_LOG_MAX_BYTES);
  assert.deepEqual(parseDockerLogBuffer(Buffer.alloc(0), true), { lines: [], truncated: false });
});

test('logs require a registered container ID and return only bounded recent output', async () => {
  const f = fixture({ logs: { data: frame(1, 'recent message\n'), tty: false } });
  const result = await f.service.getRecentLogs(environmentId, ownerId, containerId);
  assert.equal(result.lines[0]?.text, 'recent message');
  await assert.rejects(f.service.getRecentLogs(environmentId, ownerId, extraId), { code: 'CONTAINER_NOT_FOUND' });
});

test('log failures do not expose raw Docker daemon output', async () => {
  const f = fixture({ logsError: new Error('daemon response contains private data') });
  await assert.rejects(f.service.getRecentLogs(environmentId, ownerId, containerId), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'CONTAINER_LOGS_FAILED');
    assert.equal(error.message.includes('private data'), false);
    return true;
  });
});

test('Docker daemon errors and request timeouts are surfaced safely', async () => {
  const unavailable = fixture({ listError: new DockerUnavailableError() });
  await assert.rejects(unavailable.service.getInventory(environmentId, ownerId), DockerUnavailableError);
  await assert.rejects(withMonitoringTimeout(new Promise(() => undefined), 1, 'TEST_TIMEOUT'), (error: unknown) =>
    error instanceof AppError && error.statusCode === 504 && error.code === 'TEST_TIMEOUT');
});
