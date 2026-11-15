import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { AppError } from '../errors/app-error.js';
import { env } from '../config/env.js';
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS } from '../auth/auth.constants.js';
import { authService } from '../services/auth.service.js';

const TRANSACTION_COOKIE = 'dockerpilot_google_oauth';
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

function isConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI);
}

function oauthClient(): OAuth2Client {
  if (!isConfigured()) throw new AppError('Google Sign-In is not configured on this DockerPilot deployment.', 503, 'GOOGLE_OAUTH_NOT_CONFIGURED');
  return new OAuth2Client({ clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI! });
}

function transactionCookieOptions() {
  return { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: TRANSACTION_TTL_MS };
}

function clearTransactionCookie(response: Parameters<RequestHandler>[1]) {
  response.clearCookie(TRANSACTION_COOKIE, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
}

function frontLogin(status: 'cancelled' | 'failed'): string {
  const destination = new URL('/login', env.FRONTEND_ORIGIN);
  destination.searchParams.set('google', status);
  return destination.toString();
}

export const getGoogleAuthConfig: RequestHandler = (_request, response) => response.status(200).json({ enabled: isConfigured() });

export const beginGoogleAuth: RequestHandler = async (_request, response) => {
  const client = oauthClient();
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const transaction = Buffer.from(JSON.stringify({ state, nonce, codeVerifier, createdAt: Date.now() })).toString('base64url');
  response.cookie(TRANSACTION_COOKIE, transaction, transactionCookieOptions());
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.redirect(client.generateAuthUrl({
    response_type: 'code',
    scope: ['openid', 'email', 'profile'],
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    prompt: 'select_account',
  }));
};

export const completeGoogleAuth: RequestHandler = async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  clearTransactionCookie(response);
  const providerError = typeof request.query.error === 'string' ? request.query.error : null;
  if (providerError === 'access_denied') { response.redirect(frontLogin('cancelled')); return; }

  const code = typeof request.query.code === 'string' ? request.query.code : '';
  const state = typeof request.query.state === 'string' ? request.query.state : '';
  const transactionValue = request.cookies?.[TRANSACTION_COOKIE];
  if (!code || !state || typeof transactionValue !== 'string') { response.redirect(frontLogin('failed')); return; }

  try {
    const transaction = JSON.parse(Buffer.from(transactionValue, 'base64url').toString('utf8')) as {
      state?: unknown; nonce?: unknown; codeVerifier?: unknown; createdAt?: unknown;
    };
    const expectedState = typeof transaction.state === 'string' ? Buffer.from(transaction.state) : Buffer.alloc(0);
    const receivedState = Buffer.from(state);
    if (expectedState.length !== receivedState.length || expectedState.length < 32 || !timingSafeEqual(expectedState, receivedState)
      || typeof transaction.nonce !== 'string' || typeof transaction.codeVerifier !== 'string'
      || typeof transaction.createdAt !== 'number' || Date.now() - transaction.createdAt > TRANSACTION_TTL_MS
      || transaction.createdAt > Date.now() + 30_000) {
      response.redirect(frontLogin('failed')); return;
    }

    const client = oauthClient();
    const { tokens } = await client.getToken({ code, codeVerifier: transaction.codeVerifier });
    if (!tokens.id_token) { response.redirect(frontLogin('failed')); return; }
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
    const identity = ticket.getPayload();
    if (!identity || identity.nonce !== transaction.nonce || !identity.sub || !identity.email || identity.email_verified !== true) {
      response.redirect(frontLogin('failed')); return;
    }
    const result = await authService.loginWithGoogle({
      subject: identity.sub,
      email: identity.email.toLowerCase(),
      name: identity.name?.trim().slice(0, 100) || identity.email.split('@')[0]!.slice(0, 100),
    });
    response.cookie(SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DURATION_MS,
    });
    response.redirect(new URL('/', env.FRONTEND_ORIGIN).toString());
  } catch {
    response.redirect(frontLogin('failed'));
  }
};
