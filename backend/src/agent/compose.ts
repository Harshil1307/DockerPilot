import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { generatedComposeProjectName } from '../services/compose-ownership.service.js';
import { normalizeValidatedComposeYaml } from '../services/compose-validation.service.js';
import type { ComposeDeploymentIdentity } from '../services/docker.service.js';
import { dockerService } from '../services/docker.service.js';
import { generatedComposeConfiguration } from '../services/generated-compose.js';

const execFileAsync = promisify(execFile);
const MAX_DEPLOYMENT_TIME_MS = 10 * 60 * 1000;
const identitySchema = z.object({
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  composeProjectName: z.string().min(1).max(63),
}).strict();
const approvedServiceSchema = z.object({
  image: z.string().min(1).max(300),
  ports: z.array(z.string().max(128)).max(32).optional(),
  restart: z.enum(['no', 'always', 'on-failure', 'unless-stopped']).optional(),
  depends_on: z.array(z.string().min(1).max(63)).max(100).optional(),
}).strict();
const composePayloadSchema = z.object({
  identity: identitySchema,
  configuration: z.object({
    services: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/), approvedServiceSchema)
      .refine((services) => Object.keys(services).length > 0 && Object.keys(services).length <= 50),
  }).strict(),
}).strict();

function processEnvironment(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
  };
  for (const key of ['DOCKER_HOST', 'DOCKER_SOCKET_PATH', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (process.env[key]) safe[key] = process.env[key];
  }
  if (process.env.DOCKER_SOCKET_PATH && !process.env.DOCKER_HOST) {
    safe.DOCKER_HOST = `unix://${process.env.DOCKER_SOCKET_PATH}`;
  }
  return safe;
}

function safeComposeFailure(error: unknown): AppError {
  const candidate = error && typeof error === 'object' ? error as { code?: unknown; stderr?: unknown; killed?: unknown } : {};
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const stderr = typeof candidate.stderr === 'string' ? candidate.stderr.toLowerCase() : '';
  if (code === 'ENOENT') return new AppError('Docker Compose CLI is unavailable on the agent computer.', 503, 'COMPOSE_UNAVAILABLE');
  if (candidate.killed === true) return new AppError('Docker Compose deployment timed out. Check Docker Desktop and the image registry, then retry.', 504, 'COMPOSE_DEPLOYMENT_TIMEOUT');
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect/.test(stderr)) {
    return new AppError('The local agent cannot reach Docker Desktop.', 503, 'DOCKER_UNAVAILABLE');
  }
  if (/port is already allocated|address already in use|bind:.*address/.test(stderr)) {
    return new AppError('A configured localhost port is already in use.', 409, 'DEPLOYMENT_PORT_CONFLICT');
  }
  if (/pull access denied|manifest unknown|repository does not exist|failed to resolve reference|toomanyrequests/.test(stderr)) {
    return new AppError('Docker could not pull one or more configured images. Check the image names and registry access.', 502, 'IMAGE_PULL_FAILED');
  }
  return new AppError('Docker Compose deployment failed on the agent computer.', 502, 'COMPOSE_DEPLOYMENT_FAILED');
}

export async function localComposeVersion(): Promise<string> {
  try {
    const result = await execFileAsync('docker', ['compose', 'version', '--short'], {
      env: processEnvironment(), encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true,
    });
    return result.stdout.trim().slice(0, 100);
  } catch (error) {
    throw safeComposeFailure(error);
  }
}

export async function deployLocalCompose(payload: unknown, pairedUserId: string): Promise<{ version: string; containers: number; networks: number }> {
  const parsed = composePayloadSchema.safeParse(payload);
  if (!parsed.success) throw new AppError('The hosted API sent an invalid Compose deployment request.', 400, 'INVALID_AGENT_OPERATION');
  const { identity, configuration } = parsed.data as { identity: ComposeDeploymentIdentity; configuration: { services: Record<string, { image: string; ports?: string[]; restart?: string; depends_on?: string[] }> } };
  if (identity.ownerId !== pairedUserId || identity.composeProjectName !== generatedComposeProjectName(identity.environmentId)) {
    throw new AppError('Compose deployment identity does not match this paired agent.', 403, 'AGENT_ACCOUNT_MISMATCH');
  }

  // Re-run the allowlist validator locally so a compromised or misconfigured
  // hosted server cannot use this agent to run arbitrary Compose content.
  const normalized = normalizeValidatedComposeYaml(stringifyYaml(configuration, { lineWidth: 0 }));
  if (!normalized.validation.valid || !normalized.configuration) {
    throw new AppError('Compose configuration did not pass local validation.', 400, 'COMPOSE_INVALID');
  }
  const resourcesBefore = await dockerService.inspectComposeDeployment(identity);
  if (!resourcesBefore.safeToOperate) throw new AppError('Existing Compose resources failed local ownership verification.', 409, 'DEPLOYMENT_OWNERSHIP_CONFLICT');

  const version = await localComposeVersion();
  const directory = await mkdtemp(join(tmpdir(), 'dockerpilot-compose-agent-'));
  try {
    const composeFile = join(directory, 'compose.yaml');
    const generated = generatedComposeConfiguration(normalized.configuration, identity);
    await writeFile(composeFile, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await execFileAsync('docker', [
        'compose', '--project-name', identity.composeProjectName,
        '--project-directory', directory,
        '--file', composeFile,
        'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '90',
      ], {
        cwd: directory,
        env: processEnvironment(),
        encoding: 'utf8',
        timeout: MAX_DEPLOYMENT_TIME_MS,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      throw safeComposeFailure(error);
    }

    const resources = await dockerService.inspectComposeDeployment(identity);
    if (!resources.safeToOperate || resources.containerCount !== Object.keys(normalized.configuration.services).length
      || resources.runningContainerCount !== resources.containerCount) {
      throw new AppError('Docker Compose did not start every locally verified service.', 502, 'DEPLOYMENT_VERIFICATION_FAILED');
    }
    return { version, containers: resources.containerCount, networks: resources.networkIds.length };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
