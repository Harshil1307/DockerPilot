import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { recordAuthenticatedActivity } from '../middleware/activity-recorder.js';
import { composeOperationLimiter, dockerMutationLimiter, expensiveDockerReadLimiter } from '../middleware/rate-limiters.js';
import {
  createComposeEnvironment,
  deleteComposeEnvironment,
  deleteComposeDeployment,
  deployComposeEnvironment,
  getComposeEnvironment,
  getComposeMonitoring,
  getComposeContainerLogs,
  getComposeDeploymentStatus,
  listComposeEnvironments,
  operateComposeDeployment,
  updateComposeEnvironment,
  validateComposeEnvironment,
} from '../controllers/compose.controller.js';

export const projectComposeRouter = Router({ mergeParams: true });
projectComposeRouter.use(requireAuth);
projectComposeRouter.use(recordAuthenticatedActivity);
projectComposeRouter.post('/', dockerMutationLimiter, createComposeEnvironment);
projectComposeRouter.get('/', listComposeEnvironments);

export const composeEnvironmentRouter = Router();
composeEnvironmentRouter.use(requireAuth);
composeEnvironmentRouter.use(recordAuthenticatedActivity);
composeEnvironmentRouter.get('/:id/deployment', getComposeDeploymentStatus);
composeEnvironmentRouter.get('/:id/monitoring', expensiveDockerReadLimiter, getComposeMonitoring);
composeEnvironmentRouter.get('/:id/containers/:containerId/logs', expensiveDockerReadLimiter, getComposeContainerLogs);
composeEnvironmentRouter.delete('/:id/deployment', composeOperationLimiter, deleteComposeDeployment);
composeEnvironmentRouter.post('/:id/deployment/:action', composeOperationLimiter, operateComposeDeployment);
composeEnvironmentRouter.post('/:id/deploy', composeOperationLimiter, deployComposeEnvironment);
composeEnvironmentRouter.get('/:id', getComposeEnvironment);
composeEnvironmentRouter.patch('/:id', dockerMutationLimiter, updateComposeEnvironment);
composeEnvironmentRouter.delete('/:id', dockerMutationLimiter, deleteComposeEnvironment);
composeEnvironmentRouter.post('/:id/validate', composeOperationLimiter, validateComposeEnvironment);
