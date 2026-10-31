import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { listActivity } from '../controllers/activity.controller.js';

export const activityRouter = Router();
activityRouter.use(requireAuth);
activityRouter.get('/', listActivity);
