import { env } from './env.js';

const localDevelopmentOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

export function isAllowedOrigin(origin: string): boolean {
  if (origin === env.FRONTEND_ORIGIN) return true;
  return env.NODE_ENV !== 'production' && localDevelopmentOrigins.has(origin);
}

export const corsOptions = {
  origin(origin: string | undefined, callback: (error: Error | null, origin?: string | false) => void) {
    callback(null, !origin || isAllowedOrigin(origin) ? origin ?? false : false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};
