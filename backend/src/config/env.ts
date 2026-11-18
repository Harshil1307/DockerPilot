import 'dotenv/config';
import { z } from 'zod';

const optionalValue = z.preprocess((value) => value === '' ? undefined : value, z.string().trim().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters.'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DOCKER_SOCKET_PATH: z.string().trim().min(1).optional(),
  DOCKER_CONNECTION_MODE: z.enum(['local', 'agent']).default('local'),
  AI_IDLE_CPU_THRESHOLD_PERCENT: z.coerce.number().min(0).max(50).default(1),
  AI_IDLE_IO_THRESHOLD_BYTES: z.coerce.number().int().min(0).max(10_000_000).default(1024),
  AI_IDLE_MINIMUM_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  GOOGLE_CLIENT_ID: optionalValue,
  GOOGLE_CLIENT_SECRET: optionalValue,
  GOOGLE_OAUTH_REDIRECT_URI: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
}).superRefine((value, context) => {
  if (Boolean(value.GOOGLE_CLIENT_ID) !== Boolean(value.GOOGLE_CLIENT_SECRET)) {
    context.addIssue({ code: 'custom', message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.' });
  }
  if (value.GOOGLE_CLIENT_ID && !value.GOOGLE_OAUTH_REDIRECT_URI) {
    context.addIssue({ code: 'custom', message: 'GOOGLE_OAUTH_REDIRECT_URI is required when Google OAuth credentials are configured.' });
  }
});

const result = envSchema.safeParse(process.env);
if (!result.success) {
  throw new Error(`Invalid environment configuration: ${result.error.message}`);
}

if (result.data.NODE_ENV === 'production') {
  if (!result.data.FRONTEND_ORIGIN.startsWith('https://')) {
    throw new Error('FRONTEND_ORIGIN must use HTTPS in production.');
  }
  if (/replace_with|change_me|development|example/i.test(result.data.JWT_SECRET)) {
    throw new Error('JWT_SECRET must be replaced with a unique production secret.');
  }
}

export const env = result.data;
