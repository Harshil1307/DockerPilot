import { expect, test } from '@playwright/test';

const NOW = '2026-11-16T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'New User', email: 'new@example.invalid', createdAt: NOW, updatedAt: NOW };

test('new hosted user sees Docker, agent, pairing, and developer database steps in order', async ({ page }) => {
  let authenticated = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return authenticated ? json({ user: USER }) : json({ error: 'Authentication required.' }, 401);
    if (path === '/auth/login' && request.method() === 'POST') { authenticated = true; return json({ user: USER }); }
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/projects') return json([]);
    if (path === '/docker/status') return json({ reachable: false, engine: null, message: 'No local Docker agent is connected.' });
    if (path === '/docker/containers') return json([]);
    if (path === '/agents') return json({ agents: [] });
    if (path === '/agents/pairing-challenges' && request.method() === 'POST') return json({ code: 'pairing-code-for-test-only', expiresAt: '2026-11-16T10:05:00.000Z' }, 201);
    return json({ error: `Unexpected request ${request.method()} ${path}` }, 404);
  });

  await page.goto('/login');
  await page.getByLabel('Email address').fill(USER.email);
  await page.getByLabel('Password').fill('correct-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const heading = page.getByRole('heading', { name: 'Welcome to DockerPilot. Let’s connect your Docker environment.' });
  await expect(heading).toBeVisible();
  const steps = await page.locator('.setup-steps').innerText();
  expect(steps.indexOf('Install and open Docker Desktop')).toBeLessThan(steps.indexOf('Verify the Docker Engine'));
  expect(steps.indexOf('Verify the Docker Engine')).toBeLessThan(steps.indexOf('Install the DockerPilot Agent'));
  expect(steps.indexOf('Install the DockerPilot Agent')).toBeLessThan(steps.indexOf('Pair this computer'));
  await expect(page.getByText('docker version', { exact: true })).toBeVisible();
  await expect(page.getByText(/PostgreSQL is not needed to connect this computer/)).toBeVisible();
  await page.getByText('Developer setup: run DockerPilot’s backend and PostgreSQL locally').click();
  await expect(page.getByText('docker compose up -d postgres', { exact: true })).toBeVisible();
  await expect(page.getByText('npm run db:migrate --workspace backend', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Generate pairing code' }).click();
  await expect(page.getByText('pairing-code-for-test-only')).toBeVisible();
  await expect(page.getByText('npm run agent:dev --workspace @dockerpilot/backend -- pair', { exact: true })).toBeVisible();
});
