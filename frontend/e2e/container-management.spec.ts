import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };
const ID = 'a'.repeat(64);
const containers = [
  { id: ID.slice(0, 12), name: 'alpha-api', image: 'api:latest', state: 'running', status: 'Up 3 minutes', createdAt: NOW, publishedPorts: ['8080:80/tcp'], managed: true, managedByCurrentUser: true },
  { id: 'b'.repeat(12), name: 'beta-worker', image: 'worker:latest', state: 'exited', status: 'Exited (0)', createdAt: '2026-10-30T10:00:00.000Z', publishedPorts: [], managed: false, managedByCurrentUser: false },
];

async function mockApi(page: Page) {
  const calls: string[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    calls.push(`${request.method()} ${path}${new URL(request.url()).search}`);
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return json({ user: USER });
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/projects') return json([]);
    if (path === '/docker/status') return json({ reachable: true, engine: { version: '29.8.0', apiVersion: '1.56', operatingSystem: 'Docker Desktop', architecture: 'arm64' } });
    if (path === '/docker/containers') return json(containers);
    if (path === '/docker/containers/monitoring') return json({ sampledAt: NOW, containers: [{ id: containers[0]!.id, metrics: { cpuPercent: 12.5, memoryUsageBytes: 10485760, memoryLimitBytes: 52428800, memoryPercent: 20 }, metricsUnavailableReason: null }] });
    if (path === `/docker/containers/${containers[0]!.id}`) return json({ id: ID, name: 'alpha-api', image: 'api:latest', serviceName: null, state: 'running', health: 'healthy', createdAt: NOW, startedAt: NOW, restartPolicy: { name: 'unless-stopped', maximumRetryCount: 0 }, publishedPorts: ['8080:80/tcp'], networks: [{ name: 'app-net', id: 'c'.repeat(64) }], mounts: [{ type: 'volume', name: 'app-data', destination: '/data', readOnly: false }], memoryLimitBytes: 52428800, cpuLimitCores: 2 });
    if (path === `/docker/containers/${ID}/logs`) return json({ containerId: ID, lines: [{ stream: 'stderr', text: 'Bearer [REDACTED] warning' }], truncated: false, tail: 50 });
    if (path.startsWith(`/docker/containers/${containers[0]!.id}/stop`) && request.method() === 'POST') return json({ id: containers[0]!.id, name: 'alpha-api', state: 'exited', status: 'Stopped', action: 'stop' });
    if (path === '/docker/overview') return json({ collectedAt: NOW, lastSuccessfulRefreshAt: NOW, daemon: { status: 'connected', message: null }, engine: null, containers: { total: 2, running: 1, stopped: 1, paused: 0, recent: [] }, images: { total: 0, recent: [] }, volumes: { total: 0, inUse: 0, unused: 0 }, networks: { total: 0, connected: 0, unused: 0 }, storage: { images: { bytes: 0, quality: 'exact' }, containerWritable: { bytes: 0, quality: 'exact' }, volumes: { bytes: 0, quality: 'exact' }, buildCache: { bytes: 0, quality: 'exact' }, total: { bytes: 0, quality: 'exact' } }, errors: {} });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected request ${request.method()} ${path}` }) });
  });
  return calls;
}

test('container inventory filters and sorts, and details expose metrics, logs, mounts, and networks', async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Docker containers' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh metrics' }).click();
  await expect(page.getByText('CPU 12.5%')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search containers' }).fill('beta');
  await expect(page.getByText('beta-worker')).toBeVisible();
  await expect(page.getByText('alpha-api')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search containers' }).fill('alpha');
  await page.getByRole('button', { name: 'Details & logs' }).click();
  await expect(page.getByText(ID)).toBeVisible();
  await expect(page.getByText('app-net')).toBeVisible();
  await expect(page.getByText('app-data: /data')).toBeVisible();
  await page.getByRole('combobox', { name: 'Log tail size' }).selectOption('50');
  await page.getByRole('button', { name: 'Load recent logs' }).click();
  await expect(page.getByText('Bearer [REDACTED] warning')).toBeVisible();
  expect(calls).toContain(`GET /docker/containers/${ID}/logs?tail=50`);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('container lifecycle actions require confirmation and show operation feedback', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Docker containers' })).toBeVisible();
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('alpha-api')).toBeVisible();
  page.removeAllListeners('dialog');
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'alpha-api stopped successfully.' })).toBeVisible();
});
