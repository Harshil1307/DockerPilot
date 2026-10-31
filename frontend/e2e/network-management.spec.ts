import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };
const FREE_ID = 'a'.repeat(64);
const USED_ID = 'b'.repeat(64);
const INFRA_ID = 'c'.repeat(64);

function network(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return { id, shortId: id.slice(0, 12), name, driver: 'bridge', scope: 'local', internal: false, enableIPv6: false, createdAt: NOW, labels: {}, subnets: [{ subnet: '172.25.0.0/16', gateway: '172.25.0.1' }], containerCount: 0, protected: false, ...overrides };
}

async function installNetworkMocks(page: Page, options: { delayMs?: number; failInventory?: boolean } = {}) {
  let networks = [
    network(FREE_ID, 'alpha_net'),
    network(USED_ID, 'beta_net', { containerCount: 2 }),
    network(INFRA_ID, 'dockerpilot_default', { protected: true }),
  ];
  let created: Record<string, unknown> | null = null;
  let removedId = '';
  let confirmationName = '';
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
    if (path === '/docker/networks' && method === 'GET') {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.failInventory) return json({ error: 'Docker Engine is unavailable. Start Docker Desktop and check its local socket connection.' }, 503);
      return json({ networks, ipv6Supported: true });
    }
    if (path === '/docker/networks' && method === 'POST') {
      created = request.postDataJSON() as Record<string, unknown>;
      const name = String(created.name);
      networks = [...networks, network('d'.repeat(64), name, { internal: created.internal, enableIPv6: created.enableIPv6 })];
      return json(networks.at(-1), 201);
    }
    const detail = path.match(/^\/docker\/networks\/([a-f\d]{64})$/i);
    if (detail && method === 'GET') {
      const entry = networks.find((item) => item.id === detail[1]);
      if (!entry) return json({ error: 'The selected Docker network was not found.' }, 404);
      return json({ ...entry, labels: { 'com.docker.compose.project': 'example' }, containers: entry.id === USED_ID
        ? [
          { id: '1'.repeat(64), name: 'api-running', state: 'running' },
          { id: '2'.repeat(64), name: 'worker-stopped', state: 'exited' },
        ] : [] });
    }
    if (detail && method === 'DELETE') {
      removedId = detail[1]!;
      confirmationName = (request.postDataJSON() as { confirmationName: string }).confirmationName;
      networks = networks.filter((item) => item.id !== removedId);
      return route.fulfill({ status: 204, body: '' });
    }
    return json({ error: `Unexpected request: ${method} ${path}` }, 404);
  });
  return { get created() { return created; }, get removedId() { return removedId; }, get confirmationName() { return confirmationName; } };
}

test('network inventory searches, filters, sorts, and shows running and stopped attachments', async ({ page }) => {
  await installNetworkMocks(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Networks' }).click();
  await expect(page.getByRole('heading', { name: 'Network inventory' })).toBeVisible();
  const usedRow = page.locator('.network-table tbody tr').filter({ hasText: 'beta_net' });
  await expect(usedRow.getByRole('button', { name: 'In use' })).toBeDisabled();
  await expect(page.locator('.network-table tbody tr').filter({ hasText: 'dockerpilot_default' }).getByRole('button', { name: 'Protected' })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search networks by name or ID' }).fill(USED_ID.slice(0, 12));
  await expect(page.getByText('beta_net', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search networks by name or ID' }).fill('');
  await page.getByRole('combobox', { name: 'Filter networks by driver' }).selectOption('bridge');
  await page.getByRole('combobox', { name: 'Sort networks' }).selectOption('created');
  await usedRow.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByRole('heading', { name: 'beta_net' })).toBeVisible();
  await expect(page.getByText('api-running')).toBeVisible();
  await expect(page.getByText('worker-stopped')).toBeVisible();
  await expect(page.getByText('172.25.0.0/16 · gateway 172.25.0.1')).toBeVisible();
  await expect(page.getByText('Container environment variables and unrelated Docker metadata are not displayed.')).toBeVisible();
});

test('network creation sends only supported bridge options and removal confirms exact full ID and name', async ({ page }) => {
  const api = await installNetworkMocks(page);
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/networks');
  await page.getByLabel('Network name').fill('private_app_net');
  await page.getByLabel('Internal network').check();
  await page.getByLabel('Enable IPv6').check();
  await page.getByRole('button', { name: 'Create network' }).click();
  await expect(page.getByText('Network private_app_net created successfully.')).toBeVisible();
  expect(api.created).toEqual({ name: 'private_app_net', internal: true, enableIPv6: true });
  const row = page.locator('.network-table tbody tr').filter({ hasText: 'alpha_net' });
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Network alpha_net removed.')).toBeVisible();
  expect(api.removedId).toBe(FREE_ID);
  expect(api.confirmationName).toBe('alpha_net');
});

test('network page shows loading and daemon errors and fits a mobile viewport', async ({ page }) => {
  await installNetworkMocks(page, { delayMs: 250, failInventory: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/networks');
  await expect(page.getByText('Loading Docker networks…')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Docker Engine is unavailable');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
