import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { recordAuthenticatedActivity } from '../middleware/activity-recorder.js';
import { dockerMutationLimiter } from '../middleware/rate-limiters.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../controllers/project.controller.js';

export const projectRouter = Router();

projectRouter.use(requireAuth);
projectRouter.use(recordAuthenticatedActivity);
projectRouter.get('/', listProjects);
projectRouter.post('/', dockerMutationLimiter, createProject);
projectRouter.get('/:id', getProject);
projectRouter.patch('/:id', dockerMutationLimiter, updateProject);
projectRouter.delete('/:id', dockerMutationLimiter, deleteProject);
