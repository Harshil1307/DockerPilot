import type { RequestHandler } from 'express';
import { prisma } from '../config/prisma.js';
import { activityService, type ActivityAction, type ActivityResource } from '../services/activity.service.js';

interface ActivityDescriptor { actionType: ActivityAction; resourceType: ActivityResource }

export function describeActivity(method: string, route: string): ActivityDescriptor | null {
  if (method === 'POST' && route === '/api/projects/') return { actionType: 'PROJECT_CREATED', resourceType: 'project' };
  if (method === 'PATCH' && route === '/api/projects/:id') return { actionType: 'PROJECT_UPDATED', resourceType: 'project' };
  if (method === 'DELETE' && route === '/api/projects/:id') return { actionType: 'PROJECT_DELETED', resourceType: 'project' };
  if (method === 'POST' && route.startsWith('/api/projects/') && route.endsWith('/compose/')) return { actionType: 'COMPOSE_ENVIRONMENT_CREATED', resourceType: 'compose_environment' };
  if (method === 'PATCH' && route === '/api/compose/:id') return { actionType: 'COMPOSE_ENVIRONMENT_UPDATED', resourceType: 'compose_environment' };
  if (method === 'DELETE' && route === '/api/compose/:id') return { actionType: 'COMPOSE_ENVIRONMENT_DELETED', resourceType: 'compose_environment' };
  if (method === 'POST' && route === '/api/compose/:id/deploy') return { actionType: 'COMPOSE_DEPLOYMENT_CREATED', resourceType: 'compose_deployment' };
  if (method === 'DELETE' && route === '/api/compose/:id/deployment') return { actionType: 'COMPOSE_DEPLOYMENT_CLEANED', resourceType: 'compose_deployment' };
  const composeAction = method === 'POST' ? /^\/api\/compose\/:id\/deployment\/(start|stop|restart)$/.exec(route)?.[1] : undefined;
  const actionSuffix = composeAction === 'start' ? 'STARTED' : composeAction === 'stop' ? 'STOPPED' : composeAction === 'restart' ? 'RESTARTED' : null;
  if (actionSuffix) return { actionType: `COMPOSE_DEPLOYMENT_${actionSuffix}` as ActivityAction, resourceType: 'compose_deployment' };
  const containerAction = method === 'POST' ? /^\/api\/docker\/containers\/:id\/(start|stop|restart)$/.exec(route)?.[1] : undefined;
  const containerActionSuffix = containerAction === 'start' ? 'STARTED' : containerAction === 'stop' ? 'STOPPED' : containerAction === 'restart' ? 'RESTARTED' : null;
  if (containerActionSuffix) return { actionType: `CONTAINER_${containerActionSuffix}` as ActivityAction, resourceType: 'container' };
  if (method === 'POST' && route === '/api/docker/images/pull') return { actionType: 'IMAGE_PULLED', resourceType: 'image' };
  if (method === 'DELETE' && route === '/api/docker/images/:id') return { actionType: 'IMAGE_REMOVED', resourceType: 'image' };
  if (method === 'POST' && route === '/api/docker/volumes') return { actionType: 'VOLUME_CREATED', resourceType: 'volume' };
  if (method === 'DELETE' && route === '/api/docker/volumes/:name') return { actionType: 'VOLUME_REMOVED', resourceType: 'volume' };
  if (method === 'POST' && route === '/api/docker/networks') return { actionType: 'NETWORK_CREATED', resourceType: 'network' };
  if (method === 'DELETE' && route === '/api/docker/networks/:id') return { actionType: 'NETWORK_REMOVED', resourceType: 'network' };
  return null;
}

function cleanIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return result ? result.slice(0, 255) : null;
}

export const recordAuthenticatedActivity: RequestHandler = (request, response, next) => {
  const userId = request.userId;
  if (!userId || !['POST', 'PATCH', 'DELETE'].includes(request.method)) { next(); return; }

  const recordAfterResponse = () => response.once('finish', () => {
    const routePath = typeof request.route?.path === 'string' ? request.route.path : null;
    if (!routePath) return;
    const route = `${request.baseUrl}${routePath}`;
    const activity = describeActivity(request.method, route);
    if (!activity) return;

    const params = request.params as Record<string, unknown>;
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const resourceId = cleanIdentifier(params.id ?? params.name ?? (activity.resourceType === 'project' ? params.id : null));
    const resourceName = activity.actionType === 'IMAGE_PULLED' ? null : cleanName(response.locals.activityResourceName ?? body.name ?? params.name);
    let projectId = cleanIdentifier(response.locals.activityProjectId ?? params.projectId);
    if (activity.resourceType === 'project' && activity.actionType !== 'PROJECT_CREATED') {
      projectId = activity.actionType === 'PROJECT_DELETED' ? null : resourceId;
    }
    const succeeded = typeof response.locals.activitySuccess === 'boolean'
      ? response.locals.activitySuccess
      : response.statusCode < 400;
    const operation = activity.actionType.toLowerCase().replaceAll('_', ' ');

    void (async () => {
      await activityService.record({
        userId,
        projectId,
        ...activity,
        resourceId,
        resourceName,
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        summary: `${operation} ${succeeded ? 'completed' : 'failed'}.`,
      });
    })();
  });

  const environmentMatch = /^\/api\/compose\/([0-9a-f-]{36})(?:\/|$)/i.exec(request.originalUrl);
  if (environmentMatch) {
    void prisma.composeEnvironment.findFirst({
      where: { id: environmentMatch[1]!, project: { userId } },
      select: { projectId: true, name: true },
    }).then((environment) => {
      if (environment) {
        response.locals.activityProjectId = environment.projectId;
        response.locals.activityResourceName = environment.name;
      }
      recordAfterResponse();
      next();
    }, () => { recordAfterResponse(); next(); });
    return;
  }
  recordAfterResponse();
  next();
};
