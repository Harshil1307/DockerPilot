import { AppError } from '../errors/app-error.js';
import { redactGitText } from '../agent/git-repository.js';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { validateComposeYaml } from './compose-validation.service.js';

const API = 'https://api.github.com';
const HISTORY_TTL_MS = 10 * 60 * 1000;
const historyCache = new Map<string, { expiresAt: number; value: GitHubHistory }>();
const privatePath = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|tfvars)|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?[^/]*|\.npmrc|\.pypirc|\.netrc|\.docker\/config\.json|\.aws\/credentials|\.kube\/config)$/i;
const GENERAL_COMPOSE = `services:\n  web:\n    image: traefik/whoami:v1.11.0\n    ports:\n      - "127.0.0.1::80"\n    restart: unless-stopped\n`;

export interface GitHubRepositoryIdentity { owner: string; name: string; fullName: string; url: string }
export interface GitHubRepositoryMetadata extends GitHubRepositoryIdentity { defaultBranch: string; private: boolean }
export interface GitHubHistory {
  repository: string; branch: string; commits: {
    hash: string; author: string; committedAt: string; message: string; changedFiles: string[]; diff: string; githubUrl: string | null;
  }[];
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryIdentity {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError('Enter a valid GitHub repository URL.', 400, 'INVALID_GITHUB_REPOSITORY_URL'); }
  const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash || parts.length !== 2
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(parts[0]!) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(parts[1]!)) {
    throw new AppError('Use a repository URL in the form https://github.com/owner/repository.', 400, 'INVALID_GITHUB_REPOSITORY_URL');
  }
  const [owner, name] = parts;
  return { owner: owner!, name: name!, fullName: `${owner}/${name}`, url: `https://github.com/${owner}/${name}` };
}

function safeGitHubError(status: number, response: Response): AppError {
  if (status === 403 && response.headers.get('x-ratelimit-remaining') === '0') return new AppError('GitHub API rate limit reached. Wait for the limit to reset, then retry the scan.', 429, 'GITHUB_RATE_LIMITED');
  if (status === 403) return new AppError('GitHub denied the public repository request. Try again later.', 403, 'GITHUB_ACCESS_DENIED');
  if (status === 404) return new AppError('Public GitHub repository was not found. Confirm the repository URL and that it is public.', 404, 'GITHUB_REPOSITORY_NOT_FOUND');
  if (status === 429) return new AppError('GitHub API rate limit reached. Retry later.', 429, 'GITHUB_RATE_LIMITED');
  return new AppError('GitHub could not complete the repository request. Docker diagnosis is still available.', 502, 'GITHUB_API_UNAVAILABLE');
}

function withAutomaticLoopbackPorts(content: string): { content: string; simplified: boolean } {
  try {
    const document = parseDocument(content, { uniqueKeys: true, stringKeys: true, prettyErrors: false, logLevel: 'silent' });
    if (document.errors.length) return { content: GENERAL_COMPOSE, simplified: true };
    const input = document.toJS({ maxAliasCount: 0 }) as { services?: Record<string, Record<string, unknown>> };
    const services: Record<string, Record<string, unknown>> = {};
    let simplified = Object.keys(input).some((key) => key !== 'services');
    for (const [name, raw] of Object.entries(input.services ?? {})) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { simplified = true; continue; }
      const image = raw.image;
      const isDatabase = /(?:postgres|mysql|mariadb|mongo|redis|rabbitmq|kafka|elasticsearch|memcached)/i.test(`${name} ${typeof image === 'string' ? image : ''}`);
      const requiresUnsupportedRuntime = ['build', 'environment', 'env_file', 'secrets', 'volumes', 'configs'].some((field) => Object.hasOwn(raw, field));
      if (typeof image !== 'string' || requiresUnsupportedRuntime || isDatabase) { simplified = true; continue; }
      const service: Record<string, unknown> = { image };
      if (typeof raw.restart === 'string') service.restart = raw.restart;
      if (Array.isArray(raw.ports)) {
        const ports = raw.ports.flatMap((value) => {
          if (typeof value === 'number') value = String(value);
          if (typeof value !== 'string') return [];
          const [portText, protocol] = value.trim().split('/');
          const pieces = portText!.split(':');
          const target = pieces.at(-1);
          if (pieces.length > 3 || !/^\d+$/.test(target ?? '') || Number(target) < 1 || Number(target) > 65535) return [];
          if (protocol && !['tcp', 'udp'].includes(protocol)) return [];
          if (protocol === 'udp') return [];
          return [`127.0.0.1::${target}`];
        });
        if (ports.length) service.ports = ports;
      }
      if (Array.isArray(raw.depends_on)) service.depends_on = raw.depends_on.filter((dependency): dependency is string => typeof dependency === 'string');
      if (Object.keys(raw).some((key) => !['image', 'restart', 'ports', 'depends_on'].includes(key))) simplified = true;
      services[name] = service;
    }
    for (const service of Object.values(services)) if (Array.isArray(service.depends_on)) service.depends_on = service.depends_on.filter((dependency) => Object.hasOwn(services, dependency));
    const candidate = Object.keys(services).length ? stringifyYaml({ services }, { lineWidth: 0 }) : GENERAL_COMPOSE;
    if (!validateComposeYaml(candidate).valid) return { content: GENERAL_COMPOSE, simplified: true };
    return { content: candidate, simplified: simplified || !Object.keys(services).length };
  } catch { return { content: GENERAL_COMPOSE, simplified: true }; }
}

async function githubFetch<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'DockerPilot-Stack-Doctor' }, signal: AbortSignal.timeout(12_000) });
  } catch { throw new AppError('GitHub could not be reached. Docker diagnosis is still available.', 502, 'GITHUB_API_UNAVAILABLE'); }
  if (!response.ok) { await response.body?.cancel(); throw safeGitHubError(response.status, response); }
  const maxBytes = 1_500_000;
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) { await response.body?.cancel(); throw new AppError('GitHub response exceeded the Stack Doctor size limit.', 502, 'GITHUB_RESPONSE_TOO_LARGE'); }
  try {
    if (!response.body) throw new Error('missing response body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new AppError('GitHub response exceeded the Stack Doctor size limit.', 502, 'GITHUB_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('GitHub returned an unreadable repository response.', 502, 'GITHUB_INVALID_RESPONSE');
  }
}

export const githubRepositoryService = {
  parseUrl: parseGitHubRepositoryUrl,
  async metadata(url: string): Promise<GitHubRepositoryMetadata> {
    const identity = parseGitHubRepositoryUrl(url);
    const response = await githubFetch<{ name?: unknown; full_name?: unknown; owner?: { login?: unknown }; default_branch?: unknown; private?: unknown }>(`${API}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}`);
    if (typeof response.default_branch !== 'string' || typeof response.name !== 'string' || typeof response.owner?.login !== 'string') throw new AppError('GitHub returned incomplete repository metadata.', 502, 'GITHUB_INVALID_RESPONSE');
    if (response.private === true) throw new AppError('Git Detective supports public GitHub repositories only.', 403, 'GITHUB_PUBLIC_REPOSITORIES_ONLY');
    return { owner: response.owner.login, name: response.name, fullName: `${response.owner.login}/${response.name}`, url: `https://github.com/${response.owner.login}/${response.name}`, defaultBranch: response.default_branch, private: response.private === true };
  },
  async composeTemplate(url: string): Promise<{ fileName: string | null; content: string; message: string }> {
    const identity = parseGitHubRepositoryUrl(url);
    const branch = (await this.metadata(url)).defaultBranch;
    const candidates = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
    for (const fileName of candidates) {
      const endpoint = `${API}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}/contents/${fileName}?ref=${encodeURIComponent(branch)}`;
      try {
        const file = await githubFetch<{ type?: unknown; encoding?: unknown; content?: unknown }>(endpoint);
        if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') continue;
        const decoded = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
        if (decoded.byteLength > 64 * 1024) throw new AppError('The repository Compose file exceeds the 64 KB limit.', 413, 'COMPOSE_YAML_TOO_LARGE');
        const result = withAutomaticLoopbackPorts(decoded.toString('utf8'));
        return result.simplified
          ? { fileName, content: result.content, message: 'The repository Compose file uses build, secret, database, or other unsupported settings. DockerPilot loaded a simple Whoami demo instead. It shows basic request and container details. Use published images and supported fields to configure your own stack.' }
          : { fileName, content: result.content, message: `Loaded ${fileName} from the repository. Host ports are assigned automatically when deployed.` };
      } catch (error) {
        if (error instanceof AppError && error.code === 'GITHUB_REPOSITORY_NOT_FOUND') continue;
        throw error;
      }
    }
    return { fileName: null, content: GENERAL_COMPOSE, message: 'No deployable root Compose file was found in the repository. DockerPilot loaded a simple Whoami demo that shows basic request and container details; replace it with a stack that uses published images and supported fields.' };
  },
  generalComposeTemplate() { return GENERAL_COMPOSE; },
  async history(input: { projectId: string; url: string }): Promise<GitHubHistory> {
    const cacheKey = input.projectId;
    const cached = historyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const identity = parseGitHubRepositoryUrl(input.url);
    const repositoryUrl = `${API}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}`;
    const branch = (await githubRepositoryService.metadata(input.url)).defaultBranch;
    const commits = await githubFetch<{ sha?: string; html_url?: string; commit?: { message?: string; author?: { name?: string; date?: string } }; author?: { login?: string } }[]>(`${repositoryUrl}/commits?per_page=8&sha=${encodeURIComponent(branch)}` );
    const expanded = await Promise.all(commits.slice(0, 5).map(async (item) => {
      if (typeof item.sha !== 'string') return null;
      try {
        const detail = await githubFetch<{ files?: { filename?: string; patch?: string }[]; commit?: { message?: string; author?: { name?: string; date?: string } }; author?: { login?: string }; html_url?: string }>(`${repositoryUrl}/commits/${encodeURIComponent(item.sha)}` );
        const files = (detail.files ?? []).filter((file) => typeof file.filename === 'string' && !privatePath.test(file.filename)).slice(0, 30);
        const diff = files.map((file) => `--- ${file.filename}\n${file.patch ?? '[Binary or oversized change: diff unavailable]'}`).join('\n').slice(0, 12_000);
        return { hash: item.sha, author: redactGitText(detail.author?.login ?? detail.commit?.author?.name ?? 'Unknown', 120), committedAt: detail.commit?.author?.date ?? '', message: redactGitText(detail.commit?.message ?? '', 300), changedFiles: files.map((file) => redactGitText(file.filename ?? '', 240)), diff: redactGitText(diff, 12_000), githubUrl: typeof detail.html_url === 'string' ? `https://github.com/${identity.fullName}/commit/${item.sha}` : null };
      } catch (error) {
        if (error instanceof AppError && ['GITHUB_RATE_LIMITED', 'GITHUB_ACCESS_DENIED', 'GITHUB_REPOSITORY_NOT_FOUND'].includes(error.code)) throw error;
        return { hash: item.sha, author: redactGitText(item.author?.login ?? item.commit?.author?.name ?? 'Unknown', 120), committedAt: item.commit?.author?.date ?? '', message: redactGitText(item.commit?.message ?? '', 300), changedFiles: [], diff: '', githubUrl: `https://github.com/${identity.fullName}/commit/${item.sha}` };
      }
    }));
    const summaries = commits.slice(5, 8).flatMap((item) => typeof item.sha === 'string' ? [{ hash: item.sha, author: redactGitText(item.author?.login ?? item.commit?.author?.name ?? 'Unknown', 120), committedAt: item.commit?.author?.date ?? '', message: redactGitText(item.commit?.message ?? '', 300), changedFiles: [], diff: '', githubUrl: `https://github.com/${identity.fullName}/commit/${item.sha}` }] : []);
    const result = { repository: identity.fullName, branch, commits: [...expanded.filter((item): item is NonNullable<typeof item> => item !== null), ...summaries] };
    historyCache.set(cacheKey, { value: result, expiresAt: Date.now() + HISTORY_TTL_MS });
    for (const [key, value] of historyCache) if (value.expiresAt <= Date.now()) historyCache.delete(key);
    while (historyCache.size > 500) historyCache.delete(historyCache.keys().next().value!);
    return result;
  },
  clearCache(projectId: string) { historyCache.delete(projectId); },
};
