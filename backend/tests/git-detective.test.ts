import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedLocalAgentOperation } from '../src/agent/operations.js';
import { gitDetectiveService, rankGitCommits } from '../src/services/git-detective.service.js';
import { githubRepositoryService } from '../src/services/github-repository.service.js';

test('ranks service and dependency changes against the first observed Docker failure, not simply the newest commit', () => {
  const issue = { severity: 'CRITICAL', title: 'api is stopped', description: 'Stopped', evidence: 'Application startup failed: connection refused', recommendation: 'Inspect logs', service: 'api' };
  const snapshot = { repository: 'payments', branch: 'main', githubUrl: 'https://github.com/acme/payments', commits: [
    { hash: 'a'.repeat(40), author: 'Developer', committedAt: '2026-11-16T10:00:00Z', message: 'Change api startup', changedFiles: ['services/api/Dockerfile', 'services/api/package.json'], diff: '+RUN echo connection refused' },
    { hash: 'b'.repeat(40), author: 'Developer', committedAt: '2026-11-17T10:00:00Z', message: 'Update unrelated docs', changedFiles: ['README.md'], diff: '+Read the docs' },
    { hash: 'c'.repeat(40), author: 'Developer', committedAt: '2026-11-16T09:00:00Z', message: 'Adjust Compose service', changedFiles: ['compose.yaml'], diff: '+    restart: unless-stopped' },
  ] };
  const ranked = rankGitCommits(snapshot, [issue], [{ id: 'deadbeef', action: 'die', time: '2026-11-16T11:00:00Z' }], [{ id: 'deadbeef', serviceName: 'api', name: 'api_1', state: 'exited', exitCode: 1 }], '2026-11-17T11:00:00Z');
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].shortHash, 'aaaaaaaa');
  assert.equal(ranked[0].confidence, 'medium');
  assert.match(ranked[0].relationship, /not proof/);
  assert.equal(ranked[0].githubUrl, 'https://github.com/acme/payments/commit/' + 'a'.repeat(40));
  assert.ok(ranked.find((item) => item.shortHash === 'bbbbbbbb')!.score < ranked[0].score);
});

test('keeps Stack Doctor usable without a connected repository', async () => {
  const report = await gitDetectiveService.analyze({ projectId: 'project-id', issues: [], events: [], containers: [], scannedAt: new Date().toISOString() });
  assert.equal(report.status, 'not_connected');
  assert.equal(report.rootCause, null);
});

test('does not expose a local Git inspection operation to paired agents', () => {
  assert.equal(isAllowedLocalAgentOperation('git.inspect'), false);
});

test('Git Detective automatically consumes the shared connected GitHub repository history', async () => {
  const original = githubRepositoryService.history;
  let request: unknown;
  githubRepositoryService.history = async (input) => {
    request = input;
    return { repository: 'acme/app', branch: 'main', commits: [{ hash: 'd'.repeat(40), author: 'Developer', committedAt: '2026-11-17T10:00:00Z', message: 'Update app dependency', changedFiles: ['app/package.json'], diff: '+"lib": "2.0"', githubUrl: 'https://github.com/acme/app/commit/' + 'd'.repeat(40) }] };
  };
  try {
    const report = await gitDetectiveService.analyze({ projectId: 'project-one', repositoryUrl: 'https://github.com/acme/app', repositoryDefaultBranch: 'main', issues: [], events: [], containers: [], scannedAt: '2026-11-17T10:01:00Z' });
    assert.equal(report.status, 'available');
    assert.equal(report.source, 'github');
    assert.equal(report.repository, 'acme/app');
    assert.equal(report.commits[0]?.shortHash, 'dddddddd');
    assert.deepEqual(request, { projectId: 'project-one', url: 'https://github.com/acme/app' });
  } finally { githubRepositoryService.history = original; }
});

test('GitHub failures retain Docker root-cause evidence and continue without local Git', async () => {
  const original = githubRepositoryService.history;
  githubRepositoryService.history = async () => { throw new Error('Github private token xyz must not escape'); };
  try {
    const report = await gitDetectiveService.analyze({ projectId: 'project-two', repositoryUrl: 'https://github.com/acme/private', issues: [{ severity: 'CRITICAL', title: 'api failed', description: 'Runtime failure', evidence: 'Exit code 17', recommendation: 'Review logs', service: 'api' }], events: [], containers: [], scannedAt: new Date().toISOString() });
    assert.equal(report.status, 'unavailable');
    assert.equal(report.rootCause?.problem, 'api failed');
    assert.doesNotMatch(report.message ?? '', /xyz/);
  } finally { githubRepositoryService.history = original; }
});

test('Git Detective calls its configured OpenAI-compatible provider and returns the structured assessment', async () => {
  const originalHistory = githubRepositoryService.history;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const originalModel = process.env.OPENAI_MODEL;
  let providerRequest: { url: string; authorization: string | null; body: { model?: string } } | null = null;
  delete process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-provider-key';
  process.env.OPENAI_BASE_URL = 'https://mock-provider.invalid/v1';
  process.env.OPENAI_MODEL = 'test-model';
  githubRepositoryService.history = async () => ({ repository: 'acme/app', branch: 'main', commits: [{ hash: 'e'.repeat(40), author: 'Developer', committedAt: '2026-11-17T10:00:00Z', message: 'Update api startup', changedFiles: ['api/package.json'], diff: '+dependency change', githubUrl: 'https://github.com/acme/app/commit/' + 'e'.repeat(40) }] });
  globalThis.fetch = async (url, init) => {
    providerRequest = { url: String(url), authorization: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) as { model?: string } };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ problem: 'api stopped', affectedService: 'api', explanation: 'The dependency change is a possible lead, but this scan cannot prove causation.', confidence: 'medium', supportingEvidence: ['The API service stopped.'], recommendedFix: 'Review application logs.', verificationSteps: ['Rerun the service health check.'] }) } }] });
  };
  try {
    const report = await gitDetectiveService.analyze({ projectId: 'project-ai-provider', repositoryUrl: 'https://github.com/acme/app', issues: [{ severity: 'CRITICAL', title: 'api stopped', description: 'Stopped', evidence: 'Exit code 1', recommendation: 'Review logs', service: 'api' }], events: [], containers: [], scannedAt: '2026-11-17T10:01:00Z' });
    assert.equal(providerRequest?.url, 'https://mock-provider.invalid/v1/chat/completions');
    assert.equal(providerRequest?.authorization, 'Bearer test-provider-key');
    assert.equal(providerRequest?.body.model, 'test-model');
    assert.equal(report.rootCause?.provider, 'openai · test-model');
    assert.equal(report.rootCause?.problem, 'api stopped');
  } finally {
    githubRepositoryService.history = originalHistory;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = originalBaseUrl;
    if (originalModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = originalModel;
  }
});
