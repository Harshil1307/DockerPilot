import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ENVIRONMENT_ID = '44444444-4444-4444-8444-444444444444';
const CONTAINER_ID = 'a'.repeat(64);
const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };
const PROJECT = { id: PROJECT_ID, name: 'Payments API', description: 'Test workspace', repositoryUrl: null, createdAt: NOW, updatedAt: NOW };
const SAMPLE = 'services:\n  web:\n    image: nginx:alpine\n';

interface MockOptions {
  monitoringError?: boolean;
  monitoringDelayMs?: number;
  emptyMonitoring?: boolean;
  unavailableMetrics?: boolean;
  emptyLogs?: boolean;
  failFirstCleanup?: boolean;
  lifecycleDelayMs?: number;
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
    if (path === '/docker/status') return json({ reachable: true, engine: { version: '29.8.0', apiVersion: '1.51', operatingSystem: 'Docker Desktop', architecture: 'arm64' } });
    if (path === '/docker/containers') return json([]);
    if (path === `/projects/${PROJECT_ID}` && method === 'GET') return json(PROJECT);
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
      });
    }
    if (path === `/compose/${ENVIRONMENT_ID}/deploy` && method === 'POST') {
      deploymentStatus = 'RUNNING';
      validationStatus = 'VALID';
      return json({ environmentId: ENVIRONMENT_ID, status: 'RUNNING', projectName: 'dp-test-project', startedAt: NOW, completedAt: NOW, servicesCount: 1 });
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
  page.on('dialog', (dialog) => dialog.accept());
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Configuration is valid', { exact: true })).toBeVisible();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await expect(card.getByText('Running', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Stop' }).click();
  const stopping = card.getByRole('button', { name: 'Stopping…' });
  await expect(stopping).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Restart' })).toBeDisabled();
  await expect(card.getByText('Stopped', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Start' }).click();
  await expect(card.getByText('Running', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Restart' }).click();
  await expect(card.getByText('Running', { exact: true })).toBeVisible();
  expect(api.lifecycleCalls).toBe(3);
});

test('cleanup requires confirmation, reports failure, and offers retry', async ({ page }) => {
  const api = await installApiMocks(page, { failFirstCleanup: true });
  const confirmations: string[] = [];
  page.on('dialog', async (dialog) => { confirmations.push(dialog.message()); await dialog.accept(); });
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await card.getByRole('button', { name: 'Cleanup', exact: true }).click();
  await expect(card.getByText('Cleanup failed', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry cleanup' })).toBeVisible();
  await card.getByRole('button', { name: 'Retry cleanup' }).click();
  await expect(card.getByText('Removed', { exact: true })).toBeVisible();
  const cleanupConfirmations = confirmations.filter((message) => message.startsWith('Clean up '));
  expect(cleanupConfirmations).toHaveLength(2);
  expect(cleanupConfirmations[0]).toContain('removes only the registered containers and networks');
});

test('monitoring shows inventory, metrics, selectable logs, and manual refresh', async ({ page }) => {
  const api = await installApiMocks(page);
  page.on('dialog', (dialog) => dialog.accept());
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
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
  page.on('dialog', (dialog) => dialog.accept());
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await card.locator('summary', { hasText: 'Services, resource use & logs' }).click();
  await expect(card.getByText('Unavailable', { exact: true }).first()).toBeVisible();
  await card.getByLabel('Select a container for logs').selectOption(CONTAINER_ID);
  await card.getByRole('button', { name: 'Load recent logs' }).click();
  await expect(card.getByText('No recent logs are available for this container.')).toBeVisible();
});

test('empty deployment inventory has a useful empty state', async ({ page }) => {
  const api = await installApiMocks(page, { emptyMonitoring: true });
  page.on('dialog', (dialog) => dialog.accept());
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await card.locator('summary', { hasText: 'Services, resource use & logs' }).click();
  await expect(card.getByText('No registered containers are available for this deployment.')).toBeVisible();
});

test('monitoring shows loading and errors; mobile layout avoids page overflow', async ({ page }) => {
  const api = await installApiMocks(page, { monitoringDelayMs: 500, monitoringError: true });
  page.setViewportSize({ width: 390, height: 844 });
  page.on('dialog', (dialog) => dialog.accept());
  await api.openProject();
  await createEnvironment(page);
  await page.getByRole('button', { name: 'Validate' }).click();
  const card = page.locator('.compose-environment-card');
  await card.getByRole('button', { name: 'Deploy' }).click();
  await card.locator('summary', { hasText: 'Services, resource use & logs' }).click();
  await expect(card.getByText('Loading deployment details…')).toBeVisible();
  await expect(card.getByRole('alert')).toContainText('Docker monitoring is temporarily unavailable.');
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflows).toBe(false);
});
