import type { RequestHandler } from 'express';
import { isAllowedOrigin } from '../config/cors.js';

export const originGuard: RequestHandler = (request, response, next) => {
  const origin = request.get('origin');
  if (origin && !isAllowedOrigin(origin)) {
    response.status(403).json({ error: 'Request origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
    return;
  }
  next();
};
