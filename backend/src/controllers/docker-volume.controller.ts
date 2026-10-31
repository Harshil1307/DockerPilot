import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { dockerVolumeService } from '../services/docker.service.js';

const createSchema = z.object({ name: z.string() }).strict();
const removeSchema = z.object({ confirmation: z.string() }).strict();

export const listDockerVolumes: RequestHandler = async (_request, response) => {
  response.status(200).json(await dockerVolumeService.listVolumes());
};

export const inspectDockerVolume: RequestHandler = async (request, response) => {
  response.status(200).json(await dockerVolumeService.inspectVolume(request.params.name));
};

export const createDockerVolume: RequestHandler = async (request, response, next) => {
  const parsed = createSchema.safeParse(request.body);
  if (!parsed.success) {
    next(new AppError('Provide a valid Docker volume name.', 400, 'INVALID_VOLUME_NAME'));
    return;
  }
  response.status(201).json(await dockerVolumeService.createVolume(parsed.data.name));
};

export const removeDockerVolume: RequestHandler = async (request, response, next) => {
  const parsed = removeSchema.safeParse(request.body);
  if (!parsed.success) {
    next(new AppError('Confirm removal by providing the exact volume name.', 400, 'VOLUME_CONFIRMATION_REQUIRED'));
    return;
  }
  await dockerVolumeService.removeVolume(request.params.name, parsed.data.confirmation);
  response.status(204).send();
};
