import { test, expect } from '@playwright/test';
import axeCore from 'axe-core';

async function dismissAuthGateForComponentChecks(page) {
  const gate = page.locator('.auth-modal');
  await gate.waitFor({ state: 'attached', timeout: 2_000 }).catch(() => {});
  if (await gate.count()) {
    await page.evaluate(() => {
      document.querySelector('.auth-modal')?.remove();
      document.querySelectorAll('[inert]').forEach((element) => {
        element.inert = false;
        element.removeAttribute('aria-hidden');
      });
    });
  }
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
  await expect(page.locator('.daily-plan .plan-item')).toHaveCount(3);
  await expect(page.locator('.curriculum-browser')).toBeHidden();
  await page.getByRole('button', { name: 'Xem toàn bộ giáo trình' }).click();
  await expect(page.locator('.lessons-grid:visible')).toHaveCount(5);
  await expect(page.locator('.lesson-item')).toHaveCount(33);

  const search = page.getByRole('searchbox', { name: 'Tìm trong toàn bộ nội dung N2' });
  await search.fill('ngữ pháp');
  await expect(page.locator('.search-result-grid .plan-item').first()).toBeVisible();

  await page.goto('/#/lesson/g1d1');
  await dismissAuthGateForComponentChecks(page);
  await expect(page.locator('.lesson-header-title')).toBeVisible();
  const bookmark = page.getByRole('button', { name: 'Lưu bài học' });
  await bookmark.click();
  await expect(page.getByRole('button', { name: 'Bỏ lưu bài học' })).toBeVisible();

  const quiz = page.locator('.quiz-question[data-correct-idx]:not([data-correct-idx="-1"])').first();
  if (await quiz.count()) {
    const correct = Number(await quiz.getAttribute('data-correct-idx'));
    const options = quiz.locator('[data-action="quiz-option"]');
    const wrong = correct === 0 ? 1 : 0;
    await options.nth(wrong).click();
    await expect(quiz).toHaveClass(/is-answered/);
    await expect(quiz.getByRole('button', { name: 'Hỏi gia sư về lỗi này' })).toBeVisible();
  }
});

test('lesson outline reports local quiz progress and book modal contains focus', async ({ page }) => {
  await page.goto('/#/lesson/k1d2');
  await dismissAuthGateForComponentChecks(page);

  const outline = page.getByRole('navigation', { name: 'Mục lục bài học' });
  await expect(outline).toBeVisible();
  await expect(outline.getByText(/0\/\d+ câu/)).toBeVisible();

  const trigger = page.getByRole('button', { name: 'Xem trang sách' });
  await trigger.click();
  await expect(page.locator('body')).toHaveClass(/modal-open/);
  await expect(page.locator('#app')).toHaveAttribute('inert', '');
  const close = page.getByRole('button', { name: 'Đóng trình đọc sách' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.book-viewer-overlay')).toHaveCount(0);
  await expect(trigger).toBeFocused();
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

  await page.getByRole('button', { name: 'Ôn 3 phút' }).click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page.getByRole('heading', { name: 'Mini-test điểm yếu' })).toBeVisible();
  await page.getByRole('button', { name: 'に違いない' }).click();
  await page.getByRole('button', { name: 'Xem kết quả' }).click();
  await expect(page.getByText(/Mức sẵn sàng hiện tại/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Hỏi gia sư về điểm yếu/ })).toBeVisible();
});

test('pet opens one calm next-action coach panel and avoids the nav while scrolling', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('n2_reviews_v1', JSON.stringify([{
      key: 'g1d1:q0', lessonId: 'g1d1', categoryId: 'grammar', prompt: '雨が降る（　）。',
      options: ['ために', 'に違いない'], correctIndex: 1, correctAnswer: 'に違いない',
      attempts: 2, correctAttempts: 0, lapses: 2, lastResult: 'wrong',
      lastReviewedAt: '2026-08-17T00:00:00Z', dueAt: '2026-08-17T00:00:00Z',
    }]));
  });
  await page.goto('/');
  await dismissAuthGateForComponentChecks(page);
  const pet = page.getByRole('button', { name: /Mở coach học tập/ });
  await pet.click();
  const panel = page.getByRole('region', { name: 'Nhiệm vụ của bạn đồng hành' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ôn 3 phút' })).toBeVisible();
  await expect(panel).toContainText('lỗi ngữ pháp');
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect(page.locator('#pet-widget-mount')).toHaveClass(/is-compact/);
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

  await page.goto('/#/lesson/k1d2');
  await dismissAuthGateForComponentChecks(page);
  await page.getByRole('button', { name: 'Xem trang sách' }).click();
  const box = await page.locator('.book-viewer-card').boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  expect(Math.round(box?.width || 0)).toBe(375);
  expect(Math.round(box?.height || 0)).toBe(812);
});
