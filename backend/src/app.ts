import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { originGuard } from './middleware/origin-guard.js';
import { healthRouter } from './routes/health.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { dockerRouter } from './routes/docker.routes.js';
import { projectRouter } from './routes/project.routes.js';
import { composeEnvironmentRouter, projectComposeRouter } from './routes/compose.routes.js';
import { activityRouter } from './routes/activity.routes.js';
import { corsOptions } from './config/cors.js';

export const AUTH_API_PREFIX = '/api/auth';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use(helmet());
app.use(cors(corsOptions));
app.use(originGuard);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use((request, _response, next) => {
  console.info(`[api] ${request.method} ${request.path}`);
  next();
});
app.use('/api/health', healthRouter);
app.use(AUTH_API_PREFIX, authRouter);
app.use('/api/activity', activityRouter);
app.use('/api/docker', dockerRouter);
app.use('/api/projects', projectRouter);
app.use('/api/projects/:projectId/compose', projectComposeRouter);
app.use('/api/compose', composeEnvironmentRouter);
app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});
app.use(errorHandler);
