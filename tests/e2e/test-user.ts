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

    // First, use API to login and get the auth cookie
    const loginRes = await page.request.post(`${baseURL}/auth/login`, {
      data: {
        email: TEST_USER.email,
        password: TEST_USER.password,
      },
    });

    if (!loginRes.ok()) {
      console.error(`❌ API login failed: ${loginRes.status()}`);
      return false;
    }

    const loginData = await loginRes.json();
    const setCookieHeader = loginRes.headers()['set-cookie'];

    // Extract the auth cookie from the response and add it to the page context
    if (setCookieHeader) {
      // Parse the cookie string to extract just the tt_token value
      const cookieMatch = setCookieHeader.match(/tt_token=([^;]+)/);
      if (cookieMatch) {
        // Add cookie to page context for all subsequent requests
        await page.context().addCookies([
          {
            name: 'tt_token',
            value: cookieMatch[1],
            domain: new URL(baseURL).hostname,
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ]);
      }
    }

    console.log(`✅ Test user logged in via API: ${loginData.user.email}`);
    return true;
  } catch (err: any) {
    console.error('❌ Error logging in test user:', err.message);
    return false;
  }
}
