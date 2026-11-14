import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

interface RateLimiterOptions {
  skipSuccessfulRequests?: boolean;
}

export function createRateLimiter(
  windowMs: number,
  limit: number,
  message: string,
  options: RateLimiterOptions = {},
) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    skip: (request) => request.method === 'OPTIONS',
    // Authenticated DockerPilot actions belong to the signed-in account. IP
    // addresses can be shared by multiple people behind the same network or
    // proxy, which otherwise lets one person's activity exhaust everyone's
    // request budget. Keep IP-based protection for unauthenticated endpoints.
    keyGenerator: (request) => request.userId
      ? `user:${request.userId}`
      : ipKeyGenerator(request.ip),
    message: { error: message, code: 'RATE_LIMITED' },
  });
}

export const registrationLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many account creation attempts. Try again later.');
export const dockerMutationLimiter = createRateLimiter(60 * 1000, 120, 'Too many Docker changes in a short time. Wait a moment and try again.');
export const composeOperationLimiter = createRateLimiter(60 * 1000, 60, 'Too many Compose operations in a short time. Wait a moment and try again.');
export const expensiveDockerReadLimiter = createRateLimiter(60 * 1000, 120, 'Too many Docker monitoring or log requests. Wait a moment and try again.');
export const imagePullLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many image pulls. Try again later.');
