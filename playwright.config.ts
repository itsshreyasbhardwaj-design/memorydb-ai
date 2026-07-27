import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Playwright starts the app itself, so `pnpm test:e2e` needs no running server.
 * The app boots with in-memory storage and local embeddings, meaning e2e runs in
 * CI with no database and no API keys.
 */
export default defineConfig({
  testDir: './tests/e2e',
  /**
   * Serial by default. Every spec talks to one app instance backed by a single
   * in-memory store, and the dashboard specs mutate shared state — the
   * consolidation test rewrites the whole namespace. Running them concurrently
   * saturates the server and produces failures that look like bugs but are
   * contention. The API specs opt back into parallelism below, because each one
   * scopes itself to a unique namespace.
   */
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 45_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // API specs authenticate per-request with a bearer key and must run without
    // a browser session, so they get no storage state. Each test uses its own
    // namespace, which makes them safe to run concurrently.
    {
      name: 'api',
      testMatch: /api\.spec\.ts/,
      fullyParallel: true,
      use: { ...devices['Desktop Chrome'] },
    },

    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      testMatch: /dashboard\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/state.json' },
    },
    {
      name: 'mobile',
      testMatch: /dashboard\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: 'tests/e2e/.auth/state.json' },
    },
  ],

  webServer: {
    command: 'pnpm --filter @memorydb/web start --port 3200',
    url: 'http://localhost:3200/api/v1/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      MEMORYDB_API_KEY: 'mdb_test_E2EKEYNOTUSEDANYWHEREELSE0000',
      STORAGE_DRIVER: 'memory',
    },
  },
});
