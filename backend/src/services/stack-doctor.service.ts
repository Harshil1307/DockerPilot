import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { composeMonitoringService } from './compose-monitoring.service.js';
import { analyzeComposeConfiguration, scoreDoctorReport, type DoctorIssue, type DoctorReport } from './stack-doctor-analysis.js';

const activeScans = new Set<string>();
const redact = (value: string) => value
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  .replace(/(password|passwd|secret|token|api[_-]?key|authorization|credential)(\s*[=:]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
  .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]');

function logIssues(environmentId: string, service: string | null, lines: { text: string }[]): DoctorIssue[] {
  const patterns: [RegExp, string, string, string][] = [
    [/ECONNREFUSED|connection refused/i, 'Application connection refused', 'A required service or endpoint refused a connection.', 'Verify the target service is running, its address is correct, and startup ordering is configured.'],
    [/permission denied|EACCES/i, 'Permission error in container logs', 'The process lacks permission to access a file or resource.', 'Check the container user and mounted file ownership; grant only the required access.'],
    [/missing required environment|environment variable .* (?:not set|required)|undefined environment/i, 'Required configuration appears to be missing', 'The application reports that required configuration is unavailable.', 'Configure the required value through a secret-safe environment mechanism, then redeploy.'],
    [/fatal|panic:|uncaught exception|failed to start|startup failed/i, 'Application startup error', 'Recent logs contain a startup or fatal error.', 'Review the nearby application log lines and correct the underlying configuration or application issue.'],
  ];
  const text = lines.map((line) => redact(line.text)).join('\n').slice(-12_000);
  return patterns.filter(([pattern]) => pattern.test(text)).map(([pattern, title, description, recommendation]) => ({
    key: `${environmentId}:${service ?? 'container'}:log:${title}`, severity: 'WARNING', title, description,
    whyItMatters: 'This can prevent the service from responding correctly.', recommendation,
    evidence: redact(text.split('\n').filter((line) => pattern.test(line)).slice(-3).join('\n')).slice(0, 1200), service,
  }));
}

export const stackDoctorService = {
  async history(projectId: string, userId: string) {
    await ensureOwnedProject(projectId, userId);
    return prisma.stackDoctorScan.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, report: true, createdAt: true } });
  },

  async compare(projectId: string, userId: string, scanId: string) {
    await ensureOwnedProject(projectId, userId);
    const scans = await prisma.stackDoctorScan.findMany({ where: { projectId, id: { in: [scanId] } }, select: { id: true, report: true, createdAt: true } });
    const current = scans[0];
    if (!current) throw new AppError('Scan report not found.', 404, 'SCAN_NOT_FOUND');
    const previous = await prisma.stackDoctorScan.findFirst({ where: { projectId, createdAt: { lt: current.createdAt } }, orderBy: { createdAt: 'desc' }, select: { id: true, report: true, createdAt: true } });
    const currentReport = current.report as unknown as DoctorReport;
    const previousReport = previous?.report as unknown as DoctorReport | undefined;
    const before = new Set(previousReport?.issues.map((issue) => issue.key) ?? []);
    const after = new Set(currentReport.issues.map((issue) => issue.key));
    return { current, previous, resolved: [...before].filter((key) => !after.has(key)), outstanding: [...after].filter((key) => before.has(key)), newIssues: [...after].filter((key) => !before.has(key)) };
  },

  async scan(projectId: string, userId: string): Promise<DoctorReport> {
    if (activeScans.has(projectId)) throw new AppError('A Stack Doctor scan is already running for this project.', 409, 'SCAN_IN_PROGRESS');
    activeScans.add(projectId);
    try {
      await ensureOwnedProject(projectId, userId);
      const environments = await prisma.composeEnvironment.findMany({ where: { projectId, project: { userId } }, select: { id: true, name: true, composeYaml: true, deploymentStatus: true } });
      const issues: DoctorIssue[] = [];
      const dockerContainers: { id: string; serviceName: string | null; name: string | null; state: string; health: string | null; exitCode: number | null; restartCount: number | null; cpuPercent: number | null; memoryPercent: number | null }[] = [];
      let checksPerformed = 0;
      if (environments.length === 0) issues.push({ key: `${projectId}:no-compose`, severity: 'INFORMATIONAL', title: 'No Compose environments are registered', description: 'There are no saved stack configurations to inspect for this project.', whyItMatters: 'Stack Doctor can only analyze Compose files and deployments registered in this project.', recommendation: 'Add a Compose environment to include configuration and runtime checks in future scans.', evidence: 'No Compose environments were found for this project.', service: null });
      for (const environment of environments) {
        checksPerformed += 2;
        issues.push(...analyzeComposeConfiguration({ id: environment.id, name: environment.name, yaml: environment.composeYaml }));
        if (environment.deploymentStatus === 'NOT_DEPLOYED' || environment.deploymentStatus === 'REMOVED') continue;
        try {
          const inventory = await composeMonitoringService.getInventory(environment.id, userId);
          dockerContainers.push(...inventory.containers.map((container) => ({ id: container.id, serviceName: container.serviceName, name: container.name, state: container.state, health: container.health, exitCode: container.exitCode, restartCount: container.restartCount ?? null, cpuPercent: container.metrics.cpuPercent, memoryPercent: container.metrics.memoryPercent })));
          checksPerformed += inventory.containers.length * 8;
          for (const container of inventory.containers) {
            const target = container.serviceName ?? container.name ?? container.id.slice(0, 12);
            if ((container.restartCount ?? 0) >= 5) issues.push({ key: `${environment.id}:${container.id}:restarts`, severity: 'WARNING', title: `${target} has restarted repeatedly`, description: `Docker reports ${container.restartCount} prior restarts.`, whyItMatters: 'Repeated restarts often indicate a crash loop or unstable configuration.', recommendation: 'Inspect recent logs and the container exit behavior before restarting or changing configuration.', evidence: `Docker RestartCount: ${container.restartCount}.`, service: target });
            if (container.hasResourceLimits === false) issues.push({ key: `${environment.id}:${container.id}:resource-limits`, severity: 'WARNING', title: `${target} has no CPU or memory limit`, description: 'Docker inspection reports no CPU quota or memory cap.', whyItMatters: 'An unbounded service can consume host resources and affect other containers.', recommendation: 'Measure normal usage, then set suitable CPU and memory limits in the deployment configuration.', evidence: 'No CPU quota or memory cap is configured in Docker HostConfig.', service: target });
            if (container.state !== 'running') issues.push({ key: `${environment.id}:${container.id}:stopped`, severity: 'CRITICAL', title: `${target} is ${container.state}`, description: 'A registered container is not running.', whyItMatters: 'Requests routed to this service may fail, and dependent services may be affected.', recommendation: 'Review its recent logs and start it when you have confirmed it is safe.', evidence: `Docker reported state '${container.state}'${container.exitCode === null || container.exitCode === undefined ? '' : ` with exit code ${container.exitCode}`}.`, service: target });
            if (container.health === 'unhealthy') issues.push({ key: `${environment.id}:${container.id}:unhealthy`, severity: 'CRITICAL', title: `${target} is unhealthy`, description: 'The configured Docker health check is failing.', whyItMatters: 'The container may be running while the application inside it is unable to serve requests.', recommendation: 'Inspect recent logs and the health check command, then correct the underlying issue.', evidence: `Docker health status: ${container.health}.`, service: target });
            if (container.metrics.cpuPercent !== null && container.metrics.cpuPercent > 85) issues.push({ key: `${environment.id}:${container.id}:cpu`, severity: 'WARNING', title: `${target} has high CPU usage`, description: `CPU usage is ${container.metrics.cpuPercent.toFixed(1)}%.`, whyItMatters: 'Sustained high CPU can increase latency for this and neighboring services.', recommendation: 'Check workload and recent logs; tune concurrency or allocate appropriate host capacity.', evidence: `Sampled CPU: ${container.metrics.cpuPercent.toFixed(1)}%.`, service: target });
            if (container.metrics.memoryPercent !== null && container.metrics.memoryPercent > 85) issues.push({ key: `${environment.id}:${container.id}:memory`, severity: 'WARNING', title: `${target} is near its memory limit`, description: `Memory consumption is ${container.metrics.memoryPercent.toFixed(1)}% of its reported limit.`, whyItMatters: 'Memory pressure can cause latency or an out-of-memory termination.', recommendation: 'Investigate memory growth and consider an appropriate service limit after measuring normal usage.', evidence: `Memory: ${container.metrics.memoryPercent.toFixed(1)}% of reported limit.`, service: target });
            if (container.state === 'running' && container.metrics.cpuPercent === null && container.metrics.memoryPercent === null) issues.push({ key: `${environment.id}:${container.id}:metrics`, severity: 'INFORMATIONAL', title: `Metrics unavailable for ${target}`, description: container.metricsUnavailableReason ?? 'Docker returned no resource metrics.', whyItMatters: 'Resource pressure could not be evaluated in this scan.', recommendation: 'Check Docker Engine connectivity and retry the scan.', evidence: container.metricsUnavailableReason ?? 'No usable CPU or memory sample.', service: target });
            if (container.state === 'running' && container.health === null) issues.push({ key: `${environment.id}:${container.id}:healthcheck`, severity: 'INFORMATIONAL', title: `${target} has no health check`, description: 'Docker reports no configured health check.', whyItMatters: 'A running state alone does not confirm that the application is responding.', recommendation: 'Add an application-appropriate health check to the image or Compose service.', evidence: 'Docker inspection returned no health status.', service: target });
            if (container.state !== 'removed') {
              try {
                const logs = await composeMonitoringService.getRecentLogs(environment.id, userId, container.id, 50);
                issues.push(...logIssues(environment.id, target, logs.lines));
              } catch { /* A log failure does not invalidate otherwise useful scan results. */ }
            }
          }
        } catch (error) {
          if (error instanceof AppError && ['DEPLOYMENT_NOT_REGISTERED', 'DEPLOYMENT_OWNERSHIP_CONFLICT'].includes(error.code)) continue;
          // Report unavailable scans without leaking daemon error details.
          issues.push({ key: `${environment.id}:docker-unavailable`, severity: 'INFORMATIONAL', title: `Container checks unavailable for ${environment.name}`, description: 'Docker container health and resources could not be inspected.', whyItMatters: 'Runtime conditions are missing from this report.', recommendation: 'Check that the Docker Engine or paired local agent is online, then scan again.', evidence: 'Runtime inspection did not complete.', service: null });
        }
      }
      const checks = Math.max(checksPerformed, environments.length * 2);
      const scannedAt = new Date().toISOString();
      const report: DoctorReport = { projectId, scannedAt, checksPerformed: checks, issues, ...scoreDoctorReport(issues, checks) };
      await prisma.stackDoctorScan.create({ data: { projectId, report: report as object } });
      return report;
    } finally { activeScans.delete(projectId); }
  },
};

async function ensureOwnedProject(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  if (!project) throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
  return project;
}
