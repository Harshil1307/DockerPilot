import type { RequestHandler } from 'express';
import { isAllowedOrigin } from '../config/cors.js';

const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const originGuard: RequestHandler = (request, response, next) => {
  const origin = request.get('origin');
  if (stateChangingMethods.has(request.method) && origin && !isAllowedOrigin(origin)) {
    response.status(403).json({ error: 'Request origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
    return;
  }
  next();
};
