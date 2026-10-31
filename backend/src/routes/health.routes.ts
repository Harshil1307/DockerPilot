import { Router } from 'express';
import { getHealth, getReadiness } from '../controllers/health.controller.js';

export const healthRouter = Router();
healthRouter.get('/', getHealth);
healthRouter.get('/ready', getReadiness);
