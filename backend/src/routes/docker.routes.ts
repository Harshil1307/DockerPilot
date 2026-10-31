import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { recordAuthenticatedActivity } from '../middleware/activity-recorder.js';
import { dockerMutationLimiter, expensiveDockerReadLimiter, imagePullLimiter } from '../middleware/rate-limiters.js';
import {
  getDockerStatus,
  getDockerOverview,
  getDockerContainerLogs,
  getDockerContainerMonitoring,
  inspectDockerContainer,
  listDockerContainers,
  restartContainer,
  startContainer,
  stopContainer,
} from '../controllers/docker.controller.js';
import {
  inspectDockerImage,
  listDockerImages,
  pullDockerImage,
  removeDockerImage,
} from '../controllers/docker-image.controller.js';
import {
  createDockerVolume,
  inspectDockerVolume,
  listDockerVolumes,
  removeDockerVolume,
} from '../controllers/docker-volume.controller.js';
import {
  createDockerNetwork,
  inspectDockerNetwork,
  listDockerNetworks,
  removeDockerNetwork,
} from '../controllers/docker-network.controller.js';

export const dockerRouter = Router();

dockerRouter.use(requireAuth);
dockerRouter.use(recordAuthenticatedActivity);
dockerRouter.get('/status', getDockerStatus);
dockerRouter.get('/overview', getDockerOverview);
dockerRouter.get('/containers', listDockerContainers);
dockerRouter.get('/containers/monitoring', expensiveDockerReadLimiter, getDockerContainerMonitoring);
dockerRouter.get('/containers/:id/logs', expensiveDockerReadLimiter, getDockerContainerLogs);
dockerRouter.get('/containers/:id', inspectDockerContainer);
dockerRouter.get('/images', listDockerImages);
dockerRouter.post('/images/pull', imagePullLimiter, dockerMutationLimiter, pullDockerImage);
dockerRouter.get('/images/:id', inspectDockerImage);
dockerRouter.delete('/images/:id', dockerMutationLimiter, removeDockerImage);
dockerRouter.get('/volumes', listDockerVolumes);
dockerRouter.post('/volumes', dockerMutationLimiter, createDockerVolume);
dockerRouter.get('/volumes/:name', inspectDockerVolume);
dockerRouter.delete('/volumes/:name', dockerMutationLimiter, removeDockerVolume);
dockerRouter.get('/networks', listDockerNetworks);
dockerRouter.post('/networks', dockerMutationLimiter, createDockerNetwork);
dockerRouter.get('/networks/:id', inspectDockerNetwork);
dockerRouter.delete('/networks/:id', dockerMutationLimiter, removeDockerNetwork);
dockerRouter.post('/containers/:id/start', dockerMutationLimiter, startContainer);
dockerRouter.post('/containers/:id/stop', dockerMutationLimiter, stopContainer);
dockerRouter.post('/containers/:id/restart', dockerMutationLimiter, restartContainer);
