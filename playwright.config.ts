import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the production build, served by `vite preview` with the
// synthetic fixture site (tests/fixtures/site), never a private capture.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4392/signal/',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npx vite build --logLevel error && npx vite preview --host 127.0.0.1 --port 4392 --strictPort',
    url: 'http://127.0.0.1:4392/signal/',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { SIGNAL_SITE: 'tests/fixtures/site' },
  },
});
