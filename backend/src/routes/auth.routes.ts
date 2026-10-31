import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth } from '../auth/require-auth.js';
import { registrationLimiter } from '../middleware/rate-limiters.js';
import { login, logout, me, register } from '../controllers/auth.controller.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.', code: 'RATE_LIMITED' },
});

export const authRouter = Router();

authRouter.post('/register', registrationLimiter, register);
authRouter.post('/login', loginLimiter, login);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, me);
