import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };

function overview(overrides: Record<string, unknown> = {}) {
  return {
    collectedAt: NOW,
    lastSuccessfulRefreshAt: NOW,
    daemon: { status: 'connected', message: null },
    engine: { version: '29.8.0', apiVersion: '1.56', operatingSystem: 'Docker Desktop', architecture: 'arm64' },
    containers: {
      total: 4, running: 2, stopped: 1, paused: 1,
      recent: [{ id: 'a'.repeat(12), name: 'api-service', image: 'api:latest', state: 'running', createdAt: NOW }],
    },
    images: { total: 7, recent: [{ id: `sha256:${'b'.repeat(64)}`, name: 'api:latest', createdAt: NOW }] },
    volumes: { total: 3, inUse: 2, unused: 1 },
    networks: { total: 5, connected: 3, unused: 2 },
    storage: {
      images: { bytes: 1024 ** 3, quality: 'exact' },
      containerWritable: { bytes: 1024 ** 2, quality: 'exact' },
      volumes: { bytes: 1024 ** 2 * 512, quality: 'exact' },
      buildCache: { bytes: 1024 ** 2 * 512, quality: 'exact' },
      total: { bytes: 2 * 1024 ** 3, quality: 'exact' },
    },
    errors: {},
    ...overrides,
  };
}

async function installOverviewMocks(page: Page, options: { delayMs?: number; unavailable?: boolean } = {}) {
  let overviewCalls = 0;
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ''));
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return json({ user: USER });
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/projects') return json([]);
    if (path === '/docker/status') return json({ reachable: true, engine: { version: '29.8.0', apiVersion: '1.56', operatingSystem: 'Docker Desktop', architecture: 'arm64' } });
    if (path === '/docker/containers') return json([]);
    if (path === '/docker/overview') {
      overviewCalls += 1;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.unavailable) return json(overview({
        lastSuccessfulRefreshAt: null,
        daemon: { status: 'unavailable', message: 'Docker Engine is unavailable. Start Docker Desktop and try again.' },
        engine: null,
        containers: { total: null, running: null, stopped: null, paused: null, recent: null },
        images: { total: null, recent: null },
        volumes: { total: null, inUse: null, unused: null },
        networks: { total: null, connected: null, unused: null },
        storage: {
          images: { bytes: 1024, quality: 'exact' },
          containerWritable: { bytes: null, quality: 'unavailable' },
          volumes: { bytes: null, quality: 'unavailable' },
          buildCache: { bytes: null, quality: 'unavailable' },
          total: { bytes: null, quality: 'unavailable' },
        },
        errors: { containers: 'Container inventory is unavailable.', storage: 'Some Docker storage metrics are unavailable from this Engine.' },
      }));
      return json(overview());
    }
    return json({ error: `Unexpected request: ${request.method()} ${path}` }, 404);
  });
  return { get calls() { return overviewCalls; } };
}

test('Docker host overview displays Engine details, resource summaries, storage, and management links', async ({ page }) => {
  await installOverviewMocks(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Docker host overview' }).click();
  await expect(page.getByRole('heading', { name: 'Docker host overview' })).toBeVisible();
  await expect(page.getByText('29.8.0')).toBeVisible();
  await expect(page.getByText('1.56')).toBeVisible();
  await expect(page.getByText('Docker Desktop')).toBeVisible();
  await expect(page.locator('.host-summary-card').filter({ hasText: 'CONTAINERS' }).locator('> strong')).toHaveText('4');
  await expect(page.locator('.host-summary-card').filter({ hasText: 'VOLUMES' })).toContainText('2 in use');
  await expect(page.getByText('2 GB', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage images' })).toHaveAttribute('href', '/images');
  await expect(page.getByRole('link', { name: 'Manage volumes' })).toHaveAttribute('href', '/volumes');
  await expect(page.getByRole('link', { name: 'Manage networks' })).toHaveAttribute('href', '/networks');
  await expect(page.getByText('api-service')).toBeVisible();
  await expect(page.getByText('api:latest').first()).toBeVisible();
});

test('manual refresh is available and duplicate refresh requests are prevented', async ({ page }) => {
  const api = await installOverviewMocks(page, { delayMs: 250 });
  await page.goto('/docker');
  await expect(page.getByRole('heading', { name: 'Docker host overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh overview' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh overview' }).click();
  await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  await expect(page.getByText('Last successful refresh:')).toBeVisible();
  expect(api.calls).toBe(2);
});

test('unavailable daemon, partial metrics, loading and mobile layout are communicated clearly', async ({ page }) => {
  await installOverviewMocks(page, { delayMs: 250, unavailable: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/docker');
  await expect(page.getByText('Loading Docker host overview…')).toBeVisible();
  await expect(page.getByRole('alert').first()).toContainText('Docker Engine unavailable');
  await expect(page.getByRole('status').filter({ hasText: 'Some Docker metrics are unavailable.' })).toBeVisible();
  await expect(page.locator('.host-engine-grid')).toContainText('Unavailable');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
