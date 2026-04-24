import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,  // Run tests sequentially to avoid conflicts
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,  // Single worker for stability
  reporter: 'html',
  timeout: 600000,  // 10 minutes per test (for long campaigns)
  expect: { timeout: 10000 },
  use: {
    baseURL: 'https://theystillsing.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 30000,
    actionTimeout: 10000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  // webServer is optional - tests run against baseURL (production server)
  // To test locally, set webServer config and baseURL to http://localhost:3000
});
