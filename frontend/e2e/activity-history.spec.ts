import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };

async function mockApi(page: Page, mode: 'ready' | 'empty' | 'error' = 'ready') {
  const requests: string[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/auth/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: USER }) });
    if (path === '/health') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW }) });
    if (path === '/activity') {
      requests.push(url.search);
      if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Activity history is temporarily unavailable.' }) });
      const record = {
        id: 'activity-one', actionType: url.searchParams.get('actionType') ?? 'CONTAINER_STOPPED', resourceType: url.searchParams.get('resourceType') ?? 'container',
        resourceId: 'a'.repeat(12), resourceName: 'api-service', status: 'SUCCEEDED', summary: 'Container stopped successfully.', createdAt: NOW,
      };
      const pageNumber = Number(url.searchParams.get('page') ?? 1);
      const body = mode === 'empty' ? { activities: [], page: pageNumber, pageSize: 30, hasMore: false }
        : { activities: pageNumber === 1 ? [record] : [], page: pageNumber, pageSize: 30, hasMore: pageNumber === 1 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected request ${request.method()} ${path}` }) });
  });
  return requests;
}

test('activity history shows safe records, filters, pagination, and mobile layout', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'Activity history' })).toBeVisible();
  await expect(page.getByText('Container stopped successfully.')).toBeVisible();
  await page.getByLabel('Action').selectOption('IMAGE_REMOVED');
  await expect(page.locator('.activity-copy strong')).toHaveText('Image removed');
  await page.getByLabel('Resource').selectOption('image');
  await expect.poll(() => requests.at(-1)).toContain('actionType=IMAGE_REMOVED');
  await expect.poll(() => requests.at(-1)).toContain('resourceType=image');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => requests.at(-1)).toContain('page=2');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('activity history has clear empty and error states', async ({ page }) => {
  await mockApi(page, 'empty');
  await page.goto('/activity');
  await expect(page.getByText('Actions performed through DockerPilot will appear here.')).toBeVisible();
  await mockApi(page, 'error');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Activity history is temporarily unavailable.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
