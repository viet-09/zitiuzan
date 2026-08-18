import { test, expect } from '@playwright/test';
import axeCore from 'axe-core';

async function dismissAuthGateForComponentChecks(page) {
  await expect(page.getByRole('heading', { name: 'Bắt đầu học N2' })).toBeVisible();
  await page.evaluate(() => {
    document.querySelector('.auth-modal')?.remove();
    document.querySelectorAll('[inert]').forEach((element) => {
      element.inert = false;
      element.removeAttribute('aria-hidden');
    });
  });
}

test('Google sign-in is mandatory and a legacy guest preference cannot bypass it', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('n2_guest_mode_v1', '1'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bắt đầu học N2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đăng nhập bằng Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dùng thử không đăng nhập' })).toHaveCount(0);
  await expect(page.locator('#app')).toHaveAttribute('inert', '');
});

test('adaptive dashboard search and lesson review work end to end', async ({ page }) => {
  await page.goto('/');
  await dismissAuthGateForComponentChecks(page);
  await expect(page.getByRole('heading', { name: 'Hôm nay học gì?' })).toBeVisible();
  await expect(page.locator('.lessons-grid:visible')).toHaveCount(5);
  await expect(page.locator('.lesson-item')).toHaveCount(33);

  const search = page.getByRole('searchbox', { name: 'Tìm trong toàn bộ nội dung N2' });
  await search.fill('ngữ pháp');
  await expect(page.locator('.search-result-grid .plan-item').first()).toBeVisible();

  await page.goto('/#/lesson/g1d1');
  await expect(page.locator('.lesson-header-title')).toBeVisible();
  const bookmark = page.getByRole('button', { name: 'Lưu bài học' });
  await bookmark.click();
  await expect(page.getByRole('button', { name: 'Bỏ lưu bài học' })).toBeVisible();

  const quiz = page.locator('.quiz-question').first();
  if (await quiz.count()) {
    await quiz.locator('[data-action="quiz-option"]').first().click();
    await expect(quiz).toHaveClass(/is-answered/);
  }
});

test('book reader keeps every source image inside one continuous page strip', async ({ page }) => {
  await page.goto('/#/lesson/k1d2');
  await dismissAuthGateForComponentChecks(page);
  await page.getByRole('button', { name: 'Xem trang sách' }).click();

  const strip = page.locator('.book-viewer-strip');
  await expect(strip).toBeVisible();
  await expect(page.locator('.book-viewer-figure')).toHaveCount(0);
  await expect(strip.locator('.book-viewer-page')).toHaveCount(4);
});

test('a due weakness launches a mini-test and updates readiness evidence', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('n2_reviews_v1', JSON.stringify([{
      key: 'g1d1:q0', lessonId: 'g1d1', categoryId: 'grammar',
      prompt: 'もう雨は降る（　）。',
      options: ['ために', 'に違いない'], correctIndex: 1, correctAnswer: 'に違いない',
      attempts: 2, correctAttempts: 0, lapses: 2, lastResult: 'wrong',
      lastReviewedAt: '2026-08-17T00:00:00Z', dueAt: '2026-08-17T00:00:00Z',
    }]));
  });
  await page.goto('/');
  await dismissAuthGateForComponentChecks(page);

  await page.getByRole('button', { name: /Mini-test 1 câu/ }).click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page.getByRole('heading', { name: 'Mini-test điểm yếu' })).toBeVisible();
  await page.getByRole('button', { name: 'に違いない' }).click();
  await page.getByRole('button', { name: 'Xem kết quả' }).click();
  await expect(page.getByText(/Readiness hiện tại/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Hỏi gia sư về điểm yếu/ })).toBeVisible();
});

test('mobile dashboard has no horizontal overflow and passes serious axe checks', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await dismissAuthGateForComponentChecks(page);
  await expect(page.locator('#learning-hub')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.evaluate(axeCore.source);
  const result = await page.evaluate(async () => axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
  }));
  const serious = result.violations.filter((item) => ['serious', 'critical'].includes(item.impact));
  expect(serious, serious.map((item) => `${item.id}: ${item.help}`).join('\n')).toEqual([]);
});
