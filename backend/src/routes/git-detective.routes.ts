import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { expensiveDockerReadLimiter } from '../middleware/rate-limiters.js';
import { analyzeGitDetective } from '../controllers/git-detective.controller.js';

export const gitDetectiveRouter = Router({ mergeParams: true });
gitDetectiveRouter.use(requireAuth);
gitDetectiveRouter.post('/analyze', expensiveDockerReadLimiter, analyzeGitDetective);
