import type { RequestHandler } from 'express';
import { isAllowedOrigin } from '../config/cors.js';

export const originGuard: RequestHandler = (request, response, next) => {
  // Google redirects the user agent back from accounts.google.com. This route
  // validates a one-time state cookie and PKCE verifier before issuing a session.
  if (request.method === 'GET' && request.path === '/api/auth/google/callback') {
    next();
    return;
  }
  const origin = request.get('origin');
  if (origin && !isAllowedOrigin(origin)) {
    response.status(403).json({ error: 'Request origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
    return;
  }
  next();
};
