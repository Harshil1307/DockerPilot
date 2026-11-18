import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { expensiveDockerReadLimiter } from '../middleware/rate-limiters.js';
import { getBrainDashboard, postBrainChat } from '../controllers/ai-brain.controller.js';

export const aiBrainRouter = Router();
aiBrainRouter.use(requireAuth);
aiBrainRouter.get('/', expensiveDockerReadLimiter, getBrainDashboard);
aiBrainRouter.post('/chat', expensiveDockerReadLimiter, postBrainChat);
