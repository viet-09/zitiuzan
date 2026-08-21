import { test, expect } from '@playwright/test';
import axeCore from 'axe-core';
import fs from 'node:fs';

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

test('kanji cards open a pen-friendly handwriting pad', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/#/lesson/k1d2');
  await dismissAuthGateForComponentChecks(page);

  const openPad = page.getByRole('button', { name: /^Luyện viết chữ / }).first();
  await expect(openPad).toBeVisible();
  await openPad.click();

  const dialog = page.getByRole('dialog', { name: /Luyện viết/ });
  const canvas = dialog.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Xóa nét vừa viết' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Làm sạch bảng viết' })).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 50, box.y + box.height - 50, { steps: 10 });
  await page.mouse.up();
  const painted = await canvas.evaluate((node) => (
    [...node.getContext('2d').getImageData(0, 0, node.width, node.height).data]
      .some((channel, index) => index % 4 === 3 && channel > 0)
  ));
  expect(painted).toBe(true);

  await dialog.getByRole('button', { name: 'Làm sạch bảng viết' }).click();
  const cleared = await canvas.evaluate((node) => (
    [...node.getContext('2d').getImageData(0, 0, node.width, node.height).data]
      .every((channel, index) => index % 4 !== 3 || channel === 0)
  ));
  expect(cleared).toBe(true);
  await dialog.getByRole('button', { name: 'Đóng bảng luyện viết' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(openPad).toBeFocused();
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

test('pixel desktop companion roams, reacts, drags and keeps its learning quest', async ({ page }) => {
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
  const petArt = page.locator('#pet-widget-mount .pixel-pet--fox');
  const petWidget = page.locator('#pet-widget-mount .pet-widget');
  const petCompanion = page.locator('#pet-widget-mount [data-pet-companion]');
  await expect(petArt).toHaveCount(1);
  const rasterSprite = petArt.locator('.pixel-pet__sprite');
  await expect(rasterSprite).toBeVisible();
  await expect(rasterSprite).toHaveCSS('background-image', /fox-motion-atlas\.png/);
  await expect(petArt.locator('.pixel-pet__svg')).toHaveCount(0);
  const petShadow = await petArt.locator('xpath=..').evaluate((node) => getComputedStyle(node, '::after').display);
  expect(petShadow).toBe('none');
  await expect(petCompanion).toHaveAttribute('data-renderer', 'pixel-sprite');
  await expect(petCompanion).toHaveAttribute('data-companion-ready', 'true');
  await expect(petCompanion).toHaveAttribute('data-pet-state', 'idle');
  // Sample across a whole idle loop: the pose changes, and the rig keeps the
  // sprite breathing between pose changes.
  const idleFramePositions = new Set();
  const idleRigOffsets = new Set();
  for (let sample = 0; sample < 9; sample += 1) {
    idleFramePositions.add(await rasterSprite.evaluate((node) => getComputedStyle(node).backgroundPosition));
    idleRigOffsets.add(await petCompanion.evaluate((node) => node.style.getPropertyValue('--pet-stretch')));
    await page.waitForTimeout(900);
  }
  expect(idleFramePositions.size).toBeGreaterThan(1);
  expect(idleRigOffsets.size).toBeGreaterThan(1);
  await expect(page.locator('#pet-widget-mount')).toHaveCSS('pointer-events', 'none');

  // 0.75 of the drawn 74.4x110.4 mount — see --pet-scale in css/styles.css.
  const compactPetSize = await petCompanion.boundingBox();
  expect(compactPetSize).not.toBeNull();
  expect(compactPetSize.width).toBeCloseTo(55.8, 0);
  expect(compactPetSize.height).toBeCloseTo(82.8, 0);

  const questMarkSize = await page.locator('.pet-widget__quest-toggle span').boundingBox();
  expect(questMarkSize).not.toBeNull();
  expect(questMarkSize.width).toBeLessThanOrEqual(10);
  expect(questMarkSize.height).toBeLessThanOrEqual(10);

  const directInteraction = page.getByRole('button', { name: 'Tương tác trực tiếp với Cáo' });
  const directInteractionSize = await directInteraction.boundingBox();
  expect(directInteractionSize).not.toBeNull();
  const interactionChrome = await directInteraction.evaluate((node) => ({
    label: getComputedStyle(node, '::before').display,
    marker: getComputedStyle(node, '::after').display,
    background: getComputedStyle(node).backgroundColor,
  }));
  expect(interactionChrome).toEqual({
    label: 'none',
    marker: 'none',
    background: 'rgba(0, 0, 0, 0)',
  });

  await directInteraction.click({ position: {
    x: directInteractionSize.width * 0.5,
    y: directInteractionSize.height * 0.2,
  } });
  await expect(petWidget).toHaveAttribute('data-reaction', 'pat');
  await expect(petCompanion).toHaveAttribute('data-pet-state', 'look');
  await expect(page.locator('.pet-widget__bubble')).toContainText(/nựng|thích/i);

  await directInteraction.click({ position: {
    x: directInteractionSize.width * 0.9,
    y: directInteractionSize.height * 0.7,
  } });
  await expect(petWidget).toHaveAttribute('data-reaction', 'tease');
  await expect(petCompanion).toHaveAttribute('data-pet-state', 'play');

  await directInteraction.click({ position: {
    x: directInteractionSize.width * 0.1,
    y: directInteractionSize.height * 0.7,
  } });
  await expect(petWidget).toHaveAttribute('data-reaction', 'highfive');
  await expect(petCompanion).toHaveAttribute('data-pet-state', 'cheer');

  const transformBeforeDrag = await page.locator('#pet-widget-mount .streak-pet-mount').evaluate((node) => getComputedStyle(node).transform);
  const dragTarget = directInteraction;
  const dragBox = await dragTarget.boundingBox();
  expect(dragBox).not.toBeNull();
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + 96, dragBox.y - 42, { steps: 6 });
  await page.mouse.up();
  const transformAfterDrag = await page.locator('#pet-widget-mount .streak-pet-mount').evaluate((node) => getComputedStyle(node).transform);
  expect(transformAfterDrag).not.toBe(transformBeforeDrag);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('n2:lesson-complete', {
    detail: { id: 'motion-check', done: true, streak: 0 },
  })));
  await expect(petWidget).toHaveAttribute('data-reaction', 'complete');
  await expect(petCompanion).toHaveAttribute('data-pet-state', 'cheer');

  await page.getByRole('button', { name: 'Mở nhiệm vụ học của Cáo' }).click();
  const panel = page.getByRole('region', { name: 'Nhiệm vụ của bạn đồng hành' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ôn 3 phút' })).toBeVisible();
  await expect(panel).toContainText('lỗi ngữ pháp');
  await expect(petWidget).toHaveAttribute('data-reaction', '', { timeout: 3_000 });
  const sizeBeforeScroll = await petCompanion.boundingBox();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect(page.locator('#pet-widget-mount')).not.toHaveClass(/is-compact/);
  const sizeAfterScroll = await petCompanion.boundingBox();
  expect(sizeBeforeScroll).not.toBeNull();
  expect(sizeAfterScroll).not.toBeNull();
  expect(Math.abs(sizeAfterScroll.width - sizeBeforeScroll.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(sizeAfterScroll.height - sizeBeforeScroll.height)).toBeLessThanOrEqual(0.5);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(petCompanion).toHaveAttribute('data-motion', 'reduced');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#/profile');
  await dismissAuthGateForComponentChecks(page);
  await page.getByRole('combobox', { name: 'Loài' }).selectOption('rabbit');
  const rabbitCompanion = page.locator('#pet-widget-mount [data-pet-companion][data-pet-type="rabbit"]');
  await expect(rabbitCompanion).toHaveAttribute('data-renderer', 'pixel-sprite');
  await expect(rabbitCompanion.locator('.pixel-pet--rabbit')).toBeVisible();
  await expect(page.locator('#btn-account .profile-avatar--rabbit')).toBeVisible();
  await page.getByRole('combobox', { name: 'Loài' }).selectOption('fox');
});

test('the tutor conversation fills one viewport instead of scrolling the page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/#/tutor');
  await dismissAuthGateForComponentChecks(page);

  // The display masthead steps aside on chat routes so the transcript, its
  // toolbar and the input row all fit above the fold together.
  await expect(page.locator('.masthead-title')).toBeHidden();
  const geometry = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    wrapBottom: document.querySelector('.chat-wrap').getBoundingClientRect().bottom,
    messages: document.querySelector('.chat-messages').getBoundingClientRect().height,
    navTop: document.querySelector('.bottom-nav').getBoundingClientRect().top,
  }));
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.wrapBottom).toBeLessThanOrEqual(geometry.navTop + 1);
  expect(geometry.messages).toBeGreaterThan(400);

  await expect(page.getByRole('textbox', { name: /câu trả lời/i })).toBeInViewport();
});

test('the voice route keeps its own settings entry point once the masthead collapses', async ({ page }) => {
  await page.goto('/#/voice');
  await dismissAuthGateForComponentChecks(page);

  await expect(page.locator('.masthead-tools')).toBeHidden();
  const settings = page.locator('.voice-page').getByRole('button', { name: /Cài đặt/ });
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(page.getByRole('dialog', { name: /Cài đặt AI/ })).toBeVisible();
});

test('profile offers two matching pet avatars and compresses oversized uploads', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('n2_profile_prompt_seen_v2', '1'));
  await page.goto('/#/profile');
  await dismissAuthGateForComponentChecks(page);
  await page.getByRole('button', { name: 'Chỉnh tên / ảnh đại diện' }).click();

  const dialog = page.getByRole('dialog', { name: 'Chỉnh hồ sơ' });
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('radio', { name: /Cáo/ })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Thỏ/ })).toBeVisible();
  await expect(dialog.getByText(/tự nén/u)).toBeVisible();
  await expect(dialog.getByText(/1,5 MB|4096 px/u)).toHaveCount(0);

  const source = fs.readFileSync(new URL('../../assets/pets/fox-motion-sprites.png', import.meta.url));
  const oversized = Buffer.concat([source, Buffer.alloc(2_000_000)]);
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'avatar-rat-lon.png',
    mimeType: 'image/png',
    buffer: oversized,
  });
  await expect(dialog.locator('[data-profile-status]')).toContainText(/Đã nén/u);
  const previewSource = await dialog.locator('.profile-avatar--upload img').getAttribute('src');
  expect(previewSource).toMatch(/^data:image\/(?:webp|jpeg);base64,/u);
  expect(previewSource.length).toBeLessThan(500_000);
});

test('vocabulary ruby, Japanese font and long text stay intact on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/#/lesson/v1d3');
  await dismissAuthGateForComponentChecks(page);

  await expect(page.getByText('「おじゃまします。」', { exact: true })).toBeVisible();
  await expect(page.locator('.vocab-section')).not.toContainText('<ruby>');
  await expect(page.locator('.vocab-meaning:empty')).toHaveCount(0);
  const invitation = page.locator('.vocab-item').filter({ has: page.locator('[data-word*="招待する"]') });
  await expect(invitation.locator('ruby')).toHaveCount(4);
  const japaneseFont = await invitation.locator('.vocab-word').evaluate((node) => getComputedStyle(node).fontFamily);
  expect(japaneseFont).toContain('Zen Kaku Gothic New');

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    broken: [...document.querySelectorAll('.content-section, .vocab-item, .explain-word-btn')]
      .filter((node) => node.scrollWidth - node.clientWidth > 1).length,
  }));
  expect(overflow).toEqual({ document: 0, broken: 0 });
});

test('mobile dashboard has no horizontal overflow and passes serious axe checks', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await dismissAuthGateForComponentChecks(page);
  await expect(page.locator('#learning-hub')).toBeVisible();
  const mobilePet = page.locator('#pet-widget-mount [data-pet-companion]');
  await expect(mobilePet).toHaveAttribute('data-renderer', 'pixel-sprite');
  const mobilePetSize = await mobilePet.boundingBox();
  expect(mobilePetSize).not.toBeNull();
  expect(mobilePetSize.width).toBeCloseTo(48.6, 0);
  expect(mobilePetSize.height).toBeCloseTo(72, 0);
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
