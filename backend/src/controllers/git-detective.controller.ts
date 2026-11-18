import type { RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { gitDetectiveService } from '../services/git-detective.service.js';
import { composeMonitoringService } from '../services/compose-monitoring.service.js';
import { dockerService } from '../services/docker.service.js';

const uuid = z.string().uuid();

export const analyzeGitDetective: RequestHandler = async (request, response) => {
  const projectId = uuid.safeParse(request.params.projectId);
  if (!projectId.success) throw new AppError('Project ID must be a valid UUID.', 400, 'INVALID_PROJECT_ID');
  const userId = request.userId;
  if (!userId) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');

  const project = await prisma.project.findFirst({ where: { id: projectId.data, userId }, select: { id: true, repositoryUrl: true, repositoryDefaultBranch: true } });
  if (!project) throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');

  const latestScan = await prisma.stackDoctorScan.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, select: { report: true, createdAt: true } });
  const report = latestScan?.report as { issues?: { severity: string; title: string; description: string; evidence: string; recommendation: string; service: string | null }[] } | undefined;
  const environments = await prisma.composeEnvironment.findMany({ where: { projectId: project.id, project: { userId } }, select: { id: true, deploymentStatus: true } });
  const containers: { id: string; serviceName: string | null; name: string | null; state: string; health: string | null; exitCode: number | null; restartCount: number | null; cpuPercent: number | null; memoryPercent: number | null }[] = [];
  for (const environment of environments) {
    if (['NOT_DEPLOYED', 'REMOVED'].includes(environment.deploymentStatus)) continue;
    try {
      const inventory = await composeMonitoringService.getInventory(environment.id, userId);
      containers.push(...inventory.containers.map((container) => ({ id: container.id, serviceName: container.serviceName, name: container.name, state: container.state, health: container.health, exitCode: container.exitCode, restartCount: container.restartCount ?? null, cpuPercent: container.metrics.cpuPercent, memoryPercent: container.metrics.memoryPercent })));
    } catch { /* Git Detective still works from the latest Stack Doctor findings and public commit history. */ }
  }
  const events = await dockerService.getRecentContainerEvents(userId).catch(() => []);
  const analysis = await gitDetectiveService.analyze({
    projectId: project.id,
    repositoryUrl: project.repositoryUrl,
    repositoryDefaultBranch: project.repositoryDefaultBranch,
    issues: report?.issues ?? [],
    events,
    containers,
    scannedAt: latestScan?.createdAt.toISOString() ?? new Date().toISOString(),
  });
  response.status(200).json({ analysis, basedOnScanAt: latestScan?.createdAt.toISOString() ?? null });
};
