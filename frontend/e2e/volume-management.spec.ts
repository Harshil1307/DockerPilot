import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };

function volume(name: string, overrides: Record<string, unknown> = {}) {
  return { name, driver: 'local', mountpoint: `/var/lib/docker/volumes/${name}/_data`, createdAt: NOW, scope: 'local', labels: {}, containerCount: 0, inUse: false, protected: false, ...overrides };
}

async function installVolumeMocks(page: Page, options: { delayMs?: number; failInventory?: boolean } = {}) {
  let volumes = [
    volume('alpha_data'),
    volume('beta_running', { containerCount: 1, inUse: true }),
    volume('gamma_stopped', { containerCount: 1, inUse: true }),
    volume('dockerpilot_postgres_data', { protected: true }),
  ];
  let created = '';
  let removed = '';
  let removalConfirmation: unknown;
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ''));
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return json({ user: USER });
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/docker/status') return json({ reachable: true, engine: { version: '29.8.0', apiVersion: '1.56', operatingSystem: 'Docker Desktop', architecture: 'arm64' } });
    if (path === '/docker/containers') return json([]);
    if (path === '/docker/volumes' && method === 'GET') {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.failInventory) return json({ error: 'Docker Engine is unavailable. Start Docker Desktop and check its local socket connection.' }, 503);
      return json(volumes);
    }
    if (path === '/docker/volumes' && method === 'POST') {
      created = (request.postDataJSON() as { name: string }).name;
      const entry = volume(created);
      volumes = [...volumes, entry];
      return json(entry, 201);
    }
    const detail = path.match(/^\/docker\/volumes\/([^/]+)$/);
    if (detail && method === 'GET') {
      const entry = volumes.find((candidate) => candidate.name === detail[1]);
      if (!entry) return json({ error: 'The selected Docker volume was not found.' }, 404);
      return json({ ...entry, labels: { 'com.docker.compose.volume': 'data' }, containers: entry.name === 'beta_running'
        ? [{ id: 'running123456', name: 'app-running', state: 'running' }]
        : entry.name === 'gamma_stopped' ? [{ id: 'stopped123456', name: 'app-stopped', state: 'exited' }] : [] });
    }
    if (detail && method === 'DELETE') {
      removed = detail[1]!;
      removalConfirmation = (request.postDataJSON() as { confirmation: string }).confirmation;
      volumes = volumes.filter((entry) => entry.name !== removed);
      return route.fulfill({ status: 204, body: '' });
    }
    return json({ error: `Unexpected request: ${method} ${path}` }, 404);
  });
  return { get created() { return created; }, get removed() { return removed; }, get removalConfirmation() { return removalConfirmation; } };
}

test('volume inventory supports searching, sorting, safe inspection, and blocks in-use and protected removal', async ({ page }) => {
  await installVolumeMocks(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Volumes' }).click();
  await expect(page.getByRole('heading', { name: 'Volume inventory' })).toBeVisible();
  await expect(page.locator('.volume-table tbody tr').filter({ hasText: 'beta_running' }).getByRole('button', { name: 'In use' })).toBeDisabled();
  await expect(page.locator('.volume-table tbody tr').filter({ hasText: 'gamma_stopped' }).getByRole('button', { name: 'In use' })).toBeDisabled();
  await expect(page.locator('.volume-table tbody tr').filter({ hasText: 'dockerpilot_postgres_data' }).getByRole('button', { name: 'Protected' })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search volumes by name' }).fill('gamma');
  await expect(page.getByText('gamma_stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('alpha_data', { exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search volumes by name' }).fill('');
  await page.getByRole('combobox', { name: 'Sort volumes' }).selectOption('driver');
  const row = page.locator('.volume-table tbody tr').filter({ hasText: 'gamma_stopped' });
  await row.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByRole('heading', { name: 'gamma_stopped' })).toBeVisible();
  await expect(page.getByText('app-stopped')).toBeVisible();
  await expect(page.getByText('exited', { exact: true })).toBeVisible();
  await expect(page.getByText('Container environment variables and unrelated labels are not displayed.')).toBeVisible();
});

test('volume creation refreshes inventory and removal confirms and targets only the selected name', async ({ page }) => {
  const api = await installVolumeMocks(page);
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/volumes');
  await page.getByLabel('Volume name').fill('test_volume_6_2');
  await page.getByRole('button', { name: 'Create volume' }).click();
  await expect(page.getByText('Volume test_volume_6_2 created successfully.')).toBeVisible();
  expect(api.created).toBe('test_volume_6_2');
  const row = page.locator('.volume-table tbody tr').filter({ hasText: 'alpha_data' });
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Volume alpha_data removed.')).toBeVisible();
  expect(api.removed).toBe('alpha_data');
  expect(api.removalConfirmation).toBe('alpha_data');
});

test('volume page shows loading and daemon errors and remains usable on mobile', async ({ page }) => {
  await installVolumeMocks(page, { delayMs: 250, failInventory: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/volumes');
  await expect(page.getByText('Loading Docker volumes…')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Docker Engine is unavailable');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
