import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { composeCleanupService } from '../src/services/compose-cleanup.service.js';
import { composeDeploymentService } from '../src/services/compose-deployment.service.js';
import { composeEnvironmentService } from '../src/services/compose-environment.service.js';
import { composeLifecycleService } from '../src/services/compose-lifecycle.service.js';
import { composeMonitoringService } from '../src/services/compose-monitoring.service.js';
import { composeDeploymentOwnershipService, generatedComposeProjectName } from '../src/services/compose-ownership.service.js';
import { dockerService, type ComposeDeploymentIdentity } from '../src/services/docker.service.js';
import { projectService } from '../src/services/project.service.js';

const execFileAsync = promisify(execFile);
const ENABLED = process.env.DOCKERPILOT_RUN_DOCKER_INTEGRATION === '1';
const CLEANUP_MIGRATION = '20261031171500_track_deployment_cleanup_progress';
const TEST_COMPOSE = 'services:\n  web:\n    image: nginx:alpine\n';

test('real Docker Compose deployment lifecycle stays within one uniquely owned project', { skip: !ENABLED, timeout: 12 * 60 * 1000 }, async (context) => {
  const migrationRows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
    SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
  `;
  if (!migrationRows.some((row) => row.migration_name === CLEANUP_MIGRATION)) {
    context.skip(`Database migration ${CLEANUP_MIGRATION} is pending; no Docker resources were created.`);
    return;
  }

  const dockerStatus = await dockerService.getStatus();
  assert.equal(dockerStatus.reachable, true, 'Docker daemon must be reachable before creating the isolated test project.');
  await execFileAsync('docker', ['image', 'inspect', 'nginx:alpine'], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME },
    timeout: 15_000,
    windowsHide: true,
  });

  const suffix = randomUUID();
  const userId = randomUUID();
  let projectId: string | undefined;
  let environmentId: string | undefined;
  let deploymentAttempted = false;
  let cleanupConfirmed = false;
  const email = `dockerpilot-it-${suffix}@example.invalid`;

  try {
    await prisma.user.create({ data: { id: userId, name: 'DockerPilot integration test', email, passwordHash: 'not-used-by-integration-test' } });
    const project = await projectService.create(userId, { name: `DockerPilot integration ${suffix.slice(0, 8)}` });
    projectId = project.id;
    const environment = await composeEnvironmentService.create(project.id, userId, {
      name: `Isolated nginx ${suffix.slice(0, 8)}`,
      composeYaml: TEST_COMPOSE,
    });
    environmentId = environment.id;

    const identity: ComposeDeploymentIdentity = {
      ownerId: userId,
      projectId: project.id,
      environmentId: environment.id,
      composeProjectName: generatedComposeProjectName(environment.id),
    };
    const before = await dockerService.inspectComposeDeployment(identity);
    assert.equal(before.resourceCount, 0, 'Refusing to deploy because the generated unique project name already has Docker resources.');
    context.diagnostic(`Isolated Compose project: ${identity.composeProjectName}; image: nginx:alpine; services: web; ports: none; volumes: none.`);
    assert.equal((await composeEnvironmentService.validate(environment.id, userId)).valid, true);

    deploymentAttempted = true;
    const deployed = await composeDeploymentService.deploy(environment.id, userId);
    assert.equal(deployed.status, 'RUNNING');
    assert.equal((await composeDeploymentService.getStatus(environment.id, userId)).status, 'RUNNING');

    const stopped = await composeLifecycleService.operate(environment.id, userId, 'stop');
    assert.equal(stopped.status, 'STOPPED');
    assert.equal((await composeDeploymentService.getStatus(environment.id, userId)).status, 'STOPPED');
    assert.equal((await composeLifecycleService.operate(environment.id, userId, 'start')).status, 'RUNNING');
    assert.equal((await composeLifecycleService.operate(environment.id, userId, 'restart')).status, 'RUNNING');

    const inventory = await composeMonitoringService.getInventory(environment.id, userId);
    assert.equal(inventory.containers.length, 1);
    assert.equal(inventory.containers[0]?.serviceName, 'web');
    assert.ok(inventory.containers[0]?.id);
    const recentLogs = await composeMonitoringService.getRecentLogs(environment.id, userId, inventory.containers[0]!.id);
    assert.ok(recentLogs.lines.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(recentLogs.lines), 'utf8') < 70 * 1024);

    const registered = await composeDeploymentOwnershipService.verify(environment.id, userId);
    context.diagnostic(`Registered test resources: containers [${registered.deployment.deploymentContainerIds.join(', ')}]; networks [${registered.deployment.deploymentNetworkIds.join(', ')}].`);
    assert.deepEqual(
      registered.resources.filter((resource) => resource.type === 'container').map((resource) => resource.id),
      registered.deployment.deploymentContainerIds,
    );
    const result = await composeCleanupService.cleanup(environment.id, userId);
    assert.equal(result.status, 'REMOVED');
    const repeatedCleanup = await composeCleanupService.cleanup(environment.id, userId);
    assert.equal(repeatedCleanup.status, 'REMOVED');
    assert.equal(repeatedCleanup.removedContainers, 0);
    assert.equal(repeatedCleanup.removedNetworks, 0);
    cleanupConfirmed = true;
    const after = await composeDeploymentOwnershipService.verify(environment.id, userId);
    assert.equal(after.resources.length, 0);
    for (const id of registered.deployment.deploymentContainerIds) {
      assert.equal(await dockerService.inspectComposeResource('container', id), null);
    }
    for (const id of registered.deployment.deploymentNetworkIds) {
      assert.equal(await dockerService.inspectComposeResource('network', id), null);
    }
  } finally {
    if (projectId && userId) {
      if (environmentId && deploymentAttempted && !cleanupConfirmed) {
        const identity: ComposeDeploymentIdentity = {
          ownerId: userId,
          projectId,
          environmentId,
          composeProjectName: generatedComposeProjectName(environmentId),
        };
        const persisted = await prisma.composeEnvironment.findUnique({ where: { id: environmentId } });
        if (persisted?.deploymentProjectName) {
          // Never attempt cleanup unless the persisted IDs and Docker labels still pass the shared verifier.
          const verified = await composeDeploymentOwnershipService.verify(environmentId, userId);
          assert.ok(verified.resources.every((resource) =>
            (resource.type === 'container' ? verified.deployment.deploymentContainerIds : verified.deployment.deploymentNetworkIds).includes(resource.id)));
          await composeCleanupService.cleanup(environmentId, userId);
          const afterCleanup = await composeDeploymentOwnershipService.verify(environmentId, userId);
          assert.equal(afterCleanup.resources.length, 0);
        } else {
          const unregistered = await dockerService.inspectComposeDeployment(identity);
          assert.equal(unregistered.resourceCount, 0, 'Unregistered Docker resources were found; refusing to remove them.');
        }
      }
      if (environmentId) await composeEnvironmentService.remove(environmentId, userId);
      await projectService.remove(projectId, userId);
      await prisma.user.delete({ where: { id: userId } });
    }
  }
});
