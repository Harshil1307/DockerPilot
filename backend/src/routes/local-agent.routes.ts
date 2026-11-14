import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { pairLocalAgent, createLocalAgentPairingChallenge, listLocalAgents, revokeLocalAgent } from '../controllers/local-agent.controller.js';
import { createRateLimiter } from '../middleware/rate-limiters.js';

const pairingRequestLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many agent pairing requests. Try again later.');
const pairingCodeLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many pairing attempts. Try again later.');

export const localAgentRouter = Router();

localAgentRouter.post('/pair', pairingCodeLimiter, pairLocalAgent);
localAgentRouter.use(requireAuth);
localAgentRouter.post('/pairing-challenges', pairingRequestLimiter, createLocalAgentPairingChallenge);
localAgentRouter.get('/', listLocalAgents);
localAgentRouter.delete('/:id', revokeLocalAgent);
