import { expect, test } from '@playwright/test';

const NOW = '2026-11-16T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'New User', email: 'new@example.invalid', createdAt: NOW, updatedAt: NOW };

test('local user pairs this computer with a one-time code and agent command', async ({ page }) => {
  let authenticated = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return authenticated ? json({ user: USER }) : json({ error: 'Authentication required.' }, 401);
    if (path === '/auth/login' && request.method() === 'POST') { authenticated = true; return json({ user: USER }); }
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/projects') return json([]);
    if (path === '/docker/status') return json({ reachable: false, engine: null, message: 'Docker Engine is unavailable.' });
    if (path === '/docker/containers') return json([]);
    if (path === '/agents') return json({ agents: [] });
    if (path === '/agents/pairing-challenges' && request.method() === 'POST') return json({ code: 'pairing-code-for-test-only', expiresAt: '2026-11-16T10:05:00.000Z' }, 201);
    return json({ error: `Unexpected request ${request.method()} ${path}` }, 404);
  });

  await page.goto('/login');
  await page.getByLabel('Email address').fill(USER.email);
  await page.getByLabel('Password').fill('correct-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Pair this computer' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair This Computer' }).click();
  await expect(page.getByText('pairing-code-for-test-only')).toBeVisible();
  await expect(page.getByText('npm run agent:dev --workspace @dockerpilot/backend -- pair', { exact: true })).toBeVisible();
});
