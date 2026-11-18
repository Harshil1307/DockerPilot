import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ENVIRONMENT_ID = '44444444-4444-4444-8444-444444444444';
const CONTAINER_ID = 'a'.repeat(64);
const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };
const PROJECT = { id: PROJECT_ID, name: 'Payments API', description: 'Test workspace', repositoryUrl: null, repositoryOwner: null, repositoryName: null, repositoryDefaultBranch: null, repositoryStatus: 'disconnected', repositoryError: null, repositoryVerifiedAt: null, createdAt: NOW, updatedAt: NOW };
const SAMPLE = 'services:\n  web:\n    image: nginx:alpine\n';

interface MockOptions {
  monitoringError?: boolean;
  monitoringDelayMs?: number;
  emptyMonitoring?: boolean;
  unavailableMetrics?: boolean;
  emptyLogs?: boolean;
  failFirstCleanup?: boolean;
  lifecycleDelayMs?: number;
  connectedRepository?: boolean;
}

function environmentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ENVIRONMENT_ID,
    name: 'Local stack',
    composeYaml: SAMPLE,
    validationStatus: 'NOT_VALIDATED',
    deploymentStatus: 'NOT_DEPLOYED',
    deploymentProjectName: null,
    deploymentStartedAt: null,
    deploymentCompletedAt: null,
    lastDeploymentError: null,
    projectId: PROJECT_ID,
    createdAt: NOW,
    updatedAt: NOW,
    servicesCount: 1,
    ...overrides,
  };
}

async function installApiMocks(page: Page, options: MockOptions = {}) {
  let composeEnvironment: ReturnType<typeof environmentRecord> | null = null;
  let deploymentStatus: 'NOT_DEPLOYED' | 'RUNNING' | 'STOPPED' | 'CLEANUP_FAILED' | 'REMOVED' = 'NOT_DEPLOYED';
  let validationStatus: 'NOT_VALIDATED' | 'VALID' | 'INVALID' = 'NOT_VALIDATED';
  let cleanupAttempts = 0;
  let lifecycleCalls = 0;
  let monitoringCalls = 0;
  let validationErrors = false;
  let doctorReport: Record<string, unknown> | null = null;
  let projectRecord = { ...PROJECT, ...(options.connectedRepository ? { repositoryUrl: 'https://github.com/acme/app', repositoryOwner: 'acme', repositoryName: 'app', repositoryDefaultBranch: 'main', repositoryStatus: 'connected' as const } : {}) };

  function summary() {
    if (!composeEnvironment) return null;
    return environmentRecord({
      ...composeEnvironment,
      validationStatus,
      deploymentStatus,
      deploymentProjectName: deploymentStatus === 'NOT_DEPLOYED' || deploymentStatus === 'REMOVED' ? null : 'dp-test-project',
      deploymentCompletedAt: deploymentStatus === 'NOT_DEPLOYED' ? null : NOW,
      lastDeploymentError: deploymentStatus === 'CLEANUP_FAILED' ? 'Cleanup did not complete. Check Docker Desktop and retry.' : null,
    });
  }

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/auth/me' && method === 'GET') return json({ user: USER });
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/projects' && method === 'GET') return json([projectRecord]);
    if (path === `/projects/${PROJECT_ID}/git-detective/analyze` && method === 'POST') return json({ basedOnScanAt: NOW, analysis: { status: 'available', source: 'github', repository: 'acme/app', branch: 'main', message: null, commits: [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaaa', message: 'Update api dependency', author: 'Developer', committedAt: NOW, changedFiles: ['services/api/package.json'], diff: '+"library": "2.0"', githubUrl: 'https://github.com/acme/app/commit/' + 'a'.repeat(40), score: 65, confidence: 'medium', relationship: 'Potential relationship: changed files match the failing service. This is correlation, not proof of cause.' }], rootCause: { problem: 'api is stopped', affectedService: 'api', explanation: 'The dependency change is a possible lead; evidence does not prove it caused the failure.', confidence: 'medium', supportingEvidence: ['Exit code 1.', 'aaaaaaaa may be related.'], recommendedFix: 'Review startup compatibility.', verificationSteps: ['Rerun the service health check.'], provider: null } } });
    if (path === '/docker/status') return json({ reachable: true, engine: { version: '29.8.0', apiVersion: '1.51', operatingSystem: 'Docker Desktop', architecture: 'arm64' } });
    if (path === '/docker/containers') return json([]);
    if (path === `/projects/${PROJECT_ID}` && method === 'GET') return json(projectRecord);
    if (path === `/projects/${PROJECT_ID}` && method === 'PATCH') {
      const input = request.postDataJSON() as { name: string; description: string | null; repositoryUrl: string | null };
      projectRecord = { ...projectRecord, ...input, repositoryOwner: input.repositoryUrl ? 'acme' : null, repositoryName: input.repositoryUrl ? 'app' : null, repositoryDefaultBranch: input.repositoryUrl ? 'main' : null, repositoryStatus: input.repositoryUrl ? 'connected' : 'disconnected', repositoryError: null, repositoryVerifiedAt: input.repositoryUrl ? NOW : null };
      return json(projectRecord);
    }
    if (path === `/projects/${PROJECT_ID}/stack-doctor` && method === 'GET') return json(doctorReport ? [{ id: 'scan-1', report: doctorReport, createdAt: NOW }] : []);
    if (path === `/projects/${PROJECT_ID}/stack-doctor` && method === 'POST') {
      doctorReport = { projectId: PROJECT_ID, scannedAt: NOW, healthScore: 60, checksPerformed: 8, passedChecks: 6, warningCount: 0, criticalCount: 1, issues: [{ key: 'api-stopped', severity: 'CRITICAL', title: 'api is stopped', description: 'Container failed.', whyItMatters: 'Requests fail.', recommendation: 'Review the logs.', evidence: 'Exit code 1.', service: 'api' }] };
      return json(doctorReport, 201);
    }
    if (path === `/projects/${PROJECT_ID}/compose` && method === 'GET') return json(summary() ? [summary()] : []);

    if (path === `/projects/${PROJECT_ID}/compose` && method === 'POST') {
      const body = request.postDataJSON() as { name: string; composeYaml: string };
      composeEnvironment = environmentRecord({ ...body });
      validationStatus = 'NOT_VALIDATED';
      deploymentStatus = 'NOT_DEPLOYED';
      return json(summary(), 201);
    }
    if (path === `/compose/${ENVIRONMENT_ID}` && method === 'GET' && composeEnvironment) return json(composeEnvironment);
    if (path === `/compose/${ENVIRONMENT_ID}` && method === 'PATCH' && composeEnvironment) {
      const body = request.postDataJSON() as { name: string; composeYaml: string };
      composeEnvironment = environmentRecord({ ...composeEnvironment, ...body });
      validationStatus = 'NOT_VALIDATED';
      return json(summary());
    }
    if (path === `/compose/${ENVIRONMENT_ID}/validate` && method === 'POST') {
      validationErrors = Boolean(composeEnvironment?.composeYaml.includes('invalid-image'));
      validationStatus = validationErrors ? 'INVALID' : 'VALID';
      return json({
        valid: !validationErrors,
        validationStatus,
        servicesCount: 1,
        errors: validationErrors ? ['services.web.image: use a supported image reference.'] : [],
      });
    }
    if (path === `/compose/${ENVIRONMENT_ID}/deployment` && method === 'GET') {
      return json({
        environmentId: ENVIRONMENT_ID,
        status: deploymentStatus,
        projectName: ['NOT_DEPLOYED', 'REMOVED'].includes(deploymentStatus) ? null : 'dp-test-project',
        startedAt: deploymentStatus === 'NOT_DEPLOYED' ? null : NOW,
        completedAt: deploymentStatus === 'NOT_DEPLOYED' ? null : NOW,
        lastError: deploymentStatus === 'CLEANUP_FAILED' ? 'Cleanup did not complete. Check Docker Desktop and retry.' : null,
        publishedPorts: ['RUNNING', 'STOPPED'].includes(deploymentStatus) ? [{ serviceName: 'web', hostPort: 49152, containerPort: 80, url: 'http://localhost:49152' }] : [],
      });
    }
    if (path === `/compose/${ENVIRONMENT_ID}/deploy` && method === 'POST') {
      deploymentStatus = 'RUNNING';
      validationStatus = 'VALID';
      return json({ environmentId: ENVIRONMENT_ID, status: 'RUNNING', projectName: 'dp-test-project', startedAt: NOW, completedAt: NOW, servicesCount: 1, publishedPorts: [{ serviceName: 'web', hostPort: 49152, containerPort: 80, url: 'http://localhost:49152' }] });
    }
    const actionMatch = path.match(new RegExp(`^/compose/${ENVIRONMENT_ID}/deployment/(start|stop|restart)$`));
    if (actionMatch && method === 'POST') {
      lifecycleCalls += 1;
      if (options.lifecycleDelayMs) await new Promise((resolve) => setTimeout(resolve, options.lifecycleDelayMs));
      const action = actionMatch[1] as 'start' | 'stop' | 'restart';
      deploymentStatus = action === 'stop' ? 'STOPPED' : 'RUNNING';
      return json({ environmentId: ENVIRONMENT_ID, action, status: deploymentStatus, completedAt: NOW });
    }
    if (path === `/compose/${ENVIRONMENT_ID}/deployment` && method === 'DELETE') {
      cleanupAttempts += 1;
      if (options.failFirstCleanup && cleanupAttempts === 1) {
        deploymentStatus = 'CLEANUP_FAILED';
        return json({ error: 'Cleanup did not complete. Check Docker Desktop and retry.' }, 502);
      }
      deploymentStatus = 'REMOVED';
      return json({ environmentId: ENVIRONMENT_ID, status: 'REMOVED', removedContainers: 1, removedNetworks: 1 });
    }
    if (path === `/compose/${ENVIRONMENT_ID}/monitoring` && method === 'GET') {
      monitoringCalls += 1;
      if (options.monitoringDelayMs) await new Promise((resolve) => setTimeout(resolve, options.monitoringDelayMs));
      if (options.monitoringError) return json({ error: 'Docker monitoring is temporarily unavailable.' }, 503);
      return json({
        environmentId: ENVIRONMENT_ID,
        sampledAt: NOW,
        containers: options.emptyMonitoring ? [] : [{
          id: CONTAINER_ID,
          serviceName: 'web',
          name: 'dp-test-web-1',
          state: 'running',
          health: 'healthy',
          image: 'nginx:alpine',
          createdAt: NOW,
          startedAt: NOW,
          metrics: options.unavailableMetrics
            ? { cpuPercent: null, memoryUsageBytes: null, memoryLimitBytes: null, memoryPercent: null }
            : { cpuPercent: 12.5, memoryUsageBytes: 32 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024, memoryPercent: 6.25 },
          metricsUnavailableReason: options.unavailableMetrics ? 'Statistics are unavailable for this container.' : null,
        }],
      });
    }
    if (path === `/compose/${ENVIRONMENT_ID}/containers/${CONTAINER_ID}/logs` && method === 'GET') {
      return json({
        environmentId: ENVIRONMENT_ID,
        containerId: CONTAINER_ID,
        lines: options.emptyLogs ? [] : [{ stream: 'stdout', text: 'nginx started successfully' }],
        truncated: false,
      });
    }
    return json({ error: `Unexpected mocked API request: ${method} ${path}` }, 404);
  });

  return {
    async openProject() {
      await page.goto(`/projects/${PROJECT_ID}`);
      await expect(page.getByRole('heading', { name: 'Payments API' })).toBeVisible();
    },
    get lifecycleCalls() { return lifecycleCalls; },
    get monitoringCalls() { return monitoringCalls; },
  };
}

async function createEnvironment(page: Page) {
  await page.getByRole('button', { name: /New environment/ }).click();
  await page.getByLabel('Environment name').fill('Local stack');
  await page.getByLabel('Compose YAML').fill('services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n');
  await page.getByRole('button', { name: 'Save environment' }).click();
  await expect(page.getByText('Compose environment saved.')).toBeVisible();
}

test('create, edit, validate configuration and show validation errors', async ({ page }) => {
  const api = await installApiMocks(page);
  await api.openProject();
  await createEnvironment(page);
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Environment name').fill('Updated local stack');
  await page.getByLabel('Compose YAML').fill('services:\n  web:\n    image: nginx:alpine\n');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Configuration is valid', { exact: true })).toBeVisible();

  await card.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Compose YAML').fill('services:\n  web:\n    image: invalid-image\n');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Configuration has validation errors')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('services.web.image');
});

test('deploy, show status, and start stop restart with duplicate requests disabled', async ({ page }) => {
  const api = await installApiMocks(page, { lifecycleDelayMs: 300 });
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Configuration is valid', { exact: true })).toBeVisible();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy stack' }).click();
  await expect(card.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByText(/Open website: http:\/\/localhost:49152/)).toBeVisible();
  await expect(card.getByRole('link', { name: /Open web at http:\/\/localhost:49152/ })).toBeVisible();
  await card.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop' }).click();
  const stopping = card.getByRole('button', { name: 'Stopping…' });
  await expect(stopping).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Restart' })).toBeDisabled();
  await expect(card.getByText('Stopped', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start' }).click();
  await expect(card.getByText('Running', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Restart' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restart' }).click();
  await expect(card.getByText('Running', { exact: true })).toBeVisible();
  expect(api.lifecycleCalls).toBe(3);
});

test('cleanup requires confirmation, reports failure, and offers retry', async ({ page }) => {
  const api = await installApiMocks(page, { failFirstCleanup: true });
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy stack' }).click();
  await card.getByRole('button', { name: 'Cleanup', exact: true }).click();
  const firstCleanupPrompt = page.getByRole('dialog');
  await expect(firstCleanupPrompt).toContainText('Unlike Stop, it removes those resources');
  await firstCleanupPrompt.getByRole('button', { name: 'Clean up stack' }).click();
  await expect(card.getByText('Cleanup failed', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry cleanup' })).toBeVisible();
  await card.getByRole('button', { name: 'Retry cleanup' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clean up stack' }).click();
  await expect(card.getByText('Removed', { exact: true })).toBeVisible();
});

test('monitoring shows inventory, metrics, selectable logs, and manual refresh', async ({ page }) => {
  const api = await installApiMocks(page);
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy stack' }).click();
  await card.locator('summary', { hasText: 'Services, resource use & logs' }).click();
  await expect(card.getByRole('cell', { name: 'web' })).toBeVisible();
  await expect(card.getByText('12.5%', { exact: true })).toBeVisible();
  await expect(card.getByText(/32 MiB \/ 512 MiB/)).toBeVisible();
  await card.getByLabel('Select a container for logs').selectOption(CONTAINER_ID);
  await card.getByRole('button', { name: 'Load recent logs' }).click();
  await expect(card.getByText('nginx started successfully')).toBeVisible();
  await card.getByRole('button', { name: 'Refresh services & stats' }).click();
  expect(api.monitoringCalls).toBe(2);
});

test('unavailable metrics and empty log output are labeled clearly', async ({ page }) => {
  const api = await installApiMocks(page, { unavailableMetrics: true, emptyLogs: true });
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy stack' }).click();
  await card.locator('summary', { hasText: 'Services, resource use & logs' }).click();
  await expect(card.getByText('Unavailable', { exact: true }).first()).toBeVisible();
  await card.getByLabel('Select a container for logs').selectOption(CONTAINER_ID);
  await card.getByRole('button', { name: 'Load recent logs' }).click();
  await expect(card.getByText('No recent logs are available for this container.')).toBeVisible();
});

test('empty deployment inventory has a useful empty state', async ({ page }) => {
  const api = await installApiMocks(page, { emptyMonitoring: true });
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy stack' }).click();
  await card.locator('summary', { hasText: 'Services, resource use & logs' }).click();
  await expect(card.getByText('No registered containers are available for this deployment.')).toBeVisible();
});

test('Stack Doctor keeps its report focused on Docker findings', async ({ page }) => {
  await installApiMocks(page);
  await page.goto(`/projects/${PROJECT_ID}`);
  await page.getByRole('button', { name: 'Run diagnostic scan' }).click();
  await expect(page.getByRole('heading', { name: 'Critical issues' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Git Detective – Change Analysis' })).toHaveCount(0);
});

test('Git Detective runs from its own Intelligence page', async ({ page }) => {
  await installApiMocks(page, { connectedRepository: true });
  await page.goto('/git-detective');
  await page.getByRole('button', { name: 'Analyze recent commits' }).click();
  await expect(page.getByRole('heading', { name: 'acme/app' })).toBeVisible();
  const commit = page.locator('.git-commit-card').filter({ hasText: 'Update api dependency' });
  await expect(commit).toBeVisible();
  await commit.locator(':scope > summary').click();
  await commit.getByText('View code changes').click();
  await expect(page.getByText('+"library": "2.0"')).toBeVisible();
});

test('project settings connect a GitHub repository once and can disconnect it', async ({ page }) => {
  await installApiMocks(page);
  await page.goto(`/projects/${PROJECT_ID}`);
  await page.getByRole('button', { name: 'Edit project' }).click();
  await page.getByLabel(/GitHub repository URL/).fill('https://github.com/acme/app');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Connected · app · main')).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(page.getByText('No GitHub repository connected.')).toBeVisible();
});

test('monitoring shows loading and errors; mobile layout avoids page overflow', async ({ page }) => {
  const api = await installApiMocks(page, { monitoringDelayMs: 500, monitoringError: true });
  page.setViewportSize({ width: 390, height: 844 });
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy stack' }).click();
  await card.locator('summary', { hasText: 'Services, resource use & logs' }).click();
  await expect(card.getByText('Loading deployment details…')).toBeVisible();
  await expect(card.getByRole('alert')).toContainText('Docker monitoring is temporarily unavailable.');
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflows).toBe(false);
});
