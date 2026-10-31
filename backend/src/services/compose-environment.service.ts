import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { projectService } from './project.service.js';
import { findComposeSecretFields, validateComposeYaml } from './compose-validation.service.js';
import { composeDeploymentOwnershipService } from './compose-ownership.service.js';

export const MAX_COMPOSE_YAML_BYTES = 64 * 1024;

export interface ComposeEnvironmentInput {
  name: string;
  composeYaml: string;
}

function assertYamlSize(composeYaml: string): void {
  if (Buffer.byteLength(composeYaml, 'utf8') > MAX_COMPOSE_YAML_BYTES) {
    throw new AppError('Compose YAML must be 64 KB or smaller.', 413, 'COMPOSE_YAML_TOO_LARGE');
  }
}

function assertNoSecretFields(composeYaml: string): void {
  if (findComposeSecretFields(composeYaml).length > 0) {
    throw new AppError('Credential and secret fields cannot be stored in Compose YAML.', 400, 'COMPOSE_SECRETS_NOT_SUPPORTED');
  }
}

function toSummary(environment: {
  id: string;
  name: string;
  composeYaml: string;
  validationStatus: 'NOT_VALIDATED' | 'VALID' | 'INVALID';
  deploymentStatus: 'NOT_DEPLOYED' | 'DEPLOYING' | 'RUNNING' | 'FAILED' | 'STOPPED' | 'CLEANING' | 'CLEANUP_FAILED' | 'REMOVED';
  deploymentProjectName: string | null;
  deploymentStartedAt: Date | null;
  deploymentCompletedAt: Date | null;
  lastDeploymentError: string | null;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: environment.id,
    name: environment.name,
    validationStatus: environment.validationStatus,
    deploymentStatus: environment.deploymentStatus,
    deploymentProjectName: environment.deploymentStatus === 'REMOVED' ? null : environment.deploymentProjectName,
    deploymentStartedAt: environment.deploymentStartedAt,
    deploymentCompletedAt: environment.deploymentCompletedAt,
    lastDeploymentError: environment.lastDeploymentError,
    projectId: environment.projectId,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
    servicesCount: validateComposeYaml(environment.composeYaml).servicesCount,
  };
}

async function findOwnedEnvironment(environmentId: string, userId: string) {
  const environment = await prisma.composeEnvironment.findFirst({
    where: { id: environmentId, project: { is: { userId } } },
  });
  if (!environment) throw new AppError('Compose environment not found.', 404, 'COMPOSE_ENVIRONMENT_NOT_FOUND');
  return environment;
}

export const composeEnvironmentService = {
  async create(projectId: string, userId: string, input: ComposeEnvironmentInput) {
    assertYamlSize(input.composeYaml);
    assertNoSecretFields(input.composeYaml);
    await projectService.get(projectId, userId);
    const environment = await prisma.composeEnvironment.create({ data: { ...input, projectId } });
    return toSummary(environment);
  },

  async list(projectId: string, userId: string) {
    await projectService.get(projectId, userId);
    const environments = await prisma.composeEnvironment.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    });
    return environments.map(toSummary);
  },

  async get(environmentId: string, userId: string) {
    const environment = await findOwnedEnvironment(environmentId, userId);
    return { ...toSummary(environment), composeYaml: environment.composeYaml };
  },

  async update(environmentId: string, userId: string, input: ComposeEnvironmentInput) {
    assertYamlSize(input.composeYaml);
    assertNoSecretFields(input.composeYaml);
    const current = await findOwnedEnvironment(environmentId, userId);
    if (current.deploymentStatus === 'DEPLOYING' || current.deploymentStatus === 'CLEANING') {
      throw new AppError('This environment cannot be edited while a deployment operation is in progress.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');
    }
    const result = await prisma.composeEnvironment.updateMany({
      where: { id: environmentId, project: { is: { userId } }, deploymentStatus: { notIn: ['DEPLOYING', 'CLEANING'] } },
      data: { ...input, validationStatus: 'NOT_VALIDATED' },
    });
    if (result.count === 0) throw new AppError('Compose environment not found.', 404, 'COMPOSE_ENVIRONMENT_NOT_FOUND');
    const environment = await findOwnedEnvironment(environmentId, userId);
    return toSummary(environment);
  },

  async remove(environmentId: string, userId: string) {
    const current = await findOwnedEnvironment(environmentId, userId);
    if (current.deploymentStatus === 'DEPLOYING' || current.deploymentStatus === 'CLEANING') {
      throw new AppError('This environment cannot be deleted while deployment cleanup is in progress.', 409, 'DEPLOYMENT_OPERATION_IN_PROGRESS');
    }
    if (current.deploymentProjectName !== null) {
      if (current.deploymentStatus !== 'REMOVED') {
        throw new AppError('This environment cannot be deleted while its deployment resources are registered.', 409, 'DEPLOYMENT_RESOURCES_REGISTERED');
      }
      const verified = await composeDeploymentOwnershipService.verify(environmentId, userId);
      if (verified.resources.length > 0) {
        throw new AppError('This deployment still has Docker resources and must be cleaned up before deletion.', 409, 'DEPLOYMENT_RESOURCES_REMAIN');
      }
    }
    if (current.deploymentProjectName === null && (
      ['RUNNING', 'STOPPED', 'CLEANUP_FAILED', 'REMOVED'].includes(current.deploymentStatus)
      || current.deploymentContainerIds.length > 0
      || current.deploymentNetworkIds.length > 0
    )) {
      throw new AppError('Deployment registration is incomplete; this environment cannot be deleted safely.', 409, 'DEPLOYMENT_OWNERSHIP_CONFLICT');
    }
    const result = await prisma.composeEnvironment.deleteMany({
      where: {
        id: environmentId,
        project: { is: { userId } },
        OR: [
          {
            deploymentProjectName: null,
            deploymentContainerIds: { isEmpty: true },
            deploymentNetworkIds: { isEmpty: true },
            deploymentStatus: { notIn: ['DEPLOYING', 'RUNNING', 'STOPPED', 'CLEANING', 'CLEANUP_FAILED', 'REMOVED'] },
          },
          { deploymentProjectName: { not: null }, deploymentStatus: 'REMOVED' },
        ],
      },
    });
    if (result.count === 0) {
      const latest = await prisma.composeEnvironment.findFirst({
        where: { id: environmentId, project: { is: { userId } } },
        select: {
          deploymentStatus: true,
          deploymentProjectName: true,
          deploymentContainerIds: true,
          deploymentNetworkIds: true,
        },
      });
      if (!latest) throw new AppError('Compose environment not found.', 404, 'COMPOSE_ENVIRONMENT_NOT_FOUND');
      if (latest.deploymentStatus === 'DEPLOYING'
        || latest.deploymentStatus === 'RUNNING'
        || latest.deploymentStatus === 'STOPPED'
        || latest.deploymentStatus === 'CLEANING'
        || latest.deploymentStatus === 'CLEANUP_FAILED'
        || latest.deploymentStatus === 'REMOVED'
        || latest.deploymentContainerIds.length > 0
        || latest.deploymentNetworkIds.length > 0
        || latest.deploymentProjectName !== null) {
        throw new AppError('This environment cannot be deleted while its deployment resources are registered.', 409, 'DEPLOYMENT_RESOURCES_REGISTERED');
      }
    }
  },

  async validate(environmentId: string, userId: string) {
    const environment = await findOwnedEnvironment(environmentId, userId);
    assertYamlSize(environment.composeYaml);
    const result = validateComposeYaml(environment.composeYaml);
    const validationStatus = result.valid ? 'VALID' : 'INVALID';
    await prisma.composeEnvironment.updateMany({
      where: { id: environmentId, project: { is: { userId } } },
      data: { validationStatus },
    });
    return { ...result, validationStatus };
  },
};
