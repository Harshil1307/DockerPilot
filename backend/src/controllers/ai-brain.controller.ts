import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { aiBrainService } from '../services/ai-brain.service.js';

const chatSchema = z.object({ question: z.string().trim().min(1).max(2000), context: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }).strict()).max(8).default([]) }).strict();
const userId = (value: string | undefined) => { if (!value) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED'); return value; };
export const getBrainDashboard: RequestHandler = async (request, response) => response.status(200).json(await aiBrainService.dashboard(userId(request.userId)));
export const postBrainChat: RequestHandler = async (request, response) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) throw new AppError('Enter a question of up to 2,000 characters.', 400, 'INVALID_AI_QUESTION');
  response.status(200).json(await aiBrainService.chat(userId(request.userId), parsed.data.question, parsed.data.context));
};
