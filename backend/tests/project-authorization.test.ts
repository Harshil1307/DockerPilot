import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { projectService } from '../src/services/project.service.js';

const projectId = '33333333-3333-4333-8333-333333333333';
const otherUserId = '22222222-2222-4222-8222-222222222222';

test('cross-user project reads and deletes stay hidden and filter by the authenticated user', async () => {
  const delegate = prisma.project as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalFindFirst = delegate.findFirst;
  let argsSeen: unknown;
  delegate.findFirst = async (args) => { argsSeen = args; return null; };
  try {
    await assert.rejects(projectService.get(projectId, otherUserId), { code: 'PROJECT_NOT_FOUND' });
    assert.deepEqual(argsSeen, { where: { id: projectId, userId: otherUserId } });
    await assert.rejects(projectService.remove(projectId, otherUserId), { code: 'PROJECT_NOT_FOUND' });
    assert.deepEqual(argsSeen, { where: { id: projectId, userId: otherUserId }, select: { id: true } });
  } finally { delegate.findFirst = originalFindFirst; }
});

test('project updates cannot modify a record owned by a different account', async () => {
  const delegate = prisma.project as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalUpdateMany = delegate.updateMany;
  let where: unknown;
  delegate.updateMany = async (args) => { where = (args as { where: unknown }).where; return { count: 0 }; };
  try {
    await assert.rejects(projectService.update(projectId, otherUserId, { name: 'updated' }), { code: 'PROJECT_NOT_FOUND' });
    assert.deepEqual(where, { id: projectId, userId: otherUserId });
  } finally { delegate.updateMany = originalUpdateMany; }
});
