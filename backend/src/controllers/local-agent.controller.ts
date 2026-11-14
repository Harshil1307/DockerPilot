import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { localAgentService } from '../services/local-agent.service.js';
import { disconnectLocalAgent, isLocalAgentConnected } from '../services/local-agent-relay.js';

const pairSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Pairing code is invalid.'),
  name: z.string().trim().min(1).max(100).default('DockerPilot on this computer'),
}).strict();

const agentIdSchema = z.string().uuid();

export const createLocalAgentPairingChallenge: RequestHandler = async (request, response) => {
  if (!request.userId) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  response.status(201).json(await localAgentService.createPairingChallenge(request.userId));
};

export const pairLocalAgent: RequestHandler = async (request, response) => {
  const input = pairSchema.parse(request.body);
  response.status(201).json(await localAgentService.pair(input.code, input.name));
};

export const listLocalAgents: RequestHandler = async (request, response) => {
  if (!request.userId) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  const agents = await localAgentService.list(request.userId);
  response.status(200).json({ agents: agents.map((agent) => ({ ...agent, connected: isLocalAgentConnected(agent.id) })) });
};

export const revokeLocalAgent: RequestHandler = async (request, response) => {
  if (!request.userId) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  const parsedId = agentIdSchema.safeParse(request.params.id);
  if (!parsedId.success) throw new AppError('Local agent not found.', 404, 'LOCAL_AGENT_NOT_FOUND');
  await localAgentService.revoke(request.userId, parsedId.data);
  disconnectLocalAgent(parsedId.data);
  response.status(204).send();
};
