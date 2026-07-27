/**
 * Authenticates once and saves the browser storage state, so dashboard specs
 * start signed in instead of repeating the sign-in flow per test.
 */
import { expect, test as setup } from '@playwright/test';

const STORAGE_STATE = 'tests/e2e/.auth/state.json';
const API_KEY = 'mdb_test_E2EKEYNOTUSEDANYWHEREELSE0000';

setup('authenticate', async ({ page }) => {
  await page.goto('/sign-in');

  await page.getByLabel('API key').fill(API_KEY);
  await page.getByRole('button', { name: /sign in/i }).click();

  // The redirect landing on the dashboard is the signal that the cookie was set.
  await page.waitForURL('**/dashboard', { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });

  await page.context().storageState({ path: STORAGE_STATE });
});
