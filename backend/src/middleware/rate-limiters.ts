import { rateLimit } from 'express-rate-limit';

export function createRateLimiter(windowMs: number, limit: number, message: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message, code: 'RATE_LIMITED' },
  });
}

export const registrationLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many account creation attempts. Try again later.');
export const dockerMutationLimiter = createRateLimiter(60 * 1000, 60, 'Too many Docker changes in a short time. Wait a moment and try again.');
export const composeOperationLimiter = createRateLimiter(60 * 1000, 30, 'Too many Compose operations in a short time. Wait a moment and try again.');
export const expensiveDockerReadLimiter = createRateLimiter(60 * 1000, 30, 'Too many Docker monitoring or log requests. Wait a moment and try again.');
export const imagePullLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many image pulls. Try again later.');
