import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import { composeLifecycleService } from '../src/services/compose-lifecycle.service.js';
import { dockerService, type ComposeDockerResource } from '../src/services/docker.service.js';
import { generatedComposeProjectName } from '../src/services/compose-ownership.service.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const environmentId = '44444444-4444-4444-8444-444444444444';
const containerId = 'a'.repeat(64);
const networkId = 'b'.repeat(64);
const projectName = generatedComposeProjectName(environmentId);

function fixture(status: 'RUNNING' | 'STOPPED' = 'RUNNING') {
  const labels = {
    'com.dockerpilot.managed': 'true',
    'com.dockerpilot.owner-id': ownerId,
    'com.dockerpilot.project-id': projectId,
    'com.dockerpilot.environment-id': environmentId,
    'com.docker.compose.project': projectName,
  };
  const deployment: Record<string, unknown> = {
    id: environmentId, projectId, deploymentStatus: status, deploymentProjectName: projectName,
    deploymentCompletedAt: new Date(), lastDeploymentError: null,
    deploymentContainerIds: [containerId], deploymentNetworkIds: [networkId],
    deploymentRemovedContainerIds: [], deploymentRemovedNetworkIds: [],
    project: { id: projectId, userId: ownerId },
  };
  let running = status === 'RUNNING';
  const resources: ComposeDockerResource[] = [
    { type: 'container', id: containerId, labels, attachedContainerIds: [], running },
    { type: 'network', id: networkId, labels, attachedContainerIds: [containerId] },
  ];
  const delegate = prisma.composeEnvironment as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const docker = dockerService as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originals = { findUnique: delegate.findUnique, updateMany: delegate.updateMany, list: docker.listComposeDeploymentResources, control: docker.controlContainer };
  delegate.findUnique = async (args: unknown) => {
    const query = args as { where?: { id?: string } };
    return query.where?.id === environmentId ? structuredClone(deployment) : null;
  };
  delegate.updateMany = async (args: unknown) => {
    const query = args as { where?: { deploymentStatus?: string }; data?: Record<string, unknown> };
    if (query.where?.deploymentStatus && query.where.deploymentStatus !== deployment.deploymentStatus) return { count: 0 };
    Object.assign(deployment, query.data);
    return { count: 1 };
  };
  docker.listComposeDeploymentResources = async () => resources.map((resource) => ({
    ...resource,
    ...(resource.type === 'container' ? { running } : { attachedContainerIds: running ? [containerId] : [] }),
  }));
  docker.controlContainer = async (...args: unknown[]) => {
    const action = args[2] as 'start' | 'stop' | 'restart';
    const verify = args[3] as (container: { Id: string; Config: { Labels: Record<string, string> } }) => Promise<void>;
    await verify({ Id: containerId, Config: { Labels: labels } });
    running = action !== 'stop';
    const container = resources.find((resource) => resource.type === 'container');
    if (container?.type === 'container') container.running = running;
    await verify({ Id: containerId, Config: { Labels: labels } });
    return { id: containerId, action };
  };
  return {
    deployment,
    restore() {
      delegate.findUnique = originals.findUnique;
      delegate.updateMany = originals.updateMany;
      docker.listComposeDeploymentResources = originals.list;
      docker.controlContainer = originals.control;
    },
  };
}

test('start, stop, and restart update only the registered deployment state', async () => {
  for (const [action, before, after] of [
    ['start', 'STOPPED', 'RUNNING'], ['stop', 'RUNNING', 'STOPPED'], ['restart', 'RUNNING', 'RUNNING'],
  ] as const) {
    const f = fixture(before);
    try {
      const result = await composeLifecycleService.operate(environmentId, ownerId, action);
      assert.equal(result.status, after);
      assert.equal(f.deployment.deploymentStatus, after);
    } finally { f.restore(); }
  }
});

test('invalid transitions and cross-user requests do not operate containers', async () => {
  const f = fixture('RUNNING');
  const docker = dockerService as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalControl = docker.controlContainer;
  let controls = 0;
  docker.controlContainer = async () => { controls += 1; return {}; };
  try {
    await assert.rejects(composeLifecycleService.operate(environmentId, ownerId, 'start'), { code: 'DEPLOYMENT_STATE_CONFLICT' });
    await assert.rejects(composeLifecycleService.operate(environmentId, otherUserId, 'stop'), { statusCode: 404 });
    assert.equal(controls, 0);
  } finally {
    docker.controlContainer = originalControl;
    f.restore();
  }
});

test('failed lifecycle calls retain a safe failure state for cleanup or retry', async () => {
  for (const [action, status] of [['start', 'STOPPED'], ['stop', 'RUNNING'], ['restart', 'RUNNING']] as const) {
    const f = fixture(status);
    const docker = dockerService as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const originalControl = docker.controlContainer;
    docker.controlContainer = async () => { throw new AppError('Docker Engine operation failed safely.', 503, 'DOCKER_UNAVAILABLE'); };
    try {
      await assert.rejects(composeLifecycleService.operate(environmentId, ownerId, action), { code: 'DOCKER_UNAVAILABLE' });
      assert.equal(f.deployment.deploymentStatus, 'FAILED');
      assert.equal(f.deployment.lastDeploymentError, 'Docker Engine operation failed safely.');
    } finally {
      docker.controlContainer = originalControl;
      f.restore();
    }
  }
});

test('duplicate lifecycle requests are rejected while the first operation is in flight', async () => {
  const f = fixture('RUNNING');
  const docker = dockerService as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalControl = docker.controlContainer;
  let release!: () => void;
  docker.controlContainer = async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return {};
  };
  try {
    const first = composeLifecycleService.operate(environmentId, ownerId, 'stop');
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(composeLifecycleService.operate(environmentId, ownerId, 'stop'), { code: 'DEPLOYMENT_OPERATION_IN_PROGRESS' });
    release();
    assert.equal((await first).status, 'STOPPED');
  } finally {
    release?.();
    docker.controlContainer = originalControl;
    f.restore();
  }
});
