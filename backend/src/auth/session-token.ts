import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import {
  SESSION_AUDIENCE,
  SESSION_DURATION_SECONDS,
  SESSION_ISSUER,
} from './auth.constants.js';

export function createSessionToken(userId: string): string {
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
    expiresIn: SESSION_DURATION_SECONDS,
  });
}

export function readSessionToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    }) as JwtPayload;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
