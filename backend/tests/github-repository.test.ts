import assert from 'node:assert/strict';
import test from 'node:test';
import { githubRepositoryService, parseGitHubRepositoryUrl } from '../src/services/github-repository.service.js';
import { validateComposeYaml } from '../src/services/compose-validation.service.js';

test('normalizes valid GitHub repository URLs and rejects unsafe or nested URLs', () => {
  assert.deepEqual(parseGitHubRepositoryUrl('https://github.com/Harshil1307/dockerpilot-team/'), { owner: 'Harshil1307', name: 'dockerpilot-team', fullName: 'Harshil1307/dockerpilot-team', url: 'https://github.com/Harshil1307/dockerpilot-team' });
  assert.equal(parseGitHubRepositoryUrl('https://github.com/acme/app.git').fullName, 'acme/app');
  for (const url of ['http://github.com/acme/app', 'https://github.com/acme/app/tree/main', 'https://github.com.evil.test/acme/app', 'https://alice:pw@github.com/acme/app', 'https://github.com/acme/app?x=1']) {
    assert.throws(() => parseGitHubRepositoryUrl(url), { code: 'INVALID_GITHUB_REPOSITORY_URL' });
  }
});

test('verifies public repository metadata and default branch without credentials', async () => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null = null;
  globalThis.fetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get('Authorization');
    return Response.json({ name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'stable', private: false });
  };
  try {
    const metadata = await githubRepositoryService.metadata('https://github.com/acme/app');
    assert.equal(metadata.defaultBranch, 'stable');
    assert.equal(metadata.private, false);
    assert.equal(authorization, null);
  } finally { globalThis.fetch = originalFetch; }
});

test('retrieves bounded commit history, patches, and excludes credential files', async () => {
  const originalFetch = globalThis.fetch;
  githubRepositoryService.clearCache('history-test-project');
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url); requests.push(requestUrl);
    if (requestUrl === 'https://api.github.com/repos/acme/app') return Response.json({ name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main', private: false });
    if (requestUrl.includes('/commits?')) return Response.json([{ sha: 'a'.repeat(40), commit: { message: 'Fix app startup', author: { name: 'Developer', date: '2026-11-17T10:00:00Z' } }, author: { login: 'developer' } }]);
    if (requestUrl.includes('/commits/') && !requestUrl.includes('/commits?')) return Response.json({ html_url: 'https://github.com/acme/app/commit/' + 'a'.repeat(40), commit: { message: 'Fix app startup', author: { name: 'Developer', date: '2026-11-17T10:00:00Z' } }, author: { login: 'developer' }, files: [{ filename: 'src/app.ts', patch: '+throw new Error("bad")' }, { filename: '.env', patch: '+API_KEY=secret-value' }] });
    throw new Error('unexpected URL');
  };
  try {
    const history = await githubRepositoryService.history({ projectId: 'history-test-project', url: 'https://github.com/acme/app', defaultBranch: 'main' });
    assert.equal(history.commits.length, 1);
    assert.deepEqual(history.commits[0]?.changedFiles, ['src/app.ts']);
    assert.match(history.commits[0]?.diff ?? '', /Fix app startup|throw new Error/);
    assert.doesNotMatch(history.commits[0]?.diff ?? '', /secret-value/);
    assert.equal(history.commits[0]?.githubUrl, 'https://github.com/acme/app/commit/' + 'a'.repeat(40));
    const before = requests.length;
    await githubRepositoryService.history({ projectId: 'history-test-project', url: 'https://github.com/acme/app', defaultBranch: 'main' });
    assert.equal(requests.length, before, 'second request should use short-lived project cache');
  } finally { globalThis.fetch = originalFetch; githubRepositoryService.clearCache('history-test-project'); }
});

test('reports GitHub rate limits and outages with safe, actionable errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    await assert.rejects(githubRepositoryService.metadata('https://github.com/acme/app'), { code: 'GITHUB_RATE_LIMITED' });
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    await assert.rejects(githubRepositoryService.metadata('https://github.com/acme/app'), { code: 'GITHUB_API_UNAVAILABLE' });
  } finally { globalThis.fetch = originalFetch; }
});

test('turns a secret-bearing project Compose file into a safe deployable template', async () => {
  const originalFetch = globalThis.fetch;
  const source = `services:\n  postgres:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set a password}\n    ports:\n      - "5432:5432"\n    volumes:\n      - db:/var/lib/postgresql/data\n    healthcheck:\n      test: [CMD-SHELL, pg_isready]\nvolumes:\n  db:\n`;
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl === 'https://api.github.com/repos/acme/app') return Response.json({ name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main', private: false });
    if (requestUrl.endsWith('/contents/docker-compose.yml?ref=main')) return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(source).toString('base64') });
    return new Response('', { status: 404 });
  };
  try {
    const template = await githubRepositoryService.composeTemplate('https://github.com/acme/app');
    assert.equal(template.fileName, 'docker-compose.yml');
    assert.match(template.message, /simple Whoami demo/);
    assert.match(template.content, /traefik\/whoami:v1\.11\.0/);
    assert.doesNotMatch(template.content, /POSTGRES_PASSWORD|volumes:|healthcheck:|postgres:/);
    assert.equal(validateComposeYaml(template.content).valid, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('keeps compatible project services and converts their host ports to loopback automatic ports', async () => {
  const originalFetch = globalThis.fetch;
  const source = 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n';
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl === 'https://api.github.com/repos/acme/app') return Response.json({ name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main', private: false });
    if (requestUrl.endsWith('/contents/compose.yaml?ref=main')) return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(source).toString('base64') });
    return new Response('', { status: 404 });
  };
  try {
    const template = await githubRepositoryService.composeTemplate('https://github.com/acme/app');
    assert.equal(template.fileName, 'compose.yaml');
    assert.match(template.content, /127\.0\.0\.1::80/);
    assert.equal(validateComposeYaml(template.content).valid, true);
  } finally { globalThis.fetch = originalFetch; }
});
