import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { projectService } from '../src/services/project.service.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';

test('connects a public GitHub repository and stores its default branch', async () => {
  const project = prisma.project as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const oldCreate = project.create;
  const originalFetch = globalThis.fetch;
  let createData: Record<string, unknown> | null = null;
  globalThis.fetch = async () => Response.json({ name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main', private: false });
  project.create = async (args) => { createData = (args as { data: Record<string, unknown> }).data; return { id: projectId, createdAt: new Date(), updatedAt: new Date(), ...createData }; };
  try {
    const result = await projectService.create(ownerId, { name: 'App', repositoryUrl: 'https://github.com/acme/app' });
    assert.equal(result.repositoryStatus, 'connected');
    assert.equal(result.repositoryName, 'app');
    assert.equal(result.repositoryDefaultBranch, 'main');
    assert.equal(createData?.repositoryUrl, 'https://github.com/acme/app');
    assert.equal(Object.hasOwn(createData ?? {}, 'repositoryPath'), false);
    assert.equal(Object.hasOwn(createData ?? {}, 'githubTokenEncrypted'), false);
  } finally { project.create = oldCreate; globalThis.fetch = originalFetch; }
});

test('disconnecting GitHub clears its connection metadata', async () => {
  const project = prisma.project as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const oldFindFirst = project.findFirst;
  const oldUpdateMany = project.updateMany;
  let stored: Record<string, unknown> = { id: projectId, userId: ownerId, name: 'App', description: null, repositoryUrl: 'https://github.com/acme/app', repositoryOwner: 'acme', repositoryName: 'app', repositoryDefaultBranch: 'main', repositoryStatus: 'connected', repositoryError: null, repositoryVerifiedAt: new Date() };
  let updateData: Record<string, unknown> | null = null;
  project.findFirst = async () => stored;
  project.updateMany = async (args) => { updateData = (args as { data: Record<string, unknown> }).data; stored = { ...stored, ...updateData }; return { count: 1 }; };
  try {
    const result = await projectService.update(projectId, ownerId, { repositoryUrl: null });
    assert.equal(updateData?.repositoryStatus, 'disconnected');
    assert.equal(updateData?.repositoryDefaultBranch, null);
    assert.equal(result.repositoryUrl, null);
  } finally { project.findFirst = oldFindFirst; project.updateMany = oldUpdateMany; }
});
