import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { composeDeploymentOwnershipService } from './compose-ownership.service.js';
import { githubRepositoryService } from './github-repository.service.js';

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  repositoryUrl?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  repositoryUrl?: string | null;
}

async function connectionFields(url: string) {
  const identity = githubRepositoryService.parseUrl(url);
  try {
    const metadata = await githubRepositoryService.metadata(url);
    return { repositoryOwner: metadata.owner, repositoryName: metadata.name, repositoryDefaultBranch: metadata.defaultBranch, repositoryStatus: 'connected', repositoryError: null, repositoryVerifiedAt: new Date() };
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'GitHub repository could not be verified.';
    return { repositoryOwner: identity.owner, repositoryName: identity.name, repositoryDefaultBranch: null, repositoryStatus: 'error', repositoryError: message.slice(0, 300), repositoryVerifiedAt: new Date() };
  }
}

export const projectService = {
  list(userId: string) {
    return prisma.project.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }).then((projects) => projects);
  },

  async get(id: string, userId: string) {
    const project = await prisma.project.findFirst({ where: { id, userId } });
    if (!project) {
      throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    }
    return project;
  },

  async create(userId: string, input: CreateProjectInput) {
    const connection = input.repositoryUrl ? await connectionFields(input.repositoryUrl) : {};
    return prisma.project.create({ data: { ...input, ...connection, userId } });
  },

  async update(id: string, userId: string, input: UpdateProjectInput) {
    const existing = await prisma.project.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    const updateData: Record<string, unknown> = { ...input };
    if (Object.hasOwn(input, 'repositoryUrl')) {
      if (!input.repositoryUrl) {
        updateData.repositoryOwner = null; updateData.repositoryName = null; updateData.repositoryDefaultBranch = null;
        updateData.repositoryStatus = 'disconnected'; updateData.repositoryError = null; updateData.repositoryVerifiedAt = null;
        githubRepositoryService.clearCache(id);
      } else {
        const changed = input.repositoryUrl !== existing.repositoryUrl;
        updateData.repositoryUrl = input.repositoryUrl;
        if (changed || existing.repositoryStatus !== 'connected') Object.assign(updateData, await connectionFields(input.repositoryUrl));
        githubRepositoryService.clearCache(id);
      }
    }
    const result = await prisma.project.updateMany({ where: { id, userId }, data: updateData });
    if (result.count === 0) {
      throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    }
    githubRepositoryService.clearCache(id);
    const project = await prisma.project.findFirst({ where: { id, userId } });
    if (!project) {
      throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    }
    return project;
  },

  async remove(id: string, userId: string) {
    const project = await prisma.project.findFirst({ where: { id, userId }, select: { id: true } });
    if (!project) throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    const registeredDeployments = await prisma.composeEnvironment.findMany({
      where: {
        projectId: id,
        OR: [
          { deploymentProjectName: { not: null } },
          { deploymentStatus: { in: ['DEPLOYING', 'RUNNING', 'STOPPED', 'CLEANING', 'CLEANUP_FAILED', 'REMOVED'] } },
          { deploymentContainerIds: { isEmpty: false } },
          { deploymentNetworkIds: { isEmpty: false } },
        ],
      },
      select: { id: true, deploymentStatus: true },
    });
    for (const deployment of registeredDeployments) {
      if (deployment.deploymentStatus !== 'REMOVED') {
        throw new AppError('This project cannot be deleted while Compose deployment resources are registered.', 409, 'DEPLOYMENT_RESOURCES_REGISTERED');
      }
      const verified = await composeDeploymentOwnershipService.verify(deployment.id, userId);
      if (verified.resources.length > 0) {
        throw new AppError('This project cannot be deleted while Compose deployment resources remain.', 409, 'DEPLOYMENT_RESOURCES_REMAIN');
      }
    }

    const result = await prisma.project.deleteMany({
      where: {
        id,
        userId,
        composeEnvironments: {
          none: {
            OR: [
              { deploymentStatus: { in: ['DEPLOYING', 'RUNNING', 'STOPPED', 'CLEANING', 'CLEANUP_FAILED'] } },
              { deploymentProjectName: { not: null }, deploymentStatus: { not: 'REMOVED' } },
              { deploymentStatus: 'REMOVED', deploymentProjectName: null },
              { deploymentContainerIds: { isEmpty: false } },
              { deploymentNetworkIds: { isEmpty: false } },
            ],
          },
        },
      },
    });
    if (result.count === 0) {
      const stillExists = await prisma.project.findFirst({ where: { id, userId }, select: { id: true } });
      if (stillExists) {
        throw new AppError('This project cannot be deleted while Compose deployment resources are registered.', 409, 'DEPLOYMENT_RESOURCES_REGISTERED');
      }
      throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    }
  },
};
