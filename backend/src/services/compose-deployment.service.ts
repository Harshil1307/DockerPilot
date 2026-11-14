import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import { dockerService, type ComposeDeploymentIdentity } from './docker.service.js';
import { composeCleanupService } from './compose-cleanup.service.js';
import { composeDeploymentOwnershipService, generatedComposeProjectName } from './compose-ownership.service.js';
import { MAX_COMPOSE_YAML_BYTES } from './compose-environment.service.js';
import { normalizeValidatedComposeYaml } from './compose-validation.service.js';
import { generatedComposeConfiguration } from './generated-compose.js';
import { requestLocalAgent } from './local-agent-relay.js';

const execFileAsync = promisify(execFile);
const DEPLOYMENT_TIMEOUT_MS = 10 * 60 * 1000;
const inFlightDeployments = new Set<string>();

interface SafeFailure {
  statusCode: number;
  code: string;
  message: string;
}

function getComposeProcessEnvironment(): NodeJS.ProcessEnv {
  const processEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
  };

  if (env.DOCKER_SOCKET_PATH) {
    processEnvironment.DOCKER_HOST = `unix://${env.DOCKER_SOCKET_PATH}`;
  } else if (process.env.DOCKER_HOST) {
    processEnvironment.DOCKER_HOST = process.env.DOCKER_HOST;
  }

  for (const key of ['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (process.env[key]) processEnvironment[key] = process.env[key];
  }
  return processEnvironment;
}

async function runCompose(
  args: string[],
  cwd?: string,
  agentDeployment?: { identity: ComposeDeploymentIdentity; configuration: NonNullable<ReturnType<typeof normalizeValidatedComposeYaml>['configuration']> },
): Promise<string> {
  if (env.DOCKER_CONNECTION_MODE === 'agent') {
    if (args.length === 2 && args[0] === 'version' && args[1] === '--short') {
      return requestLocalAgent<string>('compose.version', {});
    }
    if (agentDeployment && args.includes('up')) {
      await requestLocalAgent('compose.up', agentDeployment, { timeoutMs: DEPLOYMENT_TIMEOUT_MS });
      return '';
    }
    throw new AppError('This Compose command is not available through the local agent.', 403, 'AGENT_OPERATION_NOT_ALLOWED');
  }
  const result = await execFileAsync('docker', ['compose', ...args], {
    cwd,
    env: getComposeProcessEnvironment(),
    encoding: 'utf8',
    timeout: DEPLOYMENT_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

function composeArgs(projectName: string, workingDirectory: string, composeFile: string, command: string[]): string[] {
  return [
    '--project-name', projectName,
    '--project-directory', workingDirectory,
    '--file', composeFile,
    ...command,
  ];
}

function getSafeFailure(error: unknown): SafeFailure {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  if (error instanceof DockerUnavailableError) {
    return { statusCode: 503, code: 'DOCKER_UNAVAILABLE', message: error.message };
  }

  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; stderr?: unknown; killed?: unknown }
    : {};
  const processCode = typeof candidate.code === 'string' ? candidate.code : '';
  const stderr = typeof candidate.stderr === 'string' ? candidate.stderr.toLowerCase() : '';
  if (processCode === 'ENOENT') {
    return { statusCode: 503, code: 'COMPOSE_UNAVAILABLE', message: 'Docker Compose CLI is unavailable. Install or enable Docker Compose in Docker Desktop.' };
  }
  if (candidate.killed === true) {
    return { statusCode: 504, code: 'COMPOSE_DEPLOYMENT_TIMEOUT', message: 'Docker Compose deployment timed out. Check Docker Desktop and the image registry, then retry.' };
  }
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect/.test(stderr)) {
    return { statusCode: 503, code: 'DOCKER_UNAVAILABLE', message: 'DockerPilot’s API cannot reach a Docker Engine. On the hosted site, the API runs on Render and cannot access Docker installed on your computer. To manage your local Docker, run DockerPilot on the same computer as Docker, or add a secure local agent.' };
  }
  if (/port is already allocated|address already in use|bind:.*address/.test(stderr)) {
    return { statusCode: 409, code: 'DEPLOYMENT_PORT_CONFLICT', message: 'A configured localhost port is already in use.' };
  }
  if (/pull access denied|manifest unknown|repository does not exist|failed to resolve reference|toomanyrequests/.test(stderr)) {
    return { statusCode: 502, code: 'IMAGE_PULL_FAILED', message: 'Docker could not pull one or more configured images. Check the image names and registry access.' };
  }
  return { statusCode: 502, code: 'COMPOSE_DEPLOYMENT_FAILED', message: 'Docker Compose deployment failed. Check the Compose status and Docker Desktop, then retry.' };
}

async function findOwnedEnvironment(environmentId: string, userId: string) {
  const environment = await prisma.composeEnvironment.findFirst({
    where: { id: environmentId, project: { is: { userId } } },
  });
  if (!environment) throw new AppError('Compose environment not found.', 404, 'COMPOSE_ENVIRONMENT_NOT_FOUND');
  return environment;
}

function deploymentMetadata(environment: Awaited<ReturnType<typeof findOwnedEnvironment>>) {
  return {
    environmentId: environment.id,
    status: environment.deploymentStatus,
    projectName: environment.deploymentStatus === 'REMOVED' ? null : environment.deploymentProjectName,
    startedAt: environment.deploymentStartedAt,
    completedAt: environment.deploymentCompletedAt,
    lastError: environment.lastDeploymentError,
  };
}

async function updateDeployment(
  environmentId: string,
  userId: string,
  data: {
    deploymentStatus: 'DEPLOYING' | 'RUNNING' | 'FAILED' | 'STOPPED' | 'CLEANING' | 'CLEANUP_FAILED' | 'REMOVED';
    deploymentProjectName?: string | null;
    deploymentContainerIds?: string[];
    deploymentNetworkIds?: string[];
    deploymentRemovedContainerIds?: string[];
    deploymentRemovedNetworkIds?: string[];
    deploymentStartedAt?: Date;
    deploymentCompletedAt?: Date | null;
    lastDeploymentError?: string | null;
  },
): Promise<void> {
  await prisma.composeEnvironment.updateMany({
    where: { id: environmentId, project: { is: { userId } } },
    data,
  });
}

export const composeDeploymentService = {
  async getStatus(environmentId: string, userId: string) {
    let environment = await findOwnedEnvironment(environmentId, userId);
    if (environment.deploymentStatus === 'RUNNING' && environment.deploymentProjectName) {
      try {
        const identity: ComposeDeploymentIdentity = {
          ownerId: userId,
          projectId: environment.projectId,
          environmentId: environment.id,
        composeProjectName: environment.deploymentProjectName,
        };
        const resources = await dockerService.inspectComposeDeployment(identity);
        if (resources.safeToOperate && resources.containerCount > 0 && resources.runningContainerCount === 0) {
          await updateDeployment(environment.id, userId, {
            deploymentStatus: 'STOPPED',
            deploymentCompletedAt: new Date(),
            lastDeploymentError: null,
          });
          environment = await findOwnedEnvironment(environmentId, userId);
        }
      } catch {
        // Report persisted deployment state if Docker Engine is temporarily unavailable.
      }
    }
    return deploymentMetadata(environment);
  },

  async deploy(environmentId: string, userId: string) {
    if (inFlightDeployments.has(environmentId)) {
      throw new AppError('A deployment is already in progress for this environment.', 409, 'DEPLOYMENT_IN_PROGRESS');
    }
    inFlightDeployments.add(environmentId);

    let deploymentAttempted = false;
    let workingDirectory: string | undefined;
    let composeFile: string | undefined;
    let identity: ComposeDeploymentIdentity | undefined;
    let priorStatus: string | undefined;
    let hadRegisteredDeployment = false;

    try {
      const environment = await findOwnedEnvironment(environmentId, userId);
      priorStatus = environment.deploymentStatus;
      hadRegisteredDeployment = environment.deploymentProjectName !== null;
      if (environment.validationStatus !== 'VALID') {
        throw new AppError('Validate this Compose environment successfully before deploying it.', 409, 'COMPOSE_VALIDATION_REQUIRED');
      }
      if (Buffer.byteLength(environment.composeYaml, 'utf8') > MAX_COMPOSE_YAML_BYTES) {
        throw new AppError('Compose YAML must be 64 KB or smaller.', 413, 'COMPOSE_YAML_TOO_LARGE');
      }

      const normalized = normalizeValidatedComposeYaml(environment.composeYaml);
      if (!normalized.validation.valid || !normalized.configuration) {
        await prisma.composeEnvironment.updateMany({
          where: { id: environment.id, project: { is: { userId } } },
          data: { validationStatus: 'INVALID' },
        });
        throw new AppError('The saved Compose configuration is no longer valid. Review its validation errors and validate it again.', 400, 'COMPOSE_INVALID');
      }

      identity = {
        ownerId: userId,
        projectId: environment.projectId,
        environmentId: environment.id,
        composeProjectName: generatedComposeProjectName(environment.id),
      };

      const deploymentStartedAt = new Date();
      const claim = await prisma.composeEnvironment.updateMany({
        where: {
          id: environment.id,
          project: { is: { userId } },
          deploymentStatus: { in: ['NOT_DEPLOYED', 'FAILED', 'STOPPED', 'RUNNING', 'REMOVED'] },
        },
        data: {
          deploymentStatus: 'DEPLOYING',
          deploymentProjectName: identity.composeProjectName,
          deploymentStartedAt,
          deploymentCompletedAt: null,
          lastDeploymentError: null,
          deploymentRemovedContainerIds: [],
          deploymentRemovedNetworkIds: [],
        },
      });
      if (claim.count === 0) {
        throw new AppError('A deployment is already in progress for this environment.', 409, 'DEPLOYMENT_IN_PROGRESS');
      }
      try {
        await composeDeploymentOwnershipService.verify(environment.id, userId);
        await runCompose(['version', '--short']);
        workingDirectory = await mkdtemp(join(tmpdir(), 'dockerpilot-compose-'));
        composeFile = join(workingDirectory, 'compose.yaml');
        const generatedYaml = generatedComposeConfiguration(normalized.configuration, identity);
        await writeFile(composeFile, generatedYaml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

        deploymentAttempted = true;
        await runCompose(composeArgs(identity.composeProjectName, workingDirectory, composeFile, [
          'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '90',
        ]), workingDirectory, { identity, configuration: normalized.configuration });

        const resources = await dockerService.inspectComposeDeployment(identity);
        if (!resources.safeToOperate || resources.containerCount !== normalized.validation.servicesCount
          || resources.runningContainerCount !== resources.containerCount) {
          throw new AppError('Docker Compose did not start every owned service as expected.', 502, 'DEPLOYMENT_VERIFICATION_FAILED');
        }

        const deploymentCompletedAt = new Date();
        await updateDeployment(environment.id, userId, {
          deploymentStatus: 'RUNNING',
          deploymentCompletedAt,
          lastDeploymentError: null,
          deploymentContainerIds: resources.containerIds,
          deploymentNetworkIds: resources.networkIds,
        });
        return {
          environmentId: environment.id,
          status: 'RUNNING' as const,
          projectName: identity.composeProjectName,
          startedAt: deploymentStartedAt,
          completedAt: deploymentCompletedAt,
          servicesCount: resources.containerCount,
        };
      } catch (error) {
        const failure = getSafeFailure(error);
        const ownershipConflict = error instanceof AppError && error.code === 'DEPLOYMENT_OWNERSHIP_CONFLICT';
        if (ownershipConflict && identity) {
          await updateDeployment(environment.id, userId, {
            deploymentStatus: 'CLEANUP_FAILED',
            deploymentCompletedAt: new Date(),
            lastDeploymentError: 'Deployment resources did not pass strict ownership verification; manual review is required.',
          });
        } else if (deploymentAttempted && identity && priorStatus !== 'RUNNING') {
          try {
            const partial = await dockerService.inspectComposeDeployment(identity);
            if (!partial.safeToOperate) throw new AppError('Partial deployment resources failed ownership verification.', 409, 'DEPLOYMENT_OWNERSHIP_CONFLICT');
            await updateDeployment(environment.id, userId, {
              deploymentStatus: 'FAILED',
              deploymentCompletedAt: new Date(),
              lastDeploymentError: failure.message.slice(0, 500),
              deploymentContainerIds: partial.containerIds,
              deploymentNetworkIds: partial.networkIds,
            });
            await composeCleanupService.cleanup(environment.id, userId, true);
          } catch (cleanupError) {
            const safeCleanupFailure = getSafeFailure(cleanupError);
            await updateDeployment(environment.id, userId, {
              deploymentStatus: 'CLEANUP_FAILED',
              deploymentCompletedAt: new Date(),
              lastDeploymentError: safeCleanupFailure.message.slice(0, 500),
            });
          }
        } else {
          await updateDeployment(environment.id, userId, {
            deploymentStatus: 'FAILED',
            deploymentCompletedAt: new Date(),
            lastDeploymentError: failure.message.slice(0, 500),
            ...(identity && !deploymentAttempted && priorStatus !== 'RUNNING' && !hadRegisteredDeployment
              ? { deploymentProjectName: null, deploymentContainerIds: [], deploymentNetworkIds: [] }
              : {}),
          });
        }
        throw new AppError(failure.message, failure.statusCode, failure.code);
      }
    } finally {
      if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
      inFlightDeployments.delete(environmentId);
    }
  },
};
