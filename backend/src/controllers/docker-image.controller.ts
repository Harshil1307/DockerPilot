import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import type { DockerImagePullProgress } from '../services/docker-image.service.js';
import { dockerImageService } from '../services/docker.service.js';

const pullSchema = z.object({ reference: z.string().trim().min(1).max(300) }).strict();

function sendEvent(response: Parameters<RequestHandler>[1], event: Record<string, unknown>): void {
  if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
}

function pullError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof DockerUnavailableError) return { code: 'DOCKER_UNAVAILABLE', message: error.message };
  return { code: 'IMAGE_PULL_FAILED', message: 'Docker could not pull this image. Check the image reference and registry access.' };
}

export const listDockerImages: RequestHandler = async (_request, response) => {
  response.status(200).json(await dockerImageService.listImages());
};

export const inspectDockerImage: RequestHandler = async (request, response) => {
  response.status(200).json(await dockerImageService.inspectImage(request.params.id));
};

export const removeDockerImage: RequestHandler = async (request, response) => {
  await dockerImageService.removeImage(request.params.id);
  response.status(204).send();
};

export const pullDockerImage: RequestHandler = async (request, response, next) => {
  const parsed = pullSchema.safeParse(request.body);
  if (!parsed.success) {
    next(new AppError('Provide an image repository and tag to pull.', 400, 'INVALID_IMAGE_REFERENCE'));
    return;
  }

  let operation: ReturnType<typeof dockerImageService.beginPull>;
  try {
    operation = dockerImageService.beginPull(parsed.data.reference);
  } catch (error) {
    next(error);
    return;
  }

  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.flushHeaders();
  sendEvent(response, { type: 'progress', status: `Pulling ${operation.reference}` });
  try {
    await operation.run((progress: DockerImagePullProgress) => {
      sendEvent(response, { type: 'progress', ...progress });
    });
    response.locals.activitySuccess = true;
    sendEvent(response, { type: 'complete', reference: operation.reference });
  } catch (error) {
    response.locals.activitySuccess = false;
    sendEvent(response, { type: 'error', ...pullError(error) });
  } finally {
    if (!response.writableEnded) response.end();
  }
};
