import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ComposeDockerResource,
  ComposeDockerResourceType,
  ComposeDeploymentIdentity,
} from '../src/services/docker.service.js';
import {
  createComposeCleanupService,
  type ComposeCleanupDocker,
  type ComposeCleanupRepository,
} from '../src/services/compose-cleanup.service.js';
import {
  generatedComposeProjectName,
  type RegisteredComposeDeployment,
} from '../src/services/compose-ownership.service.js';
import { DockerUnavailableError } from '../src/errors/docker-unavailable-error.js';
import { app } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { projectService } from '../src/services/project.service.js';
import { composeEnvironmentService } from '../src/services/compose-environment.service.js';
import { composeDeploymentOwnershipService } from '../src/services/compose-ownership.service.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const environmentId = '44444444-4444-4444-8444-444444444444';
const containerId = 'a'.repeat(64);
const networkId = 'b'.repeat(64);
const unexpectedContainerId = 'c'.repeat(64);
const composeProjectName = generatedComposeProjectName(environmentId);

function identity(userId = ownerId): ComposeDeploymentIdentity {
  return { ownerId: userId, projectId, environmentId, composeProjectName };
}

function expectedLabels(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'com.dockerpilot.managed': 'true',
    'com.dockerpilot.owner-id': ownerId,
    'com.dockerpilot.project-id': projectId,
    'com.dockerpilot.environment-id': environmentId,
    'com.docker.compose.project': composeProjectName,
    ...extra,
  };
}

function record(overrides: Partial<RegisteredComposeDeployment> = {}): RegisteredComposeDeployment {
  return {
    id: environmentId,
    projectId,
    deploymentStatus: 'RUNNING',
    deploymentProjectName: composeProjectName,
    deploymentCompletedAt: new Date(),
    lastDeploymentError: null,
    deploymentContainerIds: [containerId],
    deploymentNetworkIds: [networkId],
    deploymentRemovedContainerIds: [],
    deploymentRemovedNetworkIds: [],
    project: { id: projectId, userId: ownerId },
    ...overrides,
  };
}

function fixture(options: {
  record?: Partial<RegisteredComposeDeployment>;
  resources?: ComposeDockerResource[];
  failRemove?: ComposeDockerResourceType | null;
  unavailable?: boolean;
} = {}) {
  const deployment = record(options.record);
  let failRemove = options.failRemove ?? null;
  let unavailable = options.unavailable ?? false;
  const resources = new Map((options.resources ?? [
    { type: 'container', id: containerId, labels: expectedLabels(), attachedContainerIds: [], running: true },
    { type: 'network', id: networkId, labels: expectedLabels(), attachedContainerIds: [containerId] },
  ]).map((resource) => [`${resource.type}:${resource.id}`, structuredClone(resource)]));
  const removed: string[] = [];

  const repository: ComposeCleanupRepository = {
    async findDeployment(id) {
      return id === environmentId ? structuredClone(deployment) : null;
    },
    async claimCleanup(id, userId) {
      if (id !== environmentId || userId !== ownerId || !['RUNNING', 'STOPPED', 'FAILED', 'CLEANUP_FAILED', 'REMOVED'].includes(deployment.deploymentStatus)) return false;
      deployment.deploymentStatus = 'CLEANING';
      return true;
    },
    async updateCleanup(_id, _userId, data) {
      deployment.deploymentStatus = data.deploymentStatus;
      if (data.deploymentCompletedAt) deployment.deploymentCompletedAt = data.deploymentCompletedAt;
      if (data.deploymentRemovedContainerIds) deployment.deploymentRemovedContainerIds = data.deploymentRemovedContainerIds;
      if (data.deploymentRemovedNetworkIds) deployment.deploymentRemovedNetworkIds = data.deploymentRemovedNetworkIds;
      if (Object.hasOwn(data, 'lastDeploymentError')) deployment.lastDeploymentError = data.lastDeploymentError ?? null;
    },
  };

  const docker: ComposeCleanupDocker = {
    async listComposeDeploymentResources(deploymentIdentity, registeredContainers, registeredNetworks) {
      if (unavailable) throw new DockerUnavailableError();
      return [...resources.values()].filter((resource) => {
        const known = resource.type === 'container' ? registeredContainers : registeredNetworks;
        return known.includes(resource.id)
          || resource.labels['com.docker.compose.project'] === deploymentIdentity.composeProjectName
          || resource.labels['com.dockerpilot.environment-id'] === deploymentIdentity.environmentId;
      }).map((resource) => structuredClone(resource));
    },
    async inspectComposeResource(type, id) {
      if (unavailable) throw new DockerUnavailableError();
      const resource = resources.get(`${type}:${id}`);
      return resource ? structuredClone(resource) : null;
    },
    async removeComposeResource(type, id) {
      if (unavailable) throw new DockerUnavailableError();
      if (failRemove === type) {
        failRemove = null;
        throw new Error('simulated Docker removal failure');
      }
      resources.delete(`${type}:${id}`);
      removed.push(`${type}:${id}`);
    },
  };

  return {
    cleanup: createComposeCleanupService(repository, docker),
    repository,
    deployment,
    resources,
    removed,
    setUnavailable(value: boolean) { unavailable = value; },
  };
}

test('successfully removes only registered deployment containers and networks', async () => {
  const f = fixture();
  const result = await f.cleanup.cleanup(environmentId, ownerId);
  assert.equal(result.status, 'REMOVED');
  assert.equal(result.removedContainers, 1);
  assert.equal(result.removedNetworks, 1);
  assert.deepEqual(f.removed, [`container:${containerId}`, `network:${networkId}`]);
  assert.equal(f.deployment.deploymentStatus, 'REMOVED');
  assert.deepEqual(f.deployment.deploymentContainerIds, [containerId]);
  assert.deepEqual(f.deployment.deploymentRemovedContainerIds, [containerId]);
});

test('cleanup succeeds when registered containers and networks are already absent', async () => {
  const f = fixture({ resources: [] });
  const result = await f.cleanup.cleanup(environmentId, ownerId);
  assert.equal(result.status, 'REMOVED');
  assert.equal(result.removedContainers + result.removedNetworks, 0);
});

test('repeated cleanup is idempotent', async () => {
  const f = fixture();
  await f.cleanup.cleanup(environmentId, ownerId);
  const second = await f.cleanup.cleanup(environmentId, ownerId);
  assert.equal(second.status, 'REMOVED');
  assert.equal(f.removed.length, 2);
});

test('partial cleanup failure retains IDs and a retry completes safely', async () => {
  const f = fixture({ failRemove: 'network' });
  await assert.rejects(f.cleanup.cleanup(environmentId, ownerId), { code: 'DEPLOYMENT_CLEANUP_FAILED' });
  assert.equal(f.deployment.deploymentStatus, 'CLEANUP_FAILED');
  assert.deepEqual(f.deployment.deploymentContainerIds, [containerId]);
  const retry = await f.cleanup.cleanup(environmentId, ownerId);
  assert.equal(retry.status, 'REMOVED');
  assert.deepEqual(f.removed, [`container:${containerId}`, `network:${networkId}`]);
});

test('cross-user cleanup is hidden and performs no Docker calls', async () => {
  const f = fixture();
  await assert.rejects(f.cleanup.cleanup(environmentId, otherUserId), { statusCode: 404 });
  assert.equal(f.deployment.deploymentStatus, 'RUNNING');
  assert.equal(f.removed.length, 0);
});

test('resources with missing DockerPilot labels are rejected', async () => {
  const f = fixture({ resources: [{ type: 'container', id: containerId, labels: {}, attachedContainerIds: [] }] });
  await assert.rejects(f.cleanup.cleanup(environmentId, ownerId), { code: 'DEPLOYMENT_OWNERSHIP_CONFLICT' });
  assert.equal(f.deployment.deploymentStatus, 'CLEANUP_FAILED');
  assert.equal(f.removed.length, 0);
});

test('conflicting project or environment labels are rejected', async () => {
  const f = fixture({ resources: [{
    type: 'container', id: containerId,
    labels: expectedLabels({ 'com.dockerpilot.project-id': otherUserId }), attachedContainerIds: [],
  }] });
  await assert.rejects(f.cleanup.cleanup(environmentId, ownerId), { code: 'DEPLOYMENT_OWNERSHIP_CONFLICT' });
  assert.equal(f.removed.length, 0);
});

test('unexpected container identifiers are rejected even with matching labels', async () => {
  const f = fixture({ resources: [{
    type: 'container', id: unexpectedContainerId, labels: expectedLabels(), attachedContainerIds: [],
  }] });
  await assert.rejects(f.cleanup.cleanup(environmentId, ownerId), { code: 'DEPLOYMENT_OWNERSHIP_CONFLICT' });
  assert.equal(f.removed.length, 0);
});

test('unregistered network identifiers are rejected even with matching labels', async () => {
  const f = fixture({ resources: [{
    type: 'network', id: unexpectedContainerId,
    labels: expectedLabels(), attachedContainerIds: [],
  }] });
  await assert.rejects(f.cleanup.cleanup(environmentId, ownerId), { code: 'DEPLOYMENT_OWNERSHIP_CONFLICT' });
  assert.equal(f.removed.length, 0);
});

test('unrelated containers and networks remain untouched', async () => {
  const unrelated = { type: 'container' as const, id: unexpectedContainerId, labels: { 'com.docker.compose.project': 'another-project' }, attachedContainerIds: [] };
  const f = fixture({ resources: [
    { type: 'container', id: containerId, labels: expectedLabels(), attachedContainerIds: [] },
    { type: 'network', id: networkId, labels: expectedLabels(), attachedContainerIds: [containerId] },
    unrelated,
  ] });
  await f.cleanup.cleanup(environmentId, ownerId);
  assert.ok(f.resources.has(`container:${unexpectedContainerId}`));
  assert.deepEqual(f.removed, [`container:${containerId}`, `network:${networkId}`]);
});

test('Docker daemon failures leave a retryable CLEANUP_FAILED state', async () => {
  const f = fixture({ unavailable: true });
  await assert.rejects(f.cleanup.cleanup(environmentId, ownerId), { statusCode: 503 });
  assert.equal(f.deployment.deploymentStatus, 'CLEANUP_FAILED');
  f.setUnavailable(false);
  assert.equal((await f.cleanup.cleanup(environmentId, ownerId)).status, 'REMOVED');
});

test('shared networks are rejected before any container is removed', async () => {
  const f = fixture({ resources: [
    { type: 'container', id: containerId, labels: expectedLabels(), attachedContainerIds: [], running: true },
    { type: 'network', id: networkId, labels: expectedLabels(), attachedContainerIds: [containerId, unexpectedContainerId] },
  ] });
  await assert.rejects(f.cleanup.cleanup(environmentId, ownerId), { code: 'DEPLOYMENT_SHARED_RESOURCE' });
  assert.equal(f.removed.length, 0);
});

test('unauthenticated cleanup endpoint is rejected by auth middleware', async (context) => {
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/compose/${environmentId}/deployment`, { method: 'DELETE' });
  assert.equal(response.status, 401);
  for (const action of ['start', 'stop', 'restart']) {
    const lifecycle = await fetch(`http://127.0.0.1:${address.port}/api/compose/${environmentId}/deployment/${action}`, { method: 'POST' });
    assert.equal(lifecycle.status, 401);
  }
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/compose/${environmentId}/monitoring`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/compose/${environmentId}/containers/${'a'.repeat(64)}/logs`)).status, 401);
});

test('project deletion is refused when a registered deployment is not REMOVED', async () => {
  const projectDelegate = prisma.project as unknown as { findFirst: (...args: unknown[]) => Promise<unknown> };
  const environmentDelegate = prisma.composeEnvironment as unknown as { findMany: (...args: unknown[]) => Promise<unknown> };
  const originalProjectFindFirst = projectDelegate.findFirst;
  const originalEnvironmentFindMany = environmentDelegate.findMany;
  projectDelegate.findFirst = async () => ({ id: projectId });
  environmentDelegate.findMany = async () => [{ id: environmentId, deploymentStatus: 'RUNNING' }];
  try {
    await assert.rejects(projectService.remove(projectId, ownerId), { code: 'DEPLOYMENT_RESOURCES_REGISTERED' });
  } finally {
    projectDelegate.findFirst = originalProjectFindFirst;
    environmentDelegate.findMany = originalEnvironmentFindMany;
  }
});

test('environment deletion is allowed after ownership verification confirms no resources remain', async () => {
  const delegate = prisma.composeEnvironment as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalFindFirst = delegate.findFirst;
  const originalDeleteMany = delegate.deleteMany;
  const originalVerify = composeDeploymentOwnershipService.verify;
  let deleteCalled = false;
  delegate.findFirst = async () => ({
    id: environmentId,
    projectId,
    name: 'removed deployment',
    composeYaml: 'services: {}',
    validationStatus: 'VALID',
    deploymentStatus: 'REMOVED',
    deploymentProjectName: composeProjectName,
    deploymentContainerIds: [containerId],
    deploymentNetworkIds: [networkId],
    deploymentStartedAt: new Date(),
    deploymentCompletedAt: new Date(),
    lastDeploymentError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: { id: projectId, userId: ownerId },
  });
  delegate.deleteMany = async () => { deleteCalled = true; return { count: 1 }; };
  composeDeploymentOwnershipService.verify = async () => ({
    deployment: record({ deploymentStatus: 'REMOVED' }),
    identity: identity(),
    resources: [],
  });
  try {
    await composeEnvironmentService.remove(environmentId, ownerId);
    assert.equal(deleteCalled, true);
  } finally {
    delegate.findFirst = originalFindFirst;
    delegate.deleteMany = originalDeleteMany;
    composeDeploymentOwnershipService.verify = originalVerify;
  }
});

test('environment deletion is blocked while registered deployment resources remain', async () => {
  const delegate = prisma.composeEnvironment as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalFindFirst = delegate.findFirst;
  const originalVerify = composeDeploymentOwnershipService.verify;
  delegate.findFirst = async () => ({
    id: environmentId, projectId, name: 'active deployment', composeYaml: 'services: {}',
    validationStatus: 'VALID', deploymentStatus: 'RUNNING', deploymentProjectName: composeProjectName,
    deploymentContainerIds: [containerId], deploymentNetworkIds: [networkId],
    deploymentStartedAt: new Date(), deploymentCompletedAt: null, lastDeploymentError: null,
    createdAt: new Date(), updatedAt: new Date(), project: { id: projectId, userId: ownerId },
  });
  composeDeploymentOwnershipService.verify = async () => ({
    deployment: record(), identity: identity(),
    resources: [{ type: 'container', id: containerId, labels: expectedLabels(), attachedContainerIds: [] }],
  });
  try {
    await assert.rejects(composeEnvironmentService.remove(environmentId, ownerId), { code: 'DEPLOYMENT_RESOURCES_REGISTERED' });
  } finally {
    delegate.findFirst = originalFindFirst;
    composeDeploymentOwnershipService.verify = originalVerify;
  }
});

test('project deletion is allowed after every deployment is verified REMOVED', async () => {
  const projectDelegate = prisma.project as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const environmentDelegate = prisma.composeEnvironment as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalProjectFindFirst = projectDelegate.findFirst;
  const originalProjectDeleteMany = projectDelegate.deleteMany;
  const originalEnvironmentFindMany = environmentDelegate.findMany;
  const originalVerify = composeDeploymentOwnershipService.verify;
  let deleteCalled = false;
  projectDelegate.findFirst = async () => ({ id: projectId });
  projectDelegate.deleteMany = async () => { deleteCalled = true; return { count: 1 }; };
  environmentDelegate.findMany = async () => [{ id: environmentId, deploymentStatus: 'REMOVED' }];
  composeDeploymentOwnershipService.verify = async () => ({
    deployment: record({ deploymentStatus: 'REMOVED' }),
    identity: identity(),
    resources: [],
  });
  try {
    await projectService.remove(projectId, ownerId);
    assert.equal(deleteCalled, true);
  } finally {
    projectDelegate.findFirst = originalProjectFindFirst;
    projectDelegate.deleteMany = originalProjectDeleteMany;
    environmentDelegate.findMany = originalEnvironmentFindMany;
    composeDeploymentOwnershipService.verify = originalVerify;
  }
});
