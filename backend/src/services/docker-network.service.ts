import { AppError } from '../errors/app-error.js';
import { DockerUnavailableError } from '../errors/docker-unavailable-error.js';

const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const NETWORK_ID = /^[a-f\d]{64}$/i;
const INFRASTRUCTURE_LABEL = 'com.dockerpilot.infrastructure';
const SAFE_LABELS = new Set(['com.docker.compose.project', 'com.dockerpilot.managed', INFRASTRUCTURE_LABEL]);

export interface DockerNetworkContainerReference {
  id: string;
  name: string;
  state: string | null;
  networkIds: string[];
}

export interface DockerNetworkRecord {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  enableIPv6: boolean;
  createdAt?: string | null;
  labels?: Record<string, string>;
  subnets?: { subnet: string | null; gateway: string | null }[];
}

export interface DockerNetworkClient {
  listNetworks(): Promise<DockerNetworkRecord[]>;
  inspectNetwork(id: string): Promise<DockerNetworkRecord>;
  listContainers(): Promise<DockerNetworkContainerReference[]>;
  supportsIPv6(): Promise<boolean>;
  createNetwork(name: string, options: { internal: boolean; enableIPv6: boolean }): Promise<DockerNetworkRecord>;
  removeNetwork(id: string): Promise<void>;
}

export interface DockerNetworkSummary extends DockerNetworkRecord {
  shortId: string;
  createdAt: string | null;
  labels: Record<string, string>;
  containerCount: number;
  protected: boolean;
}

export interface DockerNetworkDetails extends DockerNetworkSummary {
  containers: { id: string; name: string; state: string | null }[];
}

export function validateDockerNetworkName(input: unknown): string {
  if (typeof input !== 'string' || !NETWORK_NAME.test(input)) {
    throw new AppError('Use a network name starting with a letter or number and containing only letters, numbers, dots, underscores, or hyphens (up to 255 characters).', 400, 'INVALID_NETWORK_NAME');
  }
  return input;
}

function validateNetworkId(input: unknown): string {
  if (typeof input !== 'string' || !NETWORK_ID.test(input)) {
    throw new AppError('A full Docker network ID is required.', 400, 'INVALID_NETWORK_ID');
  }
  return input;
}

function errorInfo(error: unknown): { statusCode?: number; code?: string; message?: string } {
  if (!error || typeof error !== 'object') return {};
  const value = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  return {
    statusCode: typeof value.statusCode === 'number' ? value.statusCode : undefined,
    code: typeof value.code === 'string' ? value.code : undefined,
    message: typeof value.message === 'string' ? value.message.slice(0, 300) : undefined,
  };
}

function translateNetworkError(error: unknown, operation: 'read' | 'create' | 'remove'): Error {
  if (error instanceof AppError || error instanceof DockerUnavailableError) return error;
  const { statusCode, code, message = '' } = errorInfo(error);
  if (statusCode === 404) return new AppError('The selected Docker network was not found.', 404, 'NETWORK_NOT_FOUND');
  if (statusCode === 409) return new AppError(operation === 'create'
    ? 'A Docker network with this name already exists.'
    : 'Docker reports that this network is still in use. Inspect its attached containers and try again.', 409,
  operation === 'create' ? 'NETWORK_ALREADY_EXISTS' : 'NETWORK_IN_USE');
  if (statusCode === 503 || ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPIPE', 'ETIMEDOUT'].includes(code ?? '')) {
    return new DockerUnavailableError();
  }
  if (operation === 'create' && /ipv6|ipv.?6|unsupported.*network|not supported/i.test(message)) {
    return new AppError('This Docker Engine does not support the requested network configuration.', 400, 'NETWORK_CONFIGURATION_UNSUPPORTED');
  }
  return new AppError(operation === 'create'
    ? 'Docker Engine could not create this network. Check the name and network settings.'
    : operation === 'remove' ? 'Docker Engine could not safely remove this network.' : 'Docker Engine could not read network details.',
  502, 'NETWORK_OPERATION_FAILED');
}

function safeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => SAFE_LABELS.has(key)));
}

function isProtected(network: DockerNetworkRecord, labels: Record<string, string>): boolean {
  return ['bridge', 'host', 'none'].includes(network.name.toLowerCase())
    || labels[INFRASTRUCTURE_LABEL] === 'true'
    || labels['com.docker.compose.project']?.toLowerCase() === 'dockerpilot'
    || /^dockerpilot(?:[-_].*)?$/i.test(network.name);
}

function attachedContainers(network: DockerNetworkRecord, containers: DockerNetworkContainerReference[]) {
  const id = network.id.toLowerCase();
  return containers.filter((container) => container.networkIds.some((networkId) => networkId.toLowerCase() === id));
}

function summary(network: DockerNetworkRecord, containers: DockerNetworkContainerReference[]): DockerNetworkSummary {
  const labels = safeLabels(network.labels);
  return {
    id: network.id,
    shortId: network.id.slice(0, 12),
    name: network.name,
    driver: network.driver,
    scope: network.scope,
    internal: network.internal,
    enableIPv6: network.enableIPv6,
    createdAt: network.createdAt && Number.isFinite(Date.parse(network.createdAt)) ? new Date(network.createdAt).toISOString() : null,
    labels,
    subnets: (network.subnets ?? []).map(({ subnet, gateway }) => ({ subnet, gateway })),
    containerCount: attachedContainers(network, containers).length,
    protected: isProtected(network, labels),
  };
}

export function createDockerNetworkService(client: DockerNetworkClient) {
  const creating = new Set<string>();

  async function inventory() {
    try {
      const [networks, containers, ipv6Supported] = await Promise.all([
        client.listNetworks(), client.listContainers(), client.supportsIPv6(),
      ]);
      return { networks, containers, ipv6Supported };
    } catch (error) {
      throw translateNetworkError(error, 'read');
    }
  }

  return {
    async listNetworks(): Promise<{ networks: DockerNetworkSummary[]; ipv6Supported: boolean }> {
      const { networks, containers, ipv6Supported } = await inventory();
      return {
        networks: networks.map((network) => summary(network, containers)).sort((a, b) => a.name.localeCompare(b.name)),
        ipv6Supported,
      };
    },

    async inspectNetwork(input: unknown): Promise<DockerNetworkDetails> {
      const id = validateNetworkId(input);
      try {
        const [network, containers] = await Promise.all([client.inspectNetwork(id), client.listContainers()]);
        if (network.id.toLowerCase() !== id.toLowerCase()) {
          throw new AppError('The selected network changed during inspection. Refresh the inventory and select it again.', 409, 'NETWORK_IDENTITY_CHANGED');
        }
        return {
          ...summary(network, containers),
          containers: attachedContainers(network, containers)
            .map(({ id: containerId, name, state }) => ({ id: containerId, name, state }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      } catch (error) {
        throw translateNetworkError(error, 'read');
      }
    },

    async createNetwork(input: unknown, options: { internal?: unknown; enableIPv6?: unknown } = {}): Promise<DockerNetworkSummary> {
      const name = validateDockerNetworkName(input);
      const internal = options.internal ?? false;
      const enableIPv6 = options.enableIPv6 ?? false;
      if (typeof internal !== 'boolean' || typeof enableIPv6 !== 'boolean') {
        throw new AppError('Internal and IPv6 settings must be true or false.', 400, 'INVALID_NETWORK_CONFIGURATION');
      }
      if (creating.has(name)) throw new AppError('A request to create this network is already in progress.', 409, 'NETWORK_CREATE_IN_PROGRESS');
      creating.add(name);
      try {
        const { networks, containers, ipv6Supported } = await inventory();
        if (networks.some((network) => network.name === name)) {
          throw new AppError('A Docker network with this name already exists.', 409, 'NETWORK_ALREADY_EXISTS');
        }
        if (enableIPv6 && !ipv6Supported) {
          throw new AppError('IPv6 network creation is unavailable in the current Docker Engine.', 400, 'NETWORK_IPV6_UNSUPPORTED');
        }
        const network = await client.createNetwork(name, { internal, enableIPv6 });
        return summary(network, containers);
      } catch (error) {
        throw translateNetworkError(error, 'create');
      } finally {
        creating.delete(name);
      }
    },

    async removeNetwork(input: unknown, confirmationName: unknown): Promise<void> {
      const id = validateNetworkId(input);
      if (typeof confirmationName !== 'string') {
        throw new AppError('Confirm removal by providing the exact network name.', 400, 'NETWORK_CONFIRMATION_REQUIRED');
      }
      try {
        // Reinspect the full ID immediately before deletion; never resolve deletion by name.
        const [network, containers] = await Promise.all([client.inspectNetwork(id), client.listContainers()]);
        if (network.id.toLowerCase() !== id.toLowerCase()) {
          throw new AppError('The selected network changed during removal. Refresh the inventory and select it again.', 409, 'NETWORK_IDENTITY_CHANGED');
        }
        if (network.name !== confirmationName) {
          throw new AppError('Confirm removal by providing the exact selected network name.', 400, 'NETWORK_CONFIRMATION_REQUIRED');
        }
        const details = summary(network, containers);
        if (details.protected) throw new AppError('DockerPilot and Docker system networks are protected and cannot be removed.', 403, 'NETWORK_PROTECTED');
        const connected = attachedContainers(network, containers);
        if (connected.length) {
          const preview = connected.slice(0, 5).map((container) => container.name).join(', ');
          const suffix = connected.length > 5 ? `, and ${connected.length - 5} more` : '';
          throw new AppError(`This network has ${connected.length} connected container${connected.length === 1 ? '' : 's'}: ${preview}${suffix}. Disconnect or remove them yourself before retrying.`, 409, 'NETWORK_IN_USE');
        }
        await client.removeNetwork(network.id);
      } catch (error) {
        throw translateNetworkError(error, 'remove');
      }
    },
  };
}
