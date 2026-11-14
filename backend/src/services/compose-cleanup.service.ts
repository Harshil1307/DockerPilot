import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import {
  assertComposeResourceLabels,
  createComposeDeploymentOwnershipVerifier,
  type ComposeDeploymentOwnershipRepository,
  type ComposeDeploymentState,
  type RegisteredComposeDeployment,
} from './compose-ownership.service.js';
import {
  dockerService,
  type ComposeDockerResource,
  type ComposeDockerResourceType,
  type ComposeDeploymentIdentity,
} from './docker.service.js';

export interface ComposeCleanupRepository extends ComposeDeploymentOwnershipRepository {
  claimCleanup(environmentId: string, userId: string): Promise<boolean>;
  updateCleanup(
    environmentId: string,
    userId: string,
    data: {
      deploymentStatus?: 'CLEANING' | 'CLEANUP_FAILED' | 'REMOVED';
      deploymentCompletedAt?: Date;
      deploymentRemovedContainerIds?: string[];
      deploymentRemovedNetworkIds?: string[];
      lastDeploymentError?: string | null;
    },
  ): Promise<void>;
}

export interface ComposeCleanupDocker {
  listComposeDeploymentResources(identity: ComposeDeploymentIdentity, containerIds: string[], networkIds: string[]): Promise<ComposeDockerResource[]>;
  inspectComposeResource(type: ComposeDockerResourceType, id: string, identity?: ComposeDeploymentIdentity): Promise<ComposeDockerResource | null>;
  removeComposeResource(type: ComposeDockerResourceType, id: string, identity?: ComposeDeploymentIdentity): Promise<void>;
}

function cleanupFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DockerUnavailableError) {
    return new AppError(error.message, 503, 'DOCKER_UNAVAILABLE');
  }
  return new AppError('Docker cleanup did not complete. Check Docker Desktop and retry cleanup.', 502, 'DEPLOYMENT_CLEANUP_FAILED');
}

function assertCleanupCanStart(deployment: RegisteredComposeDeployment): void {
  if (deployment.deploymentStatus === 'DEPLOYING' || deployment.deploymentStatus === 'CLEANING') {
    throw new AppError('This deployment is already changing state.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');
  }
  const supportedStates: ComposeDeploymentState[] = ['RUNNING', 'STOPPED', 'FAILED', 'CLEANUP_FAILED', 'REMOVED'];
  if (!supportedStates.includes(deployment.deploymentStatus)) {
    throw new AppError('No registered deployment is available to clean up.', 409, 'DEPLOYMENT_NOT_REGISTERED');
  }
}

export function createComposeCleanupService(
  repository: ComposeCleanupRepository,
  docker: ComposeCleanupDocker,
) {
  const ownership = createComposeDeploymentOwnershipVerifier(repository, docker);
  const inFlight = new Set<string>();

  async function removeIfPresent(
    environmentId: string,
    userId: string,
    type: ComposeDockerResourceType,
    id: string,
    identity: ComposeDeploymentIdentity,
  ): Promise<boolean> {
    // Refresh both the DB registration and Engine view before each destructive call.
    const verified = await ownership.verify(environmentId, userId);
    if (verified.identity.composeProjectName !== identity.composeProjectName) {
      throw new AppError('Deployment ownership changed during cleanup.', 409, 'DEPLOYMENT_OWNERSHIP_CONFLICT');
    }

    const resource = await docker.inspectComposeResource(type, id, identity);
    if (!resource) return false;
    assertComposeResourceLabels(resource, identity, type, id);
    if (type === 'network' && resource.attachedContainerIds.some(
      (attachedId) => !verified.deployment.deploymentContainerIds.includes(attachedId),
    )) {
      throw new AppError('A deployment network is shared with an unregistered container and cannot be removed safely.', 409, 'DEPLOYMENT_SHARED_RESOURCE');
    }

    await docker.removeComposeResource(type, id, identity);
    return true;
  }

  return {
    async cleanup(environmentId: string, userId: string, preserveError = false) {
      if (inFlight.has(environmentId)) {
        throw new AppError('Cleanup is already in progress for this deployment.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');
      }
      inFlight.add(environmentId);

      let claimed = false;
      try {
        const authorized = await ownership.authorize(environmentId, userId);
        assertCleanupCanStart(authorized.deployment);
        claimed = await repository.claimCleanup(environmentId, userId);
        if (!claimed) throw new AppError('This deployment is already changing state.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');

        const verified = await ownership.verify(environmentId, userId);
        const removedContainers = new Set(verified.deployment.deploymentRemovedContainerIds);
        const removedNetworks = new Set(verified.deployment.deploymentRemovedNetworkIds);
        let removedContainerCount = 0;
        let removedNetworkCount = 0;

        // Check network attachment ownership before removing any container, so a shared network
        // cannot leave the deployment half-cleaned merely because the conflict was found late.
        for (const network of verified.resources.filter((resource) => resource.type === 'network')) {
          const current = await docker.inspectComposeResource('network', network.id, verified.identity);
          if (!current) continue;
          assertComposeResourceLabels(current, verified.identity, 'network', network.id);
          if (current.attachedContainerIds.some((id) => !verified.deployment.deploymentContainerIds.includes(id))) {
            throw new AppError('A deployment network is shared with an unregistered container and cannot be removed safely.', 409, 'DEPLOYMENT_SHARED_RESOURCE');
          }
        }

        for (const id of verified.deployment.deploymentContainerIds) {
          if (await removeIfPresent(environmentId, userId, 'container', id, verified.identity)) removedContainerCount += 1;
          removedContainers.add(id);
          await repository.updateCleanup(environmentId, userId, {
            deploymentStatus: 'CLEANING',
            deploymentRemovedContainerIds: [...removedContainers],
          });
        }
        for (const id of verified.deployment.deploymentNetworkIds) {
          if (await removeIfPresent(environmentId, userId, 'network', id, verified.identity)) removedNetworkCount += 1;
          removedNetworks.add(id);
          await repository.updateCleanup(environmentId, userId, {
            deploymentStatus: 'CLEANING',
            deploymentRemovedNetworkIds: [...removedNetworks],
          });
        }

        const remaining = await ownership.verify(environmentId, userId);
        if (remaining.resources.length > 0) {
          throw new AppError('Registered Docker resources remain after cleanup. Retry after checking Docker Desktop.', 502, 'DEPLOYMENT_RESOURCES_REMAIN');
        }

        await repository.updateCleanup(environmentId, userId, {
          deploymentStatus: 'REMOVED',
          deploymentCompletedAt: new Date(),
          deploymentRemovedContainerIds: [...removedContainers],
          deploymentRemovedNetworkIds: [...removedNetworks],
          ...(!preserveError ? { lastDeploymentError: null } : {}),
        });
        return {
          environmentId,
          status: 'REMOVED' as const,
          removedContainers: removedContainerCount,
          removedNetworks: removedNetworkCount,
        };
      } catch (error) {
        if (claimed) {
          const safe = cleanupFailure(error);
          await repository.updateCleanup(environmentId, userId, {
            deploymentStatus: 'CLEANUP_FAILED',
            deploymentCompletedAt: new Date(),
            lastDeploymentError: safe.message.slice(0, 500),
          });
          throw safe;
        }
        throw error;
      } finally {
        inFlight.delete(environmentId);
      }
    },
  };
}

const cleanupRepository: ComposeCleanupRepository = {
  async findDeployment(environmentId) {
    const record = await prisma.composeEnvironment.findUnique({
      where: { id: environmentId },
      include: { project: { select: { id: true, userId: true } } },
    });
    return record as RegisteredComposeDeployment | null;
  },

  async claimCleanup(environmentId, userId) {
    const result = await prisma.composeEnvironment.updateMany({
      where: {
        id: environmentId,
        project: { is: { userId } },
        deploymentProjectName: { not: null },
        deploymentStatus: { in: ['RUNNING', 'STOPPED', 'FAILED', 'CLEANUP_FAILED', 'REMOVED'] },
      },
      data: { deploymentStatus: 'CLEANING' },
    });
    return result.count === 1;
  },

  async updateCleanup(environmentId, userId, data) {
    await prisma.composeEnvironment.updateMany({
      where: { id: environmentId, project: { is: { userId } } },
      data,
    });
  },
};

export const composeCleanupService = createComposeCleanupService(cleanupRepository, dockerService);
