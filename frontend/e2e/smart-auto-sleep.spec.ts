import { expect, test, type Route } from '@playwright/test';

const now = '2026-11-17T10:00:00.000Z';
const user = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: now, updatedAt: now };
const id = 'a'.repeat(64);

test('Smart Auto-Sleep requires confirmation before stopping an owned idle candidate', async ({ page }) => {
  let stopCalls = 0;
  const dashboard = {
    status: 'ready', message: null, sampledAt: now, systemHealth: 'healthy', containerCount: 1, warnings: 0, criticalIssues: 0,
    topCpu: [], topMemory: [], containers: [], events: [], eventsUnavailable: false, anomalies: [],
    idleCandidates: [{ id, name: 'idle-worker', cpuPercent: 0.2, memoryUsageBytes: 1024 * 1024, networkRxBytes: 500, networkTxBytes: 300, blockReadBytes: 200, blockWriteBytes: 100, networkIoDeltaBytes: 0, blockIoDeltaBytes: 0, inactivity: 'Low activity observed across 31 stored samples over 15 minutes.', reason: 'CPU below 1% and network/block I/O changes below 1024 bytes per sample.' }],
    recommendations: [], history: [], recentDiagnoses: [],
  };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(); const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return json({ user });
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: now });
    if (path === '/brain') return json(dashboard);
    if (path === '/docker/containers/' + id + '/stop' && request.method() === 'POST') { stopCalls += 1; return json({ id, name: 'idle-worker', state: 'exited', status: 'Exited', action: 'stop' }); }
    return json({ error: 'Not found' }, 404);
  });
  await page.goto('/smart-sleep');
  await expect(page.getByRole('heading', { name: 'Smart Auto-Sleep' })).toBeVisible();
  await expect(page.getByText('idle-worker')).toBeVisible();
  await page.getByRole('button', { name: 'Review and stop' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(stopCalls).toBe(0);
  await page.getByRole('button', { name: 'Review and stop' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop container' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'idle-worker was stopped.' })).toBeVisible();
  expect(stopCalls).toBe(1);
});
