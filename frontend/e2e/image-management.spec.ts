import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };
const FREE_ID = `sha256:${'a'.repeat(64)}`;
const USED_ID = `sha256:${'b'.repeat(64)}`;
const INFRA_ID = `sha256:${'c'.repeat(64)}`;

function image(id: string, repositoryTags: string[], overrides: Record<string, unknown> = {}) {
  return { id, repositoryTags, sizeBytes: 2 * 1024 ** 2, createdAt: NOW, containerCount: 0, protected: false, ...overrides };
}

async function installImageMocks(page: Page, options: { pullDelayMs?: number; pullError?: boolean; imageDelayMs?: number } = {}) {
  let images = [
    image(FREE_ID, ['nginx:alpine']),
    image(USED_ID, ['redis:7'], { sizeBytes: 5 * 1024 ** 2, containerCount: 2 }),
    image(INFRA_ID, ['postgres:17-alpine'], { sizeBytes: 8 * 1024 ** 2, containerCount: 1, protected: true }),
  ];
  let deleted: string | null = null;
  let pulled = '';
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
    if (path === '/docker/images' && method === 'GET') {
      if (options.imageDelayMs) await new Promise((resolve) => setTimeout(resolve, options.imageDelayMs));
      return json(images);
    }
    const inspect = path.match(/^\/docker\/images\/(sha256:[a-f\d]{64})$/i);
    if (inspect && method === 'GET') {
      const entry = images.find((item) => item.id === inspect[1]);
      if (!entry) return json({ error: 'The selected image is no longer available.' }, 404);
      return json({ ...entry, operatingSystem: 'linux', architecture: 'arm64', variant: null, config: { user: 'nginx', workingDir: '/usr/share/nginx/html', exposedPorts: ['80/tcp'], volumes: [] } });
    }
    if (path === '/docker/images/pull' && method === 'POST') {
      pulled = (request.postDataJSON() as { reference: string }).reference;
      if (options.pullDelayMs) await new Promise((resolve) => setTimeout(resolve, options.pullDelayMs));
      if (options.pullError) {
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'error', code: 'IMAGE_NOT_FOUND', message: 'The image or tag was not found in the registry.' })}\n` });
      }
      images = [...images, image(`sha256:${'d'.repeat(64)}`, [pulled])];
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ type: 'progress', status: 'Downloading', id: 'layer-1', current: 50, total: 100 })}\n${JSON.stringify({ type: 'complete', reference: pulled })}\n`,
      });
    }
    if (inspect && method === 'DELETE') {
      deleted = inspect[1]!;
      images = images.filter((item) => item.id !== deleted);
      return route.fulfill({ status: 204, body: '' });
    }
    return json({ error: `Unexpected request: ${method} ${path}` }, 404);
  });
  return { get deleted() { return deleted; }, get pulled() { return pulled; } };
}

test('image inventory supports search, sorting, inspection, and safe details', async ({ page }) => {
  await installImageMocks(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Images' }).click();
  await expect(page.getByRole('heading', { name: 'Image inventory' })).toBeVisible();
  await expect(page.getByText('nginx:alpine')).toBeVisible();
  await expect(page.getByRole('button', { name: 'In use' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Protected' })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search by repository or tag' }).fill('redis');
  await expect(page.getByText('redis:7')).toBeVisible();
  await expect(page.getByText('nginx:alpine')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search by repository or tag' }).fill('');
  await page.getByRole('combobox', { name: 'Sort images' }).selectOption('size');
  await expect(page.locator('.image-table tbody tr').first()).toContainText('postgres:17-alpine');
  const nginxRow = page.locator('.image-table tbody tr').filter({ hasText: 'nginx:alpine' });
  await nginxRow.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByRole('heading', { name: 'nginx:alpine' })).toBeVisible();
  await expect(page.getByText('linux', { exact: true })).toBeVisible();
  await expect(page.getByText('Container environment variables and labels are not displayed.')).toBeVisible();
});

test('pull form displays progress, adds the image, and reports successful completion', async ({ page }) => {
  const api = await installImageMocks(page, { pullDelayMs: 350 });
  await page.goto('/images');
  await page.getByLabel('Repository and tag').fill('nginx:stable');
  await page.getByRole('button', { name: 'Pull image' }).click();
  await expect(page.getByText('Starting pull for nginx:stable')).toBeVisible();
  await expect(page.getByText('Image nginx:stable pulled successfully.')).toBeVisible();
  await expect(page.getByText('nginx:stable', { exact: true })).toBeVisible();
  expect(api.pulled).toBe('nginx:stable');
});

test('removal requires confirmation and sends only the selected full image ID', async ({ page }) => {
  const api = await installImageMocks(page);
  let confirmation = '';
  page.on('dialog', async (dialog) => { confirmation = dialog.message(); await dialog.accept(); });
  await page.goto('/images');
  const row = page.locator('.image-table tbody tr').filter({ hasText: 'nginx:alpine' });
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Image nginx:alpine removed.')).toBeVisible();
  expect(confirmation).toContain(FREE_ID);
  expect(api.deleted).toBe(FREE_ID);
  await expect(page.getByText('nginx:alpine', { exact: true })).toHaveCount(0);
});

test('image pull errors are visible and the inventory layout fits a mobile viewport', async ({ page }) => {
  await installImageMocks(page, { pullError: true, imageDelayMs: 250 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/images');
  await expect(page.getByText('Loading Docker images…')).toBeVisible();
  await page.getByLabel('Repository and tag').fill('missing/image:tag');
  await page.getByRole('button', { name: 'Pull image' }).click();
  await expect(page.getByRole('alert')).toContainText('The image or tag was not found in the registry.');
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflows).toBe(false);
});

