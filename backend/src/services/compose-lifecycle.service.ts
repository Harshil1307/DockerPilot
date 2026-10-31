import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import { dockerService, type ContainerControlAction } from './docker.service.js';
import { composeDeploymentOwnershipService } from './compose-ownership.service.js';

export type ComposeLifecycleAction = ContainerControlAction;

const inFlight = new Set<string>();

function expectedState(action: ComposeLifecycleAction): 'RUNNING' | 'STOPPED' {
  return action === 'stop' ? 'STOPPED' : 'RUNNING';
}

function failureSummary(error: unknown): string {
  if (error instanceof AppError || error instanceof DockerUnavailableError) return error.message.slice(0, 500);
  return 'The deployment operation did not complete. Check Docker Desktop and retry.';
}

export const composeLifecycleService = {
  async operate(environmentId: string, userId: string, action: ComposeLifecycleAction) {
    if (inFlight.has(environmentId)) {
      throw new AppError('A deployment operation is already in progress.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');
    }
    inFlight.add(environmentId);
    let claimed = false;
    try {
      const current = await composeDeploymentOwnershipService.authorize(environmentId, userId);
      const currentStatus = current.deployment.deploymentStatus;
      const allowed = action === 'start' ? ['STOPPED'] : ['RUNNING'];
      if (!allowed.includes(currentStatus)) {
        throw new AppError(`Cannot ${action} a deployment in the ${currentStatus.toLowerCase()} state.`, 409, 'DEPLOYMENT_STATE_CONFLICT');
      }
      if (current.deployment.deploymentContainerIds.length === 0) {
        throw new AppError('This deployment has no registered containers to operate.', 409, 'DEPLOYMENT_RESOURCES_REMAIN');
      }

      const claim = await prisma.composeEnvironment.updateMany({
        where: {
          id: environmentId,
          project: { is: { userId } },
          deploymentStatus: currentStatus,
          deploymentProjectName: current.identity.composeProjectName,
        },
        data: { deploymentStatus: 'DEPLOYING' },
      });
      if (claim.count !== 1) {
        throw new AppError('A deployment operation is already in progress.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');
      }
      claimed = true;

      const verified = await composeDeploymentOwnershipService.verify(environmentId, userId);
      const containers = verified.resources.filter((resource) => resource.type === 'container');
      const registeredIds = new Set(verified.deployment.deploymentContainerIds);
      if (containers.length !== registeredIds.size || containers.some((resource) => !registeredIds.has(resource.id))) {
        throw new AppError('Registered deployment containers are missing or changed. Use cleanup or review the deployment.', 409, 'DEPLOYMENT_OWNERSHIP_CONFLICT');
      }
      const expectedRunning = action !== 'start';
      if (containers.some((resource) => Boolean(resource.running) !== expectedRunning)) {
        throw new AppError(`The deployment containers are not all in the expected state for ${action}. Refresh status and retry.`, 409, 'DEPLOYMENT_STATE_CONFLICT');
      }

      for (const id of verified.deployment.deploymentContainerIds) {
        await dockerService.controlContainer(id, userId, action, async (container) => {
          await composeDeploymentOwnershipService.verifyLifecycleResource(
            container.Id,
            userId,
            container.Config?.Labels ?? {},
            true,
          );
        });
      }

      const deploymentCompletedAt = new Date();
      const updated = await prisma.composeEnvironment.updateMany({
        where: { id: environmentId, project: { is: { userId } }, deploymentStatus: 'DEPLOYING' },
        data: { deploymentStatus: expectedState(action), deploymentCompletedAt, lastDeploymentError: null },
      });
      if (updated.count !== 1) throw new AppError('Deployment state changed before the operation could be confirmed.', 409, 'DEPLOYMENT_STATE_CONFLICT');
      return { environmentId, action, status: expectedState(action), completedAt: deploymentCompletedAt };
    } catch (error) {
      if (claimed) {
        await prisma.composeEnvironment.updateMany({
          where: { id: environmentId, project: { is: { userId } }, deploymentStatus: 'DEPLOYING' },
          data: { deploymentStatus: 'FAILED', deploymentCompletedAt: new Date(), lastDeploymentError: failureSummary(error) },
        });
      }
      throw error;
    } finally {
      inFlight.delete(environmentId);
    }
  },
};
