import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { dockerNetworkService } from '../services/docker.service.js';

const createSchema = z.object({
  name: z.string(),
  internal: z.boolean().optional(),
  enableIPv6: z.boolean().optional(),
}).strict();
const removeSchema = z.object({ confirmationName: z.string() }).strict();

export const listDockerNetworks: RequestHandler = async (_request, response) => {
  response.status(200).json(await dockerNetworkService.listNetworks());
};

export const inspectDockerNetwork: RequestHandler = async (request, response) => {
  response.status(200).json(await dockerNetworkService.inspectNetwork(request.params.id));
};

export const createDockerNetwork: RequestHandler = async (request, response, next) => {
  const parsed = createSchema.safeParse(request.body);
  if (!parsed.success) {
    next(new AppError('Provide a network name and supported network settings.', 400, 'INVALID_NETWORK_CONFIGURATION'));
    return;
  }
  response.status(201).json(await dockerNetworkService.createNetwork(parsed.data.name, parsed.data));
};

export const removeDockerNetwork: RequestHandler = async (request, response, next) => {
  const parsed = removeSchema.safeParse(request.body);
  if (!parsed.success) {
    next(new AppError('Confirm removal by providing the exact network name.', 400, 'NETWORK_CONFIRMATION_REQUIRED'));
    return;
  }
  await dockerNetworkService.removeNetwork(request.params.id, parsed.data.confirmationName);
  response.status(204).send();
};
