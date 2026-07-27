/**
 * Dashboard end-to-end tests.
 *
 * These verify the UI renders real data and that the primary flows work, plus
 * baseline accessibility properties that are easy to regress.
 */
import { expect, test } from '@playwright/test';

test.describe('landing page', () => {
  test('renders the hero and links to the dashboard', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('forgets');
    await expect(page.getByRole('link', { name: /open the dashboard/i })).toBeVisible();
  });

  test('has no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(errors).toHaveLength(0);
  });
});

test.describe('overview', () => {
  test('renders statistics and charts', async ({ page }) => {
    await page.goto('/dashboard');

    const main = page.getByRole('main');

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    // Scoped to <main>: the sidebar contains links with these same labels, and
    // an unscoped text match would be ambiguous under strict mode.
    await expect(main.getByText('Total memories')).toBeVisible();
    await expect(main.getByText('Knowledge graph')).toBeVisible();
    await expect(main.getByText('Memory growth')).toBeVisible();

    // The demo corpus seeds six memories, so the counter must not read zero.
    const totalCard = main.getByText('Total memories').locator('..');
    await expect(totalCard).not.toContainText(/^0$/);
  });

  test('runs consolidation from the UI', async ({ page }) => {
    await page.goto('/dashboard');

    await page.getByRole('button', { name: /consolidate/i }).click();
    await expect(page.getByText(/consolidation complete/i)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('memories', () => {
  test('lists memories and creates a new one', async ({ page }) => {
    await page.goto('/dashboard/memories');
    await expect(page.getByRole('heading', { name: 'Memories' })).toBeVisible();

    await page.getByRole('button', { name: /new memory/i }).click();

    const content = `E2E created memory ${Date.now()}`;
    await page.getByLabel('Memory content').fill(content);
    await page.getByRole('button', { name: /store memory/i }).click();

    await expect(page.getByText(/memory stored|matched an existing memory/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(content)).toBeVisible();
  });

  test('filters by memory type', async ({ page }) => {
    await page.goto('/dashboard/memories');
    await page.getByRole('button', { name: 'Semantic', exact: true }).click();

    await expect(page.getByRole('button', { name: /clear/i })).toBeVisible();
  });
});

test.describe('search', () => {
  test('returns ranked results with a score breakdown', async ({ page }) => {
    await page.goto('/dashboard/search');

    await page.getByLabel('Search query').fill('database');
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    // A stored memory happens to contain the phrase "results for", so match the
    // summary line by its full shape rather than a bare substring.
    await expect(page.getByText(/\d+ results for/i).first()).toBeVisible({ timeout: 15_000 });

    // The per-signal breakdown only renders when `explain` is on.
    await expect(page.getByText('vector', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('keyword', { exact: true }).first()).toBeVisible();
  });

  test('builds model-ready context', async ({ page }) => {
    await page.goto('/dashboard/search');

    await page.getByLabel('Search query').fill('how do we deploy');
    await page.getByRole('button', { name: /retrieve/i }).click();

    await expect(page.getByText('Model-ready context')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Relevant memories:/)).toBeVisible();
  });
});

test.describe('knowledge graph', () => {
  test('renders an interactive graph', async ({ page }) => {
    await page.goto('/dashboard/graph');

    await expect(page.getByRole('heading', { name: 'Knowledge graph' })).toBeVisible();
    await expect(page.getByRole('img', { name: /knowledge graph with/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/entities/).first()).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('exposes a skip link and landmarks', async ({ page }) => {
    await page.goto('/dashboard');

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /skip to content/i })).toBeFocused();

    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
  });

  test('marks the current page in navigation', async ({ page }) => {
    await page.goto('/dashboard/search');
    // Both the desktop sidebar and the mobile bar mark the current page, and one
    // of them is hidden at any given viewport — assert on the visible one.
    await expect(page.locator('[aria-current="page"]:visible').first()).toBeVisible();
  });

  test('is navigable by keyboard', async ({ page }) => {
    await page.goto('/dashboard');

    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(['A', 'BUTTON', 'INPUT']).toContain(focused);
  });
});

test.describe('theming', () => {
  test('toggles between dark and light', async ({ page }) => {
    await page.goto('/dashboard');

    const initial = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: /switch to (light|dark) theme/i }).click();

    const toggled = await page.locator('html').getAttribute('data-theme');
    expect(toggled).not.toBe(initial);

    // The choice must survive a reload.
    await page.reload();
    expect(await page.locator('html').getAttribute('data-theme')).toBe(toggled);
  });
});

test.describe('responsive', () => {
  test('renders on a mobile viewport without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});
