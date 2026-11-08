import type { ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }

  if (error instanceof DockerUnavailableError) {
    response.status(503).json({ error: error.message, code: 'DOCKER_UNAVAILABLE' });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: 'Invalid request.',
      code: 'VALIDATION_ERROR',
      details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
    return;
  }

  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    response.status(400).json({ error: 'Request body must contain valid JSON.', code: 'INVALID_JSON' });
    return;
  }

  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    response.status(413).json({ error: 'Request body is too large.', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    response.status(409).json({ error: 'A resource with these unique values already exists.', code: 'CONFLICT' });
    return;
  }

  if (
    error instanceof Prisma.PrismaClientInitializationError
    || (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P2024'].includes(error.code))
  ) {
    console.error('[api:error] PostgreSQL is unavailable for this request.');
    response.status(503).json({
      error: 'Database unavailable. Check that PostgreSQL is running and DATABASE_URL points to it.',
      code: 'DATABASE_UNAVAILABLE',
    });
    return;
  }

  // Do not serialize or print unknown errors: Docker/API errors can contain secrets or connection details.
  console.error('[api:error] Unhandled request failure.');
  response.status(500).json({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
};
