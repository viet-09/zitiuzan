// js/dashboard.js — dashboard list, progress, accessible completion controls,
// collapsible units, and return-position restoration.
import { getLessons, countProgress, isDone, toggleDone, getStreak, writeStreak } from './store.js';
import { renderFurigana } from './furigana.js';
import { navigate } from './router.js';
import { currentUser } from './supabase.js';
import { pushProgressToggle, pushTouchStreak, pushScore } from './sync.js';
import { LESSON_COMPLETE_SCORE } from './config.js';
import { announceLessonCompleted } from './pet.js';

const dashboardState = {
  activeCategory: 'all',
  expandedWeeks: new Set(),
  initialized: false,
  windowScrollY: 0,
  appScrollTop: 0,
  restorePending: false,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function weekKey(categoryId, weekNumber) {
  return `${categoryId}:${weekNumber}`;
}

function initializeExpandedWeeks(data) {
  if (dashboardState.initialized) return;
  (data.categories || []).forEach((category) => {
    (category.weeks || []).forEach((week) => {
      dashboardState.expandedWeeks.add(weekKey(category.id, week.week));
    });
  });
  dashboardState.initialized = true;
}

export function captureDashboardState() {
  const root = document.getElementById('app');
  dashboardState.windowScrollY = Math.max(0, window.scrollY || 0);
  dashboardState.appScrollTop = Math.max(0, root ? root.scrollTop : 0);
  dashboardState.restorePending = true;
}

function restoreDashboardPosition(root) {
  if (!dashboardState.restorePending) return false;
  dashboardState.restorePending = false;
  const windowY = dashboardState.windowScrollY;
  const appY = dashboardState.appScrollTop;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (root) root.scrollTop = appY;
      window.scrollTo({ top: windowY, left: 0, behavior: 'auto' });
    });
  });
  return true;
}

/** Render the dashboard and report whether the router should preserve scroll. */
export function renderDashboard(root) {
  const data = getLessons();
  if (!data || !Array.isArray(data.categories)) {
    root.innerHTML = '<p class="dash-empty-state" role="alert">Không tải được dữ liệu bài học.</p>';
    return { preserveScroll: false };
  }

  initializeExpandedWeeks(data);
  if (dashboardState.activeCategory !== 'all'
      && !data.categories.some((cat) => cat.id === dashboardState.activeCategory)) {
    dashboardState.activeCategory = 'all';
  }

  root.innerHTML = `
    <h2 class="sr-only" data-route-heading>Tổng quan học tập</h2>
    <section class="stats-bar" id="dash-stats" aria-label="Tiến độ học"></section>
    <div class="category-tabs" id="category-tabs" role="group" aria-label="Lọc theo kỹ năng"></div>
    <div id="dash-main"></div>
  `;

  renderStats();
  renderTabs(data);
  renderCategories(data);
  bindEvents(data);
  return {
    preserveScroll: restoreDashboardPosition(root),
  };
}

function renderStats() {
  const statsEl = document.getElementById('dash-stats');
  if (!statsEl) return;

  const progress = countProgress() || { total: 0, done: 0 };
  const total = Number(progress.total) || 0;
  const done = Number(progress.done) || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const streak = Number((getStreak() || {}).streak) || 0;

  statsEl.innerHTML = `
    <div class="stat-item">
      <div class="stat-value">${done} / ${total}</div>
      <div class="stat-label">Bài học xong</div>
      <progress class="dashboard-progress" max="100" value="${percent}" aria-label="${percent}% hoàn thành">${percent}%</progress>
    </div>
    <div class="stat-item">
      <div class="stat-value">${percent}%</div>
      <div class="stat-label">Hoàn thành</div>
    </div>
    <div class="stat-item stat-streak">
      <div class="stat-value">${streak} ngày</div>
      <div class="stat-label">Chuỗi học</div>
    </div>
  `;
  window.dispatchEvent(new CustomEvent('n2:stats-rendered', { detail: { streak } }));
}

function renderTabs(data) {
  const tabsEl = document.getElementById('category-tabs');
  if (!tabsEl) return;
  const makeTab = (id, label) => {
    const active = dashboardState.activeCategory === id;
    return `<button type="button" aria-pressed="${active}" class="tab-btn${active ? ' active' : ''}" data-cat="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
  };
  tabsEl.innerHTML = makeTab('all', 'Tất cả')
    + (data.categories || []).map((cat) => makeTab(cat.id, cat.name)).join('');
}

function renderCategories(data) {
  const mainEl = document.getElementById('dash-main');
  if (!mainEl) return;
  const categories = (data.categories || []).filter(
    (cat) => dashboardState.activeCategory === 'all' || cat.id === dashboardState.activeCategory
  );

  if (categories.length === 0) {
    mainEl.innerHTML = '<p class="dash-empty-state">Không có bài học nào.</p>';
    return;
  }
  mainEl.innerHTML = categories.map(renderCategoryBlock).join('');
}

function renderCategoryBlock(category) {
  const weeks = Array.isArray(category.weeks) ? category.weeks : [];
  let total = 0;
  let done = 0;
  weeks.forEach((week) => (week.lessons || []).forEach((lesson) => {
    total += 1;
    if (isDone(lesson.id)) done += 1;
  }));

  const nameEn = category.nameEn ? ` (${escapeHtml(category.nameEn)})` : '';
  return `
    <section class="category-block" data-cat-id="${escapeHtml(category.id)}" aria-labelledby="category-${escapeHtml(category.id)}">
      <div class="category-header">
        <h3 id="category-${escapeHtml(category.id)}">${escapeHtml(category.name)}${nameEn}</h3>
        <span class="category-progress-text" aria-live="polite">${done}/${total} xong</span>
      </div>
      <div class="weeks-container">
        ${weeks.map((week) => renderWeekCard(category, week)).join('')}
      </div>
    </section>`;
}

function renderWeekCard(category, week) {
  const lessons = Array.isArray(week.lessons) ? week.lessons : [];
  const done = lessons.filter((lesson) => isDone(lesson.id)).length;
  const key = weekKey(category.id, week.week);
  const expanded = dashboardState.expandedWeeks.has(key);
  const panelId = `week-${category.id}-${week.week}`;
  const unitLabel = category.unitType === 'chapter' || category.id === 'listening' ? 'Chương' : 'Tuần';
  const title = week.title ? ` · ${renderFurigana(week.title)}` : '';

  return `
    <section class="week-card" data-week-key="${escapeHtml(key)}">
      <h4 class="week-title">
        <button class="week-toggle" type="button" aria-expanded="${expanded}" aria-controls="${panelId}">
          <span>${unitLabel} ${escapeHtml(week.week)}${title}</span>
          <span class="week-count">${done}/${lessons.length}</span>
        </button>
      </h4>
      <div class="lessons-grid" id="${panelId}"${expanded ? '' : ' hidden'}>
        ${lessons.map(renderLessonItem).join('')}
      </div>
    </section>`;
}

function renderLessonItem(lesson) {
  const done = isDone(lesson.id);
  const typeLabel = lesson.type === 'practice' ? 'Thực chiến' : 'Bài học';
  const title = String(lesson.title || '');
  return `
    <article class="lesson-item${done ? ' completed' : ''}" data-id="${escapeHtml(lesson.id)}">
      <button type="button" class="custom-checkbox complete-btn" aria-pressed="${done}" aria-label="${done ? 'Đánh dấu chưa hoàn thành' : 'Đánh dấu hoàn thành'}: ${escapeHtml(title.replace(/\{([^|{}]+)\|[^{}]+\}/g, '$1'))}"></button>
      <div class="lesson-content">
        <div class="lesson-meta">Ngày ${escapeHtml(lesson.day)} • ${typeLabel}</div>
        <div class="lesson-title" lang="ja">${renderFurigana(title)}</div>
        ${lesson.titleEn ? `<div class="lesson-title-en" lang="en">${escapeHtml(lesson.titleEn)}</div>` : ''}
      </div>
      <button type="button" class="study-btn" aria-label="Học ${escapeHtml(title.replace(/\{([^|{}]+)\|[^{}]+\}/g, '$1'))}">Học</button>
    </article>`;
}

function updateAncestorCounts(item) {
  const weekCard = item.closest('.week-card');
  if (weekCard) {
    const count = weekCard.querySelectorAll('.lesson-item.completed').length;
    const total = weekCard.querySelectorAll('.lesson-item').length;
    const output = weekCard.querySelector('.week-count');
    if (output) output.textContent = `${count}/${total}`;
  }
  const category = item.closest('.category-block');
  if (category) {
    const count = category.querySelectorAll('.lesson-item.completed').length;
    const total = category.querySelectorAll('.lesson-item').length;
    const output = category.querySelector('.category-progress-text');
    if (output) output.textContent = `${count}/${total} xong`;
  }
}

function bindEvents(data) {
  const tabsEl = document.getElementById('category-tabs');
  const mainEl = document.getElementById('dash-main');

  tabsEl?.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-btn');
    if (!button) return;
    const category = button.dataset.cat;
    if (!category || category === dashboardState.activeCategory) return;
    dashboardState.activeCategory = category;
    tabsEl.querySelectorAll('.tab-btn').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
    renderCategories(data);
  });

  mainEl?.addEventListener('click', (event) => {
    const weekButton = event.target.closest('.week-toggle');
    if (weekButton) {
      const card = weekButton.closest('.week-card');
      const panel = card?.querySelector('.lessons-grid');
      const key = card?.dataset.weekKey;
      if (!panel || !key) return;
      const expanded = weekButton.getAttribute('aria-expanded') !== 'true';
      weekButton.setAttribute('aria-expanded', String(expanded));
      panel.hidden = !expanded;
      if (expanded) dashboardState.expandedWeeks.add(key);
      else dashboardState.expandedWeeks.delete(key);
      return;
    }

    const item = event.target.closest('.lesson-item');
    if (!item) return;
    const id = item.dataset.id;
    if (!id) return;

    if (event.target.closest('.study-btn')) {
      captureDashboardState();
      navigate(`#/lesson/${encodeURIComponent(id)}`);
      return;
    }

    const completionButton = event.target.closest('.complete-btn');
    if (!completionButton) return;
    const done = toggleDone(id);
    item.classList.toggle('completed', done);
    completionButton.setAttribute('aria-pressed', String(done));
    const lessonTitle = item.querySelector('.lesson-title')?.textContent?.trim() || id;
    completionButton.setAttribute('aria-label', `${done ? 'Đánh dấu chưa hoàn thành' : 'Đánh dấu hoàn thành'}: ${lessonTitle}`);
    updateAncestorCounts(item);
    renderStats();
    const categoryId = item.closest('.category-block')?.getAttribute('data-cat-id') || '';
    syncLessonCompletion(id, categoryId, done);
    if (done) {
      announceLessonCompleted({ id, done, streak: Number((getStreak() || {}).streak) || 0 });
    }
  });
}

// ---------------------------------------------------------------------------
// Cloud sync — push progress/score/streak when signed in. No-op offline.
// ---------------------------------------------------------------------------

/**
 * Push a single lesson toggle to Supabase, award/revoke score, and reconcile
 * the streak against the server's Asia/Tokyo-anchored `touch_user_streak`
 * RPC (the local `touchStreak()` in store.js already ran synchronously so
 * offline use is unaffected — this just keeps the shared leaderboard live).
 */
async function syncLessonCompletion(lessonId, categoryId, done) {
  const user = await currentUser();
  if (!user) return;

  pushProgressToggle(user.id, lessonId, categoryId, done).catch(() => {});
  pushScore(user.id, done ? LESSON_COMPLETE_SCORE : -LESSON_COMPLETE_SCORE).catch(() => {});

  if (!done) return;
  const result = await pushTouchStreak(user.id);
  if (result) {
    writeStreak(result);
    renderStats();
  }
}
