import type { Request, Response } from 'express';
import { getHealthStatus } from '../services/health.service.js';
import { prisma } from '../config/prisma.js';

export function getHealth(_request: Request, response: Response): void {
  response.status(200).json(getHealthStatus());
}

export async function getReadiness(_request: Request, response: Response): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.status(200).json({ status: 'ready', service: 'dockerpilot-api' });
  } catch {
    response.status(503).json({ status: 'not_ready', service: 'dockerpilot-api' });
  }
}
