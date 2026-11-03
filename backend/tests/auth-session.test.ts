import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { test, type TestContext } from 'node:test';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants.js';
import { createSessionToken } from '../src/auth/session-token.js';
import { corsOptions } from '../src/config/cors.js';
import { authService } from '../src/services/auth.service.js';
import { projectService } from '../src/services/project.service.js';
import { authRouter } from '../src/routes/auth.routes.js';
import { projectRouter } from '../src/routes/project.routes.js';
import { originGuard } from '../src/middleware/origin-guard.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const userId = '11111111-1111-4111-8111-111111111111';
const user = { id: userId, name: 'Test User', email: 'test@example.invalid', createdAt: new Date(), updatedAt: new Date() };

async function sessionTestServer(context: TestContext) {
  const app = express();
  app.use(cors(corsOptions));
  app.use(originGuard);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api/projects', projectRouter);
  app.use(errorHandler);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function mockServices(context: TestContext) {
  const oldLogin = authService.login;
  const oldRegister = authService.register;
  const oldCurrentUser = authService.getCurrentUser;
  const oldProjectCreate = projectService.create;
  authService.login = async () => ({ user, token: createSessionToken(userId) });
  authService.register = async () => ({ user, token: createSessionToken(userId) });
  authService.getCurrentUser = async () => user;
  projectService.create = async (ownerId, input) => ({
    id: '22222222-2222-4222-8222-222222222222', ...input, description: input.description ?? null,
    repositoryUrl: input.repositoryUrl ?? null, userId: ownerId, createdAt: new Date(), updatedAt: new Date(),
  });
  context.after(() => {
    authService.login = oldLogin;
    authService.register = oldRegister;
    authService.getCurrentUser = oldCurrentUser;
    projectService.create = oldProjectCreate;
  });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'auth response should set an HTTP-only session cookie');
  assert.match(setCookie, new RegExp(`${SESSION_COOKIE_NAME}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, /Max-Age=604800/i);
  assert.doesNotMatch(setCookie, /;\s*Domain=/i);
  if (process.env.NODE_ENV === 'production') assert.match(setCookie, /;\s*Secure/i);
  return `${SESSION_COOKIE_NAME}=${setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1]}`;
}

test('login session survives restoration and authorizes project registration; logout clears it', async (context) => {
  mockServices(context);
  const base = await sessionTestServer(context);
  const origin = 'https://docker-pilot.vercel.app';
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'correct-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = cookieFrom(login);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const restored = await fetch(`${base}/api/auth/me`, { headers: { Origin: origin, Cookie: cookie } });
    assert.equal(restored.status, 200, 'session must be recognized after initial login and browser restoration');
    assert.equal((await restored.json() as { user: { id: string } }).user.id, userId);
  }

  const project = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Session project' }),
  });
  assert.equal(project.status, 201);
  assert.equal((await project.json() as { userId: string }).userId, userId);

  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie') ?? '', /Expires=Thu, 01 Jan 1970/i);
  const afterLogout = await fetch(`${base}/api/auth/me`, { headers: { Origin: origin } });
  assert.equal(afterLogout.status, 401);
});

test('registration creates a session and unauthenticated project creation returns 401', async (context) => {
  mockServices(context);
  const base = await sessionTestServer(context);
  const unauthed = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'No session' }),
  });
  assert.equal(unauthed.status, 401);

  const registration = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: user.name, email: user.email, password: 'correct-password-123' }),
  });
  assert.equal(registration.status, 201);
  assert.ok(cookieFrom(registration));
});

test('CORS allows the exact Vercel origin, rejects other origins, and answers OPTIONS preflight', async (context) => {
  const base = await sessionTestServer(context);
  const good = await fetch(`${base}/api/auth/login`, {
    method: 'OPTIONS', headers: {
      Origin: 'https://docker-pilot.vercel.app',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://docker-pilot.vercel.app');
  assert.equal(good.headers.get('access-control-allow-credentials'), 'true');
  assert.match(good.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match(good.headers.get('access-control-allow-headers') ?? '', /content-type/i);

  const bad = await fetch(`${base}/api/auth/login`, {
    method: 'OPTIONS', headers: {
      Origin: 'https://unapproved.example',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
