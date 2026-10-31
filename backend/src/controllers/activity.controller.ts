import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { activityActionSchema, activityResourceSchema, activityService } from '../services/activity.service.js';

const querySchema = z.object({
  actionType: activityActionSchema.optional(),
  resourceType: activityResourceSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
}).strict();

export const listActivity: RequestHandler = async (request, response) => {
  if (!request.userId) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) throw new AppError('Activity filters are invalid.', 400, 'INVALID_ACTIVITY_FILTER');
  response.status(200).json(await activityService.list({ userId: request.userId, ...parsed.data }));
};
