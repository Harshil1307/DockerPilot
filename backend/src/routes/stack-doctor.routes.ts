import { Router } from 'express';
import { requireAuth } from '../auth/require-auth.js';
import { expensiveDockerReadLimiter } from '../middleware/rate-limiters.js';
import { compareStackDoctorScan, getStackDoctorHistory, runStackDoctorScan } from '../controllers/stack-doctor.controller.js';

export const stackDoctorRouter = Router({ mergeParams: true });
stackDoctorRouter.use(requireAuth);
stackDoctorRouter.get('/', getStackDoctorHistory);
stackDoctorRouter.post('/', expensiveDockerReadLimiter, runStackDoctorScan);
stackDoctorRouter.get('/:scanId/compare', compareStackDoctorScan);
