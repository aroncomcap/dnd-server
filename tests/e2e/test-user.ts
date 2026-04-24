import { APIRequestContext } from '@playwright/test';

/**
 * Test user credentials for E2E testing
 * These are fake credentials used only for automated testing
 */
export const TEST_USER = {
  email: 'test-bot@theystillsing.test',
  password: 'TestPassword12345!@#',
  displayName: 'Test Bot',
};

/**
 * Register or login a test user
 * Returns auth cookie to use in subsequent requests
 */
export async function setupTestUser(
  request: APIRequestContext,
  baseURL: string
): Promise<{ userId: string; cookie: string } | null> {
  try {
    // First try to register
    const registerRes = await request.post(`${baseURL}/auth/register`, {
      data: {
        email: TEST_USER.email,
        password: TEST_USER.password,
        displayName: TEST_USER.displayName,
      },
    });

    if (registerRes.ok()) {
      const data = await registerRes.json();
      console.log(`✅ Test user registered: ${TEST_USER.email}`);
      return {
        userId: data.user.id,
        cookie: registerRes.headers()['set-cookie'] || '',
      };
    }

    // If registration fails (user already exists), try to login
    const loginRes = await request.post(`${baseURL}/auth/login`, {
      data: {
        email: TEST_USER.email,
        password: TEST_USER.password,
      },
    });

    if (loginRes.ok()) {
      const data = await loginRes.json();
      console.log(`✅ Test user logged in: ${TEST_USER.email}`);
      return {
        userId: data.user.id,
        cookie: loginRes.headers()['set-cookie'] || '',
      };
    }

    console.error('❌ Failed to setup test user:', loginRes.status());
    return null;
  } catch (err) {
    console.error('❌ Error setting up test user:', err);
    return null;
  }
}

/**
 * Login test user in browser and get auth token
 */
export async function loginTestUserInBrowser(page: any, baseURL: string): Promise<boolean> {
  try {
    console.log(`🔐 Logging in test user: ${TEST_USER.email}`);

    // Navigate to lobby (will redirect to login if not authenticated)
    await page.goto(`${baseURL}/lobby`);

    // Check if auth gate is visible
    const authGate = page.locator('#auth-gate');
    const isAuthGateVisible = await authGate.isVisible().catch(() => false);

    if (!isAuthGateVisible) {
      console.log('✅ Already authenticated');
      return true;
    }

    // Find and fill email/password inputs
    const emailInput = page.locator('#auth-email');
    const passwordInput = page.locator('#auth-password');
    const loginBtn = page.locator('#btn-password-login');

    if (
      !(await emailInput.isVisible().catch(() => false)) ||
      !(await passwordInput.isVisible().catch(() => false))
    ) {
      console.error('❌ Login form not found');
      return false;
    }

    // Fill and submit
    await emailInput.fill(TEST_USER.email);
    await passwordInput.fill(TEST_USER.password);
    await loginBtn.click();

    // Wait for redirect to lobby
    await page.waitForURL(/\/(lobby|new-game)/);
    await page.waitForLoadState('networkidle');

    console.log('✅ Test user logged in successfully');
    return true;
  } catch (err) {
    console.error('❌ Error logging in test user:', err);
    return false;
  }
}
