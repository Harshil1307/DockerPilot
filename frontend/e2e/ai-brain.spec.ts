import { expect, test, type Route } from '@playwright/test';

const now = '2026-11-17T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: now, updatedAt: now };
const container = { id: 'a'.repeat(64), name: 'web-api', image: 'example/api:1', state: 'running', status: 'Up 2 hours', createdAt: now, health: 'healthy', restartCount: 0, startedAt: now, exitCode: 0, cpuPercent: 92.1, memoryUsageBytes: 128 * 1024 * 1024, memoryLimitBytes: 256 * 1024 * 1024, networkRxBytes: 1000, networkTxBytes: 2000, blockReadBytes: 3000, blockWriteBytes: 4000 };

test('AI Brain shows real metric evidence and contextual chat response', async ({ page }) => {
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(); const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return json({ user: USER });
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: now });
    if (path === '/brain' && request.method() === 'GET') return json({
      status: 'ready', message: null, sampledAt: now, systemHealth: 'attention', containerCount: 1, warnings: 1, criticalIssues: 0,
      topCpu: [container], topMemory: [container], containers: [container],
      anomalies: [{ severity: 'warning', title: 'High CPU sample', container: 'web-api', evidence: 'Sampled CPU: 92.1%', recommendation: 'Compare another sample.' }],
      events: [{ id: container.id, name: 'web-api', image: container.image, action: 'die', time: now }], eventsUnavailable: false,
      idleCandidates: [], recommendations: [{ title: 'Review resource use for web-api', reason: 'CPU was 92.1% in this sample.' }],
      history: [{ sampledAt: now, data: { containerCount: 1, warningCount: 1, criticalCount: 0 } }],
      recentDiagnoses: [{ id: 'scan-1', createdAt: now, project: { name: 'Storefront' }, report: { healthScore: 78, criticalCount: 0, warningCount: 2 } }],
    });
    if (path === '/brain/chat' && request.method() === 'POST') return json({ answer: 'The web-api container used 92.1% CPU in the latest sample. Take another sample to see whether it persists.', sampledAt: now, provider: 'test-model' });
    return json({ error: 'Not found' }, 404);
  });
  await page.goto('/brain');
  await expect(page.getByRole('heading', { name: 'AI Brain' })).toBeVisible();
  await expect(page.getByText('web-api', { exact: true }).first()).toBeVisible();
  await page.getByText('High CPU sample').click();
  await expect(page.getByText('Sampled CPU: 92.1%')).toBeVisible();
  await expect(page.getByText('Storefront · 78/100')).toBeVisible();
  await expect(page.getByText('die', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Question for AI Brain' }).fill('Why is CPU high?');
  await page.getByRole('button', { name: 'Ask AI Brain' }).click();
  await expect(page.getByText(/used 92.1% CPU in the latest sample/)).toBeVisible();
});
