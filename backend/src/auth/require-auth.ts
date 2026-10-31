import type { RequestHandler } from 'express';
import { SESSION_COOKIE_NAME } from './auth.constants.js';
import { readSessionToken } from './session-token.js';

export const requireAuth: RequestHandler = (request, response, next) => {
  const token: unknown = request.cookies?.[SESSION_COOKIE_NAME];
  const userId = typeof token === 'string' ? readSessionToken(token) : null;

  if (!userId) {
    response.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    return;
  }

  request.userId = userId;
  next();
};
