import { expect, test } from '@playwright/test';

const NOW = '2026-10-31T10:00:00.000Z';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Test User', email: 'test@example.invalid', createdAt: NOW, updatedAt: NOW };

test('protected navigation redirects to login, surfaces auth errors, and returns to the requested page', async ({ page }) => {
  let authenticated = false;
  let loginAttempts = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return authenticated ? json({ user: USER }) : json({ error: 'Authentication required.' }, 401);
    if (path === '/auth/login' && request.method() === 'POST') {
      loginAttempts += 1;
      const body = request.postDataJSON() as { email: string; password: string };
      if (body.password !== 'correct-password') return json({ error: 'Email or password is incorrect.' }, 401);
      authenticated = true;
      return json({ user: USER });
    }
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/activity') return json({ activities: [], page: 1, pageSize: 30, hasMore: false });
    return json({ error: `Unexpected request ${request.method()} ${path}` }, 404);
  });

  await page.goto('/activity');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Email address').fill('test@example.invalid');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Email or password is incorrect.');
  await page.getByLabel('Password').fill('correct-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { name: 'Activity history' })).toBeVisible();
  expect(loginAttempts).toBe(2);
});

test('registration validates password length before sending credentials', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    if (path === '/auth/me') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication required.' }) });
    if (path === '/health') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW }) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found.' }) });
  });
  await page.goto('/register');
  await page.getByLabel('Your name').fill('Test User');
  await page.getByLabel('Email address').fill('test@example.invalid');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('Use at least 12 characters');
});

test('session cookie restores auth after refresh and authorizes project registration', async ({ page }) => {
  const projectId = '22222222-2222-4222-8222-222222222222';
  let created = false;
  const requests: string[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    requests.push(`${request.method()} ${path}`);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return created || request.headers().cookie?.includes('dockerpilot_session=')
      ? json({ user: USER })
      : json({ error: 'Authentication required.' }, 401);
    if (path === '/auth/login' && request.method() === 'POST') {
      return json({ user: USER }, 200, { 'set-cookie': 'dockerpilot_session=test-session; Path=/; HttpOnly; SameSite=Lax' });
    }
    if (path === '/projects' && request.method() === 'POST') {
      expect(request.headers().cookie).toContain('dockerpilot_session=');
      created = true;
      return json({ id: projectId, name: 'Session project', description: null, repositoryUrl: null, createdAt: NOW, updatedAt: NOW });
    }
    if (path === `/projects/${projectId}`) return json({ id: projectId, name: 'Session project', description: null, repositoryUrl: null, createdAt: NOW, updatedAt: NOW });
    if (path === '/health') return json({ status: 'ok', service: 'dockerpilot-api', timestamp: NOW });
    if (path === '/projects') return json([]);
    return json({ error: `Unexpected request ${request.method()} ${path}` }, 404);
  });

  await page.goto('/login');
  await page.getByLabel('Email address').fill(USER.email);
  await page.getByLabel('Password').fill('correct-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects,' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your projects,' })).toBeVisible();
  await page.getByRole('link', { name: /Register a project/ }).click();
  await page.getByLabel(/Project name/).fill('Session project');
  await page.getByRole('button', { name: 'Register project' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  expect(requests).toContain('POST /projects');
});
