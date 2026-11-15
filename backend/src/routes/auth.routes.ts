import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { createRateLimiter, registrationLimiter } from '../middleware/rate-limiters.js';
import { login, logout, me, register } from '../controllers/auth.controller.js';
import { beginGoogleAuth, completeGoogleAuth, getGoogleAuthConfig } from '../controllers/google-auth.controller.js';

const loginLimiter = createRateLimiter(
  15 * 60 * 1000,
  10,
  'Too many login attempts. Try again later.',
  { skipSuccessfulRequests: true },
);

export const authRouter = Router();

authRouter.post('/register', registrationLimiter, register);
authRouter.post('/login', loginLimiter, login);
authRouter.get('/google/config', getGoogleAuthConfig);
authRouter.get('/google', createRateLimiter(15 * 60 * 1000, 20, 'Too many Google Sign-In attempts. Try again later.'), beginGoogleAuth);
authRouter.get('/google/callback', createRateLimiter(15 * 60 * 1000, 30, 'Too many Google authentication callbacks.'), completeGoogleAuth);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, me);
