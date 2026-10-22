import { expect, test } from '@playwright/test';

test('iPhone Safari sees the N2 install hint without horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByText(/Trong Safari, bấm Chia sẻ/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toBe('icons/apple-touch-icon.png');
    const icon = await page.request.get('/icons/apple-touch-icon.png');
    expect(icon.ok()).toBe(true);
    expect(icon.headers()['content-type']).toContain('image/png');
  } finally {
    await context.close();
  }
});

test('N2 app shell can reopen without network after being cached', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 15000 });
  // One controlled online navigation caches dynamically imported modules.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Bắt đầu học N2' })).toBeVisible();
  await page.context().setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('.masthead-title')).toContainText('N2');
    await expect(page.getByRole('heading', { name: 'Bắt đầu học N2' })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});
