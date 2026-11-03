import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_API_PREFIX } from '../src/app.js';
import { authRouter } from '../src/routes/auth.routes.js';
import { corsOptions } from '../src/config/cors.js';

test('login and registration paths match the mounted auth API prefix', () => {
  const routes = authRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: `${AUTH_API_PREFIX}${layer.route!.path}`, methods: layer.route!.methods }));
  assert.ok(routes.some((route) => route.path === '/api/auth/login' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/api/auth/register' && route.methods.post));
});

test('CORS allows credentialed preflight from the production frontend only with an explicit origin', () => {
  let returnedOrigin: string | false | undefined;
  corsOptions.origin('https://docker-pilot.vercel.app', (_error, origin) => { returnedOrigin = origin; });
  assert.equal(returnedOrigin, 'https://docker-pilot.vercel.app');
  assert.equal(corsOptions.credentials, true);
  assert.ok(corsOptions.methods.includes('OPTIONS'));
  assert.ok(corsOptions.methods.includes('POST'));
  assert.ok(corsOptions.allowedHeaders.includes('Content-Type'));
  assert.equal(corsOptions.optionsSuccessStatus, 204);
  assert.ok(!corsOptions.methods.includes('*'));

  returnedOrigin = undefined;
  corsOptions.origin('https://untrusted.example', (_error, origin) => { returnedOrigin = origin; });
  assert.equal(returnedOrigin, false);
});
