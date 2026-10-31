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
