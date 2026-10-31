import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters.'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DOCKER_SOCKET_PATH: z.string().trim().min(1).optional(),
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
