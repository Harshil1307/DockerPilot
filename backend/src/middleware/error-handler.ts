import type { ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
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

  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2021', 'P2022'].includes(error.code)) {
    console.error(`[api:error] Database schema is out of date (${error.code}).`);
    response.status(503).json({
      error: 'Database schema is out of date. Apply the project migrations and restart the API.',
      code: 'DATABASE_SCHEMA_OUTDATED',
    });
    return;
  }

  if (
    error instanceof Prisma.PrismaClientInitializationError
    || (error instanceof Prisma.PrismaClientKnownRequestError && ['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1010', 'P1011', 'P1017', 'P2024'].includes(error.code))
  ) {
    const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'INITIALIZATION';
    console.error(`[api:error] PostgreSQL request failed (${prismaCode}).`);
    response.status(503).json({
      error: 'Database unavailable. Check that PostgreSQL is running and DATABASE_URL points to it.',
      code: 'DATABASE_UNAVAILABLE',
    });
    return;
  }

  // Keep diagnostics useful without printing raw database, Docker, or request data.
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const requestId = request.get('cf-ray');
  const safeRequestId = requestId && /^[a-f\d]{8,32}-[a-z\d-]{1,40}$/i.test(requestId) ? ` request=${requestId}` : '';
  console.error(`[api:error] Unhandled request failure (${errorName}).${safeRequestId}`);
  response.status(500).json({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
};
