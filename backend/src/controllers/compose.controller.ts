import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { composeEnvironmentService } from '../services/compose-environment.service.js';
import { composeDeploymentService } from '../services/compose-deployment.service.js';
import { composeCleanupService } from '../services/compose-cleanup.service.js';
import { composeLifecycleService, type ComposeLifecycleAction } from '../services/compose-lifecycle.service.js';
import { composeMonitoringService } from '../services/compose-monitoring.service.js';

const uuidSchema = z.string().uuid();
const composeEnvironmentSchema = z.object({
  name: z.string().trim().min(1, 'Environment name is required.').max(100, 'Environment name must be 100 characters or fewer.'),
  composeYaml: z.string().min(1, 'Compose YAML is required.'),
}).strict().refine((input) => input.composeYaml.trim().length > 0, {
  path: ['composeYaml'],
  message: 'Compose YAML is required.',
});

function parseId(value: unknown, label: string): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw new AppError(`${label} must be a valid UUID.`, 400, `INVALID_${label.toUpperCase().replaceAll(' ', '_')}`);
  return result.data;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  return value;
}

export const createComposeEnvironment: RequestHandler = async (request, response) => {
  const input = composeEnvironmentSchema.parse(request.body);
  const environment = await composeEnvironmentService.create(
    parseId(request.params.projectId, 'Project ID'),
    requireUserId(request.userId),
    input,
  );
  response.status(201).json(environment);
};

export const listComposeEnvironments: RequestHandler = async (request, response) => {
  response.status(200).json(await composeEnvironmentService.list(
    parseId(request.params.projectId, 'Project ID'),
    requireUserId(request.userId),
  ));
};

export const getComposeEnvironment: RequestHandler = async (request, response) => {
  response.status(200).json(await composeEnvironmentService.get(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
  ));
};

export const updateComposeEnvironment: RequestHandler = async (request, response) => {
  const input = composeEnvironmentSchema.parse(request.body);
  response.status(200).json(await composeEnvironmentService.update(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
    input,
  ));
};

export const deleteComposeEnvironment: RequestHandler = async (request, response) => {
  await composeEnvironmentService.remove(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
  );
  response.status(204).send();
};

export const validateComposeEnvironment: RequestHandler = async (request, response) => {
  response.status(200).json(await composeEnvironmentService.validate(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
  ));
};

export const deployComposeEnvironment: RequestHandler = async (request, response) => {
  response.status(200).json(await composeDeploymentService.deploy(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
  ));
};

export const getComposeDeploymentStatus: RequestHandler = async (request, response) => {
  response.status(200).json(await composeDeploymentService.getStatus(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
  ));
};

export const deleteComposeDeployment: RequestHandler = async (request, response) => {
  response.status(200).json(await composeCleanupService.cleanup(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
  ));
};

export const operateComposeDeployment: RequestHandler = async (request, response) => {
  const action = z.enum(['start', 'stop', 'restart']).parse(request.params.action) as ComposeLifecycleAction;
  response.status(200).json(await composeLifecycleService.operate(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
    action,
  ));
};

export const getComposeMonitoring: RequestHandler = async (request, response) => {
  response.status(200).json(await composeMonitoringService.getInventory(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
  ));
};

export const getComposeContainerLogs: RequestHandler = async (request, response) => {
  const tail = Number(request.query.tail ?? 100);
  if (![50, 100, 250, 500].includes(tail)) throw new AppError('Log tail must be 50, 100, 250, or 500 lines.', 400, 'INVALID_LOG_TAIL');
  const parsedContainerId = z.string().regex(/^[a-f\d]{64}$/i).safeParse(request.params.containerId);
  if (!parsedContainerId.success) throw new AppError('Container ID must be a valid Docker resource ID.', 400, 'INVALID_CONTAINER_ID');
  response.status(200).json(await composeMonitoringService.getRecentLogs(
    parseId(request.params.id, 'Environment ID'),
    requireUserId(request.userId),
    parsedContainerId.data,
    tail,
  ));
};
