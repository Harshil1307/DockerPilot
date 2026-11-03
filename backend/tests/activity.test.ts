import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import cookieParser from 'cookie-parser';
import express from 'express';
import { test, type TestContext } from 'node:test';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants.js';
import { createSessionToken } from '../src/auth/session-token.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { describeActivity } from '../src/middleware/activity-recorder.js';
import { createRateLimiter } from '../src/middleware/rate-limiters.js';
import { activityRouter } from '../src/routes/activity.routes.js';
import { createActivityService, type ActivityInput, type ActivityRepository } from '../src/services/activity.service.js';

const firstUser = '11111111-1111-4111-8111-111111111111';
const secondUser = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const records: ActivityInput[] = [];
  const requested: Parameters<ActivityRepository['findMany']>[0][] = [];
  const repository: ActivityRepository = {
    async create(input) { records.push(input); return input; },
    async findMany(input) {
      requested.push(input);
      return Array.from({ length: input.take }, (_, index) => ({ id: `${input.userId}-${input.skip + index}` }));
    },
  };
  return { service: createActivityService(repository), records, requested };
}

test('activity records sanitize bounded fields and preserve a safe failure result', async () => {
  const f = fixture();
  await f.service.record({
    userId: firstUser, projectId: null, actionType: 'CONTAINER_STOPPED', resourceType: 'container',
    resourceId: 'a'.repeat(64), resourceName: '  database\n token=do-not-save', status: 'FAILED', summary: 'Stop failed\u0000 api_key=do-not-save safely.',
  });
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0]?.resourceName, '  database token=[REDACTED]');
  assert.equal(f.records[0]?.summary, 'Stop failed api_key=[REDACTED] safely.');
  assert.equal(JSON.stringify(f.records[0]).includes('do-not-save'), false);
  assert.equal(f.records[0]?.status, 'FAILED');
});

test('activity middleware maps only supported mutations to fixed event types', () => {
  assert.deepEqual(describeActivity('POST', '/api/docker/containers/:id/restart'), { actionType: 'CONTAINER_RESTARTED', resourceType: 'container' });
  assert.deepEqual(describeActivity('POST', '/api/compose/:id/deployment/stop'), { actionType: 'COMPOSE_DEPLOYMENT_STOPPED', resourceType: 'compose_deployment' });
  assert.deepEqual(describeActivity('DELETE', '/api/docker/volumes/:name'), { actionType: 'VOLUME_REMOVED', resourceType: 'volume' });
  assert.equal(describeActivity('POST', '/api/compose/:id/validate'), null);
  assert.equal(describeActivity('GET', '/api/docker/containers'), null);
});

test('activity history uses the caller user scope, validated filters, stable newest-first page sizes', async () => {
  const f = fixture();
  const page = await f.service.list({ userId: firstUser, actionType: 'IMAGE_REMOVED', resourceType: 'image', page: 2 });
  assert.deepEqual(f.requested[0], { userId: firstUser, actionType: 'IMAGE_REMOVED', resourceType: 'image', skip: 30, take: 31 });
  assert.equal(page.activities.length, 30);
  assert.equal(page.hasMore, true);
  const otherPage = await f.service.list({ userId: secondUser, page: 1 });
  assert.equal(f.requested[1]?.userId, secondUser);
  assert.equal(otherPage.hasMore, true);
});

test('activity write failure does not replace the original Docker operation outcome', async () => {
  const service = createActivityService({
    async create() { throw new Error('sensitive database detail'); },
    async findMany() { return []; },
  });
  await assert.doesNotReject(service.record({
    userId: firstUser, actionType: 'NETWORK_CREATED', resourceType: 'network', status: 'SUCCEEDED', summary: 'Network created.',
  }));
});

async function activityTestServer(context: TestContext) {
  const app = express();
  app.use(cookieParser());
  app.use('/api/activity', activityRouter);
  app.use(errorHandler);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}/api/activity`, cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(firstUser)}` };
}

test('activity history requires authentication and rejects invalid filters before database access', async (context) => {
  const { url, cookie } = await activityTestServer(context);
  const unauthenticated = await fetch(url);
  assert.equal(unauthenticated.status, 401);
  const invalid = await fetch(`${url}?actionType=UNSUPPORTED`, { headers: { cookie } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { code: string }).code, 'INVALID_ACTIVITY_FILTER');
});

test('rate limiting rejects excess requests with a safe 429 response', async (context) => {
  const app = express();
  app.get('/', createRateLimiter(60_000, 2, 'Too many requests.'), (_request, response) => response.sendStatus(200));
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 200);
  const limited = await fetch(url);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await limited.json() as { code: string }).code, 'RATE_LIMITED');
});
