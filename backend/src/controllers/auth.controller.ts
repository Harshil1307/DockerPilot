import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { authService } from '../services/auth.service.js';
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS } from '../auth/auth.constants.js';
import { env } from '../config/env.js';

const emailSchema = z.string().trim().email('Enter a valid email address.').max(254).transform((email) => email.toLowerCase());
const passwordSchema = z.string().min(1, 'Password is required.').refine(
  (password) => Buffer.byteLength(password, 'utf8') <= 72,
  'Password must be 72 UTF-8 bytes or fewer.',
);

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100, 'Name must be 100 characters or fewer.'),
  email: emailSchema,
  password: z.string().min(12, 'Password must be at least 12 characters.').refine(
    (password) => Buffer.byteLength(password, 'utf8') <= 72,
    'Password must be 72 UTF-8 bytes or fewer.',
  ),
}).strict();

const loginSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();

function setSessionCookie(response: Response, token: string): void {
  response.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // Vercel proxies /api to Render, so the browser uses a same-origin cookie.
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION_MS,
  });
}

const sessionCookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

export const register: RequestHandler = async (request, response) => {
  const input = registerSchema.parse(request.body);
  const result = await authService.register(input.name, input.email, input.password);
  setSessionCookie(response, result.token);
  response.status(201).json({ user: result.user });
};

export const login: RequestHandler = async (request, response) => {
  const input = loginSchema.parse(request.body);
  const result = await authService.login(input.email, input.password);
  setSessionCookie(response, result.token);
  response.status(200).json({ user: result.user });
};

export const logout: RequestHandler = (_request, response) => {
  response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);
  response.status(204).send();
};

export const me: RequestHandler = async (request, response) => {
  if (!request.userId) {
    throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  }
  response.status(200).json({ user: await authService.getCurrentUser(request.userId) });
};
