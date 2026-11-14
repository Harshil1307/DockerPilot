import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';
import { dockerImageService, dockerNetworkService, dockerService, dockerVolumeService } from '../services/docker.service.js';
import type { ComposeDeploymentIdentity, ComposeDockerResourceType, ContainerControlAction } from '../services/docker.service.js';
import { deployLocalCompose, localComposeVersion } from './compose.js';

const dockerId = z.string().regex(/^(?:[a-f\d]{12}|[a-f\d]{64})$/i);
const identitySchema = z.object({
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  composeProjectName: z.string().min(1).max(63),
}).strict();
const containerListSchema = z.object({ userId: z.string().uuid() }).strict();
const containerIdSchema = z.object({ id: dockerId }).strict();
const tailSchema = z.number().int().refine((value) => [50, 100, 250, 500].includes(value));
const controlSchema = z.object({ id: dockerId, userId: z.string().uuid(), action: z.enum(['start', 'stop', 'restart']), identity: identitySchema.optional() }).strict();
const resourceSchema = z.object({ type: z.enum(['container', 'network']), id: dockerId, identity: identitySchema }).strict();
const composeListSchema = z.object({ identity: identitySchema, containerIds: z.array(dockerId).max(100), networkIds: z.array(dockerId).max(100) }).strict();
const composeIdentityOnlySchema = z.object({ identity: identitySchema }).strict();
const imageIdSchema = z.object({ id: z.string().regex(/^sha256:[a-f\d]{64}$/i) }).strict();
const imagePullSchema = z.object({ reference: z.string().trim().min(1).max(300) }).strict();
const volumeNameSchema = z.object({ name: z.string().min(1).max(255) }).strict();
const networkIdSchema = z.object({ id: dockerId }).strict();
const networkCreateSchema = z.object({ name: z.string().min(1).max(255), internal: z.boolean(), enableIPv6: z.boolean() }).strict();
const networkRemoveSchema = z.object({ id: dockerId, confirmationName: z.string().min(1).max(255) }).strict();

const operationNames = new Set([
  'engine.status', 'engine.diskUsage', 'compose.version', 'compose.up',
  'container.list', 'container.inspect', 'container.stats', 'container.logs', 'container.control',
  'compose.resources.list', 'compose.deployment.inspect', 'compose.resource.inspect', 'compose.resource.remove',
  'compose.container.inspect', 'compose.container.stats', 'compose.container.logs',
  'image.list', 'image.inspect', 'image.pull', 'image.remove',
  'volume.list', 'volume.inspect', 'volume.create', 'volume.remove',
  'network.list', 'network.inspect', 'network.create', 'network.remove',
]);

function assertDeploymentLabels(resource: { labels: Record<string, string>; type: ComposeDockerResourceType; id: string }, identity: ComposeDeploymentIdentity, type: ComposeDockerResourceType, id: string): void {
  const labels = resource.labels;
  if (resource.type !== type || resource.id !== id
    || labels['com.dockerpilot.managed'] !== 'true'
    || labels['com.dockerpilot.owner-id'] !== identity.ownerId
    || labels['com.dockerpilot.project-id'] !== identity.projectId
    || labels['com.dockerpilot.environment-id'] !== identity.environmentId
    || labels['com.docker.compose.project'] !== identity.composeProjectName) {
    throw new AppError('The Docker resource did not pass local ownership verification.', 409, 'DEPLOYMENT_OWNERSHIP_CONFLICT');
  }
}

function safeDockerPilotLabels(labels: Record<string, string>): Record<string, string> {
  const permitted = new Set([
    'com.dockerpilot.managed', 'com.dockerpilot.owner-id', 'com.dockerpilot.project-id',
    'com.dockerpilot.environment-id', 'com.dockerpilot.infrastructure',
    'com.docker.compose.project', 'com.docker.compose.service', 'com.docker.compose.network',
  ]);
  return Object.fromEntries(Object.entries(labels).filter(([key]) => permitted.has(key)));
}

function assertAgentAccount(userId: string, identity?: ComposeDeploymentIdentity): void {
  if (identity && identity.ownerId !== userId) throw new AppError('Agent request account mismatch.', 403, 'AGENT_ACCOUNT_MISMATCH');
}

function decode<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new AppError('The hosted API sent an invalid Docker operation.', 400, 'INVALID_AGENT_OPERATION');
  return parsed.data;
}

export interface AgentProgress {
  (data: unknown): void;
}

export function isAllowedLocalAgentOperation(operation: string): boolean {
  return operationNames.has(operation);
}

export async function executeLocalAgentOperation(operation: string, payload: unknown, progress: AgentProgress, pairedUserId: string): Promise<unknown> {
  switch (operation) {
    case 'compose.version':
      return localComposeVersion();
    case 'compose.up':
      return deployLocalCompose(payload, pairedUserId);
    case 'engine.status':
      return dockerService.getStatus();
    case 'engine.diskUsage':
      return dockerService.getDiskUsage();
    case 'container.list': {
      const { userId } = decode(containerListSchema, payload);
      return dockerService.listContainers(userId);
    }
    case 'container.inspect':
    {
      const details = await dockerService.inspectContainer(decode(containerIdSchema, payload).id);
      return details ? { ...details, labels: safeDockerPilotLabels(details.labels) } : null;
    }
    case 'container.stats':
      return dockerService.getContainerStats(decode(z.object({ id: dockerId, userId: z.string().uuid().optional() }).strict(), payload).id);
    case 'container.logs': {
      const input = decode(z.object({ id: dockerId, tail: tailSchema }).strict(), payload);
      return dockerService.getComposeContainerLogs(input.id, input.tail);
    }
    case 'container.control': {
      const input = decode(controlSchema, payload);
      assertAgentAccount(input.userId, input.identity);
      if (input.identity) {
        const details = await dockerService.inspectContainer(input.id);
        if (!details) throw new AppError('Container not found.', 404, 'CONTAINER_NOT_FOUND');
        assertDeploymentLabels({ type: 'container', id: details.id, labels: details.labels }, input.identity, 'container', input.id);
      }
      return dockerService.controlContainer(input.id, input.userId, input.action as ContainerControlAction);
    }
    case 'compose.resources.list': {
      const input = decode(composeListSchema, payload);
      assertAgentAccount(input.identity.ownerId, input.identity);
      const resources = await dockerService.listComposeDeploymentResources(input.identity, input.containerIds, input.networkIds);
      return resources.map((resource) => ({ ...resource, labels: safeDockerPilotLabels(resource.labels) }));
    }
    case 'compose.deployment.inspect': {
      const { identity } = decode(composeIdentityOnlySchema, payload);
      assertAgentAccount(identity.ownerId, identity);
      return dockerService.inspectComposeDeployment(identity);
    }
    case 'compose.resource.inspect': {
      const input = decode(resourceSchema, payload);
      assertAgentAccount(input.identity.ownerId, input.identity);
      const resource = await dockerService.inspectComposeResource(input.type, input.id);
      if (resource) assertDeploymentLabels(resource, input.identity, input.type, input.id);
      return resource ? { ...resource, labels: safeDockerPilotLabels(resource.labels) } : null;
    }
    case 'compose.resource.remove': {
      const input = decode(resourceSchema, payload);
      assertAgentAccount(input.identity.ownerId, input.identity);
      const resource = await dockerService.inspectComposeResource(input.type, input.id);
      if (!resource) return { removed: false };
      assertDeploymentLabels(resource, input.identity, input.type, input.id);
      if (input.type === 'network' && resource.attachedContainerIds.length > 0) {
        const deployment = await dockerService.listComposeDeploymentResources(input.identity, [], []);
        const registered = new Set(deployment.filter((item) => item.type === 'container').map((item) => item.id));
        if (resource.attachedContainerIds.some((containerId) => !registered.has(containerId))) {
          throw new AppError('A deployment network is shared with an unregistered container and cannot be removed safely.', 409, 'DEPLOYMENT_SHARED_RESOURCE');
        }
      }
      await dockerService.removeComposeResource(input.type, input.id);
      return { removed: true };
    }
    case 'compose.container.inspect':
    {
      const input = decode(z.object({ id: dockerId, identity: identitySchema }).strict(), payload);
      assertAgentAccount(input.identity.ownerId, input.identity);
      const details = await dockerService.inspectComposeContainer(input.id);
      if (!details) return null;
      assertDeploymentLabels({ type: 'container', id: details.id, labels: details.labels }, input.identity, 'container', input.id);
      return { ...details, labels: safeDockerPilotLabels(details.labels) };
    }
    case 'compose.container.stats': {
      const input = decode(z.object({ id: dockerId, identity: identitySchema }).strict(), payload);
      assertAgentAccount(input.identity.ownerId, input.identity);
      const details = await dockerService.inspectComposeContainer(input.id);
      if (!details) throw new AppError('Container not found.', 404, 'CONTAINER_NOT_FOUND');
      assertDeploymentLabels({ type: 'container', id: details.id, labels: details.labels }, input.identity, 'container', input.id);
      return dockerService.getComposeContainerStats(input.id);
    }
    case 'compose.container.logs': {
      const input = decode(z.object({ id: dockerId, tail: tailSchema, identity: identitySchema }).strict(), payload);
      assertAgentAccount(input.identity.ownerId, input.identity);
      const details = await dockerService.inspectComposeContainer(input.id);
      if (!details) throw new AppError('Container not found.', 404, 'CONTAINER_NOT_FOUND');
      assertDeploymentLabels({ type: 'container', id: details.id, labels: details.labels }, input.identity, 'container', input.id);
      return dockerService.getComposeContainerLogs(input.id, input.tail);
    }
    case 'image.list':
      return dockerImageService.listImages();
    case 'image.inspect':
      return dockerImageService.inspectImage(decode(imageIdSchema, payload).id);
    case 'image.pull': {
      const { reference } = decode(imagePullSchema, payload);
      const pull = dockerImageService.beginPull(reference);
      await pull.run(progress as (value: Parameters<Parameters<typeof pull.run>[0]>[0]) => void);
      return { reference: pull.reference };
    }
    case 'image.remove':
      await dockerImageService.removeImage(decode(imageIdSchema, payload).id);
      return { removed: true };
    case 'volume.list':
      return dockerVolumeService.listVolumes();
    case 'volume.inspect':
      return dockerVolumeService.inspectVolume(decode(volumeNameSchema, payload).name);
    case 'volume.create':
      return dockerVolumeService.createVolume(decode(volumeNameSchema, payload).name);
    case 'volume.remove': {
      const input = decode(z.object({ name: z.string().min(1).max(255), confirmation: z.string().min(1).max(255) }).strict(), payload);
      await dockerVolumeService.removeVolume(input.name, input.confirmation);
      return { removed: true };
    }
    case 'network.list':
      return dockerNetworkService.listNetworks();
    case 'network.inspect':
      return dockerNetworkService.inspectNetwork(decode(networkIdSchema, payload).id);
    case 'network.create': {
      const input = decode(networkCreateSchema, payload);
      return dockerNetworkService.createNetwork(input.name, input);
    }
    case 'network.remove': {
      const input = decode(networkRemoveSchema, payload);
      await dockerNetworkService.removeNetwork(input.id, input.confirmationName);
      return { removed: true };
    }
    default:
      throw new AppError('This Docker operation is not available through the local agent.', 403, 'AGENT_OPERATION_NOT_ALLOWED');
  }
}

export function safeAgentError(error: unknown): { message: string; statusCode: number; code: string } {
  if (error instanceof AppError) return { message: error.message.slice(0, 500), statusCode: error.statusCode, code: error.code };
  if (error instanceof DockerUnavailableError) return { message: error.message.slice(0, 500), statusCode: 503, code: 'DOCKER_UNAVAILABLE' };
  return { message: 'The local Docker agent could not complete the request.', statusCode: 502, code: 'LOCAL_AGENT_OPERATION_FAILED' };
}
