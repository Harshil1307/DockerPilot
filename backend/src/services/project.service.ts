import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { composeDeploymentOwnershipService } from './compose-ownership.service.js';

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

export const projectService = {
  list(userId: string) {
    return prisma.project.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  },

  async get(id: string, userId: string) {
    const project = await prisma.project.findFirst({ where: { id, userId } });
    if (!project) {
      throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    }
    return project;
  },

  create(userId: string, input: CreateProjectInput) {
    return prisma.project.create({ data: { ...input, userId } });
  },

  async update(id: string, userId: string, input: UpdateProjectInput) {
    const result = await prisma.project.updateMany({ where: { id, userId }, data: input });
    if (result.count === 0) {
      throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
    }
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
