import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PREFS = 'the-signal:prefs:v1';

async function open(page: Page, hash = '') {
  await page.goto(hash ? `./${hash}` : './');
  await expect(page.locator('.masthead-name')).toHaveText('Signal');
  if (!hash) await expect(page.locator('.lead-headline')).toBeVisible();
}

test.describe('front page', () => {
  test('shows the masthead, the lead story and all six sections', async ({ page }) => {
    await open(page);
    for (const t of ['U.S. & Politics', 'World News', 'Markets & Technology', 'Outside the Mainstream', 'The Airwaves', "The People's Pulse"]) {
      await expect(page.getByRole('heading', { level: 2, name: t, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: /Global Perspectives/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Most covered, last six hours/ })).toBeVisible();
    await expect(page.locator('.status')).toContainText('Prototype capture');
  });

  test('counts outlets rather than claiming independent reports, and names shared copy', async ({ page }) => {
    await open(page);
    const kicker = page.locator('.lead .kicker');
    await expect(kicker).toContainText('7 outlets covering this story');
    await expect(kicker).toContainText('7 countries');
    await expect(kicker).toContainText('2 with shared wire or identical copy');
    await expect(page.locator('body')).not.toContainText(/independent reports?/i);
  });

  test('opens the comparison table with every outlet and marks the syndicated headline', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /Compare how 7 outlets in 7 countries headlined it/ }).click();
    const table = page.locator('.persp-table');
    await expect(table.locator('tbody tr')).toHaveCount(7);
    await expect(table).toContainText('Same headline as Gulf Monitor');
    await expect(table).toContainText('credits Example Wire');
  });

  test('never scrolls sideways', async ({ page }) => {
    for (const width of [320, 390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `width ${width}`).toBeLessThanOrEqual(0);
    }
  });

  test('renders hostile feed text as text and drops unsafe links', async ({ page }) => {
    await page.route('**/data/snapshot.json', async (route) => {
      const res = await route.fetch();
      const w = await res.json();
      w.articles[0].t = '<img src=x onerror="window.__pwned=1">Ferry capsizes';
      w.articles[1].u = 'javascript:window.__pwned=2';
      await route.fulfill({ response: res, json: w });
    });
    await open(page);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  test('says plainly when collection has paused, and when it is merely late', async ({ page }) => {
    for (const [hoursAgo, text] of [[7, 'Collection paused: showing the last good update'], [1, 'Last updated']] as const) {
      await page.route('**/data/snapshot.json', async (route) => {
        const res = await route.fetch();
        const w = await res.json();
        w.mode = 'live';
        w.generatedAt = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
        await route.fulfill({ response: res, json: w });
      });
      await open(page);
      await expect(page.locator('.status')).toContainText(text);
      await page.unroute('**/data/snapshot.json');
    }
  });
});

test.describe('preferences', () => {
  test('remember the theme across a reload', async ({ page }) => {
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), PREFS))!).theme).toBe('light');
  });

  test('hide a section and turn a source off, and keep both after a reload', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Preferences' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Preferences' });
    await dialog.getByRole('checkbox', { name: 'The Airwaves' }).uncheck();
    await dialog.getByRole('checkbox', { name: /Thames Herald/ }).uncheck();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { level: 2, name: 'The Airwaves', exact: true })).toHaveCount(0);
    await expect(page.locator('.pub', { hasText: 'Thames Herald' })).toHaveCount(0);
  });
});

test.describe('search', () => {
  test('finds headlines and narrows them with filters', async ({ page }) => {
    await open(page);
    await page.getByRole('searchbox', { name: 'Search headlines' }).fill('varnu');
    await expect(page.locator('#sr-h')).toContainText('8 headlines matching "varnu"');
    await page.getByLabel('Country').selectOption('JP');
    await expect(page.locator('#sr-h')).toContainText('1 headline matching');
    await expect(page.locator('.search-results .story .cc')).toHaveText(['JP']);
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(page.locator('#sr-h')).toContainText('8 headlines');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.locator('.lead-headline')).toBeVisible();
  });
});

test.describe('RSS', () => {
  test('lists every feed, from the utility bar and from a section icon', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await page.getByRole('link', { name: 'RSS feeds' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: /RSS Feeds/ })).toBeVisible();
    await expect(page.locator('.feed')).toHaveCount(9);
    await expect(page.locator('.feed-url code').first()).toHaveText('https://radmagelabs.com/signal/rss.xml');
    await expect(page.locator('.notice-inline')).toContainText('not published yet');
    await page.locator('.copy-btn').first().click();
    await expect(page.locator('.copy-btn').first()).toHaveText(/Copied|Select and copy/);
    await page.goto('./');
    await page.getByRole('link', { name: 'RSS feed: World News' }).click();
    await expect(page.locator('#feed-world')).toHaveClass(/focus/);
  });

  test('advertises the feeds for autodiscovery and serves them as RSS with validators', async ({ page, request }) => {
    await open(page);
    const alternates = page.locator('link[rel="alternate"][type="application/rss+xml"]');
    await expect(alternates).toHaveCount(9);
    const res = await request.get('rss/world.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/rss+xml; charset=utf-8');
    const etag = res.headers()['etag']!;
    expect((await res.text()).startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const again = await request.get('rss/world.xml', { headers: { 'if-none-match': etag } });
    expect(again.status()).toBe(304);
  });
});

test.describe('pages and accessibility', () => {
  test('the About page carries the open internet statement', async ({ page }) => {
    await open(page, '#/about');
    await expect(page.locator('.statement')).toHaveText(
      'The Signal is built in the spirit of the open internet. We believe information should be discoverable, perspectives should be accessible, and readers should be free to draw their own conclusions. Our purpose is to connect people with information, not to control their attention.');
  });

  for (const [name, hash] of [['front page', ''], ['RSS feeds', '#/feeds'], ['source directory', '#/sources'], ['methodology', '#/about']] as const) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${name} has no serious accessibility violations (${theme})`, async ({ page }) => {
        await page.addInitScript(([k, t]: string[]) => localStorage.setItem(k!, JSON.stringify({ v: 1, theme: t, density: 'compact', hiddenSections: [], disabledSources: [] })), [PREFS, theme]);
        await open(page, hash);
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(bad.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0]?.target.join(' ')})`)).toEqual([]);
      });
    }
  }
});
