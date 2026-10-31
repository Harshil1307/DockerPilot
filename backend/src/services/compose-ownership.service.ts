import { AppError } from '../errors/app-error.js';
import { prisma } from '../config/prisma.js';
import {
  dockerService,
  type ComposeDockerResource,
  type ComposeDockerResourceType,
  type ComposeDeploymentIdentity,
} from './docker.service.js';

export type ComposeDeploymentState =
  | 'NOT_DEPLOYED'
  | 'DEPLOYING'
  | 'RUNNING'
  | 'FAILED'
  | 'STOPPED'
  | 'CLEANING'
  | 'CLEANUP_FAILED'
  | 'REMOVED';

export interface RegisteredComposeDeployment {
  id: string;
  projectId: string;
  deploymentStatus: ComposeDeploymentState;
  deploymentProjectName: string | null;
  deploymentCompletedAt: Date | null;
  lastDeploymentError: string | null;
  deploymentContainerIds: string[];
  deploymentNetworkIds: string[];
  deploymentRemovedContainerIds: string[];
  deploymentRemovedNetworkIds: string[];
  project: { id: string; userId: string };
}

export interface ComposeDeploymentOwnershipRepository {
  findDeployment(environmentId: string): Promise<RegisteredComposeDeployment | null>;
}

export interface ComposeDeploymentResourceReader {
  listComposeDeploymentResources(
    identity: ComposeDeploymentIdentity,
    registeredContainerIds: string[],
    registeredNetworkIds: string[],
  ): Promise<ComposeDockerResource[]>;
}

export interface VerifiedComposeDeployment {
  deployment: RegisteredComposeDeployment;
  identity: ComposeDeploymentIdentity;
  resources: ComposeDockerResource[];
}

const MANAGED_LABEL = 'com.dockerpilot.managed';
const OWNER_LABEL = 'com.dockerpilot.owner-id';
const PROJECT_ID_LABEL = 'com.dockerpilot.project-id';
const ENVIRONMENT_ID_LABEL = 'com.dockerpilot.environment-id';
const EXPECTED_DOCKERPILOT_LABELS = new Set([MANAGED_LABEL, OWNER_LABEL, PROJECT_ID_LABEL, ENVIRONMENT_ID_LABEL]);
const RESOURCE_ID = /^[a-f\d]{64}$/i;

export function generatedComposeProjectName(environmentId: string): string {
  return `dp-${environmentId.replaceAll('-', '').toLowerCase()}`;
}

function ownershipConflict(message = 'Docker resources do not match the registered deployment ownership record.'): AppError {
  return new AppError(message, 409, 'DEPLOYMENT_OWNERSHIP_CONFLICT');
}

function deploymentIdentity(deployment: RegisteredComposeDeployment, userId: string): ComposeDeploymentIdentity {
  if (deployment.project.userId !== userId || deployment.project.id !== deployment.projectId) {
    throw new AppError('Compose environment not found.', 404, 'COMPOSE_ENVIRONMENT_NOT_FOUND');
  }
  if (deployment.deploymentStatus === 'NOT_DEPLOYED' || !deployment.deploymentProjectName) {
    throw new AppError('No registered Docker deployment exists for this environment.', 409, 'DEPLOYMENT_NOT_REGISTERED');
  }
  const expectedProjectName = generatedComposeProjectName(deployment.id);
  if (deployment.deploymentProjectName !== expectedProjectName) throw ownershipConflict();
  if (!Array.isArray(deployment.deploymentContainerIds)
    || !Array.isArray(deployment.deploymentNetworkIds)
    || !Array.isArray(deployment.deploymentRemovedContainerIds)
    || !Array.isArray(deployment.deploymentRemovedNetworkIds)) {
    throw ownershipConflict();
  }

  const registeredIds = [...deployment.deploymentContainerIds, ...deployment.deploymentNetworkIds];
  const removedIds = [...deployment.deploymentRemovedContainerIds, ...deployment.deploymentRemovedNetworkIds];
  if ([...registeredIds, ...removedIds].some((id) => !RESOURCE_ID.test(id))
    || new Set(registeredIds).size !== registeredIds.length
    || new Set(deployment.deploymentRemovedContainerIds).size !== deployment.deploymentRemovedContainerIds.length
    || new Set(deployment.deploymentRemovedNetworkIds).size !== deployment.deploymentRemovedNetworkIds.length) {
    throw ownershipConflict();
  }
  if (deployment.deploymentRemovedContainerIds.some((id) => !deployment.deploymentContainerIds.includes(id))
    || deployment.deploymentRemovedNetworkIds.some((id) => !deployment.deploymentNetworkIds.includes(id))) {
    throw ownershipConflict();
  }

  return {
    ownerId: userId,
    projectId: deployment.projectId,
    environmentId: deployment.id,
    composeProjectName: expectedProjectName,
  };
}

function labelsMatch(resource: ComposeDockerResource, identity: ComposeDeploymentIdentity): boolean {
  const labels = resource.labels;
  return labels[MANAGED_LABEL] === 'true'
    && labels[OWNER_LABEL] === identity.ownerId
    && labels[PROJECT_ID_LABEL] === identity.projectId
    && labels[ENVIRONMENT_ID_LABEL] === identity.environmentId
    && labels['com.docker.compose.project'] === identity.composeProjectName
    && Object.keys(labels).every((label) => !label.startsWith('com.dockerpilot.') || EXPECTED_DOCKERPILOT_LABELS.has(label));
}

export function verifyComposeResourceSet(
  deployment: RegisteredComposeDeployment,
  identity: ComposeDeploymentIdentity,
  resources: ComposeDockerResource[],
): ComposeDockerResource[] {
  const containerIds = new Set(deployment.deploymentContainerIds);
  const networkIds = new Set(deployment.deploymentNetworkIds);
  const seenIds = new Set<string>();

  for (const resource of resources) {
    const expectedIds = resource.type === 'container' ? containerIds : networkIds;
    if (!RESOURCE_ID.test(resource.id) || !expectedIds.has(resource.id) || seenIds.has(resource.id)) {
      throw ownershipConflict('Docker Engine reported a resource identifier that is not registered to this deployment.');
    }
    if (!labelsMatch(resource, identity)) throw ownershipConflict();
    seenIds.add(resource.id);

    if (resource.type === 'network' && resource.attachedContainerIds.some((id) => !containerIds.has(id))) {
      throw new AppError('A deployment network is shared with an unregistered container and cannot be removed safely.', 409, 'DEPLOYMENT_SHARED_RESOURCE');
    }
  }

  return resources;
}

export function createComposeDeploymentOwnershipVerifier(
  repository: ComposeDeploymentOwnershipRepository,
  docker: ComposeDeploymentResourceReader,
) {
  return {
    async verify(environmentId: string, userId: string): Promise<VerifiedComposeDeployment> {
      const deployment = await repository.findDeployment(environmentId);
      if (!deployment) throw new AppError('Compose environment not found.', 404, 'COMPOSE_ENVIRONMENT_NOT_FOUND');
      const identity = deploymentIdentity(deployment, userId);
      const resources = await docker.listComposeDeploymentResources(
        identity,
        deployment.deploymentContainerIds,
        deployment.deploymentNetworkIds,
      );
      verifyComposeResourceSet(deployment, identity, resources);
      return { deployment, identity, resources };
    },

    async authorize(environmentId: string, userId: string): Promise<{ deployment: RegisteredComposeDeployment; identity: ComposeDeploymentIdentity }> {
      const deployment = await repository.findDeployment(environmentId);
      if (!deployment) throw new AppError('Compose environment not found.', 404, 'COMPOSE_ENVIRONMENT_NOT_FOUND');
      const identity = deploymentIdentity(deployment, userId);
      return { deployment, identity };
    },

    async verifyLifecycleResource(containerId: string, userId: string, labels: Record<string, string>, allowLifecycleClaim = false): Promise<void> {
      const deploymentMarkers = ['com.docker.compose.project', PROJECT_ID_LABEL, ENVIRONMENT_ID_LABEL];
      if (!deploymentMarkers.some((label) => Object.hasOwn(labels, label))) return;
      const environmentId = labels[ENVIRONMENT_ID_LABEL];
      if (!environmentId) throw ownershipConflict();
      const verified = await this.verify(environmentId, userId);
      if (!['RUNNING', 'STOPPED'].includes(verified.deployment.deploymentStatus)
        && !(allowLifecycleClaim && verified.deployment.deploymentStatus === 'DEPLOYING')) {
        throw new AppError('This deployment is not available for container lifecycle operations.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');
      }
      if (!verified.deployment.deploymentContainerIds.includes(containerId)) {
        throw ownershipConflict('This container is not registered to the authenticated user’s Compose deployment.');
      }
    },
  };
}

export function assertComposeResourceLabels(
  resource: ComposeDockerResource,
  identity: ComposeDeploymentIdentity,
  expectedType: ComposeDockerResourceType,
  expectedId: string,
): void {
  if (resource.type !== expectedType || resource.id !== expectedId || !labelsMatch(resource, identity)) {
    throw ownershipConflict('The Docker resource changed ownership metadata before cleanup.');
  }
}

const ownershipRepository: ComposeDeploymentOwnershipRepository = {
  async findDeployment(environmentId) {
    const record = await prisma.composeEnvironment.findUnique({
      where: { id: environmentId },
      include: { project: { select: { id: true, userId: true } } },
    });
    return record as RegisteredComposeDeployment | null;
  },
};

export const composeDeploymentOwnershipService = createComposeDeploymentOwnershipVerifier(ownershipRepository, dockerService);
