import { z } from 'zod';
import { prisma } from '../config/prisma.js';

export const activityActionSchema = z.enum([
  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_DELETED',
  'COMPOSE_ENVIRONMENT_CREATED', 'COMPOSE_ENVIRONMENT_UPDATED', 'COMPOSE_ENVIRONMENT_DELETED',
  'COMPOSE_DEPLOYMENT_CREATED', 'COMPOSE_DEPLOYMENT_STARTED', 'COMPOSE_DEPLOYMENT_STOPPED',
  'COMPOSE_DEPLOYMENT_RESTARTED', 'COMPOSE_DEPLOYMENT_CLEANED',
  'CONTAINER_STARTED', 'CONTAINER_STOPPED', 'CONTAINER_RESTARTED',
  'IMAGE_PULLED', 'IMAGE_REMOVED', 'VOLUME_CREATED', 'VOLUME_REMOVED', 'NETWORK_CREATED', 'NETWORK_REMOVED',
]);
export const activityResourceSchema = z.enum(['project', 'compose_environment', 'compose_deployment', 'container', 'image', 'volume', 'network']);
export type ActivityAction = z.infer<typeof activityActionSchema>;
export type ActivityResource = z.infer<typeof activityResourceSchema>;
export type ActivityStatus = 'SUCCEEDED' | 'FAILED';

export interface ActivityInput {
  userId: string;
  projectId?: string | null;
  actionType: ActivityAction;
  resourceType: ActivityResource;
  resourceId?: string | null;
  resourceName?: string | null;
  status: ActivityStatus;
  summary: string;
}

export interface ActivityRepository {
  create(input: ActivityInput): Promise<unknown>;
  findMany(input: { userId: string; actionType?: ActivityAction; resourceType?: ActivityResource; skip: number; take: number }): Promise<unknown[]>;
}

function redactActivityText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?\b[a-zA-Z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key)[a-zA-Z0-9_.-]*["']?)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');
}

export function createActivityService(repository: ActivityRepository) {
  return {
    async record(input: ActivityInput): Promise<void> {
      const safe = {
        ...input,
        projectId: input.projectId || null,
        resourceId: input.resourceId?.slice(0, 128) ?? null,
        resourceName: input.resourceName ? redactActivityText(input.resourceName.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 255) : null,
        summary: redactActivityText(input.summary.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 500),
      };
      try { await repository.create(safe); } catch { /* History must never mask the result of the Docker operation. */ }
    },

    async list(input: { userId: string; actionType?: ActivityAction; resourceType?: ActivityResource; page: number }) {
      const pageSize = 30;
      const rows = await repository.findMany({
        userId: input.userId,
        ...(input.actionType ? { actionType: input.actionType } : {}),
        ...(input.resourceType ? { resourceType: input.resourceType } : {}),
        skip: (input.page - 1) * pageSize,
        take: pageSize + 1,
      });
      return { activities: rows.slice(0, pageSize), page: input.page, pageSize, hasMore: rows.length > pageSize };
    },
  };
}

const activityRepository: ActivityRepository = {
  async create(input) { return prisma.activity.create({ data: input }); },
  async findMany({ userId, actionType, resourceType, skip, take }) {
    return prisma.activity.findMany({
      where: { userId, ...(actionType ? { actionType } : {}), ...(resourceType ? { resourceType } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take,
      select: { id: true, actionType: true, resourceType: true, resourceId: true, resourceName: true, status: true, summary: true, createdAt: true },
    });
  },
};

export const activityService = createActivityService(activityRepository);
