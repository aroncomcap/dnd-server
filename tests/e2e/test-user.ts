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
 * Registers user if needed, then logs in
 */
export async function loginTestUserInBrowser(page: any, baseURL: string): Promise<boolean> {
  try {
    console.log(`🔐 Logging in test user: ${TEST_USER.email}`);

    // Step 1: Try to register (will fail if user exists, which is ok)
    console.log(`📝 Attempting to register test user...`);
    const registerRes = await page.request.post(`${baseURL}/auth/register`, {
      data: {
        email: TEST_USER.email,
        password: TEST_USER.password,
        displayName: TEST_USER.displayName,
      },
    });

    if (registerRes.ok()) {
      console.log(`✅ Test user registered`);
    } else if (registerRes.status() === 409) {
      console.log(`ℹ️  Test user already exists`);
    } else {
      console.log(`⚠️  Register returned ${registerRes.status()}, attempting login anyway...`);
    }

    // Step 2: Login with credentials
    const loginRes = await page.request.post(`${baseURL}/auth/login`, {
      data: {
        email: TEST_USER.email,
        password: TEST_USER.password,
      },
    });

    if (!loginRes.ok()) {
      const errorData = await loginRes.json().catch(() => ({}));
      console.error(`❌ API login failed ${loginRes.status()}: ${(errorData as any).error || 'Unknown error'}`);
      return false;
    }

    const loginData = await loginRes.json();
    const setCookieHeader = loginRes.headers()['set-cookie'];

    // Step 3: Extract and set auth cookie
    if (setCookieHeader) {
      const cookieMatch = setCookieHeader.match(/tt_token=([^;]+)/);
      if (cookieMatch) {
        const urlObj = new URL(baseURL!);
        await page.context().addCookies([
          {
            name: 'tt_token',
            value: cookieMatch[1],
            domain: urlObj.hostname,
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ]);
        console.log(`✅ Auth cookie set`);
      }
    }

    console.log(`✅ Test user logged in successfully`);
    return true;
  } catch (err: any) {
    console.error('❌ Error in loginTestUserInBrowser:', err.message);
    return false;
  }
}
