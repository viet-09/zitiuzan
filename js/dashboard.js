// js/dashboard.js — dashboard list, progress, accessible completion controls,
// collapsible units, and return-position restoration.
import {
  getLessons,
  countProgress,
  isDone,
  getStreak,
  getProgressMap,
  getBookContent,
  findLesson,
} from './store.js';
import { renderFurigana } from './furigana.js';
import { navigate } from './router.js';
import { announceLessonCompleted } from './pet.js';
import { toggleLessonCompletion } from './completion.js';
import {
  buildDailyPlan,
  buildSearchIndex,
  calculateReadiness,
  searchCurriculum,
} from './learning-engine.js';
import { learningState } from './learning-state.js';
import { initialExpandedWeeks } from './dashboard-state.js';

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
  dashboardState.expandedWeeks = initialExpandedWeeks(data, isDone);
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
    <section class="learning-hub" id="learning-hub" aria-labelledby="learning-hub-title"></section>
    <div class="category-tabs" id="category-tabs" role="group" aria-label="Lọc theo kỹ năng"></div>
    <div id="dash-main"></div>
  `;

  renderStats();
  renderLearningHub(data);
  renderTabs(data);
  renderCategories(data);
  bindEvents(data);
  return {
    preserveScroll: restoreDashboardPosition(root),
  };
}

const CATEGORY_SHORT = Object.freeze({
  kanji: 'Hán tự', vocabulary: 'Từ vựng', grammar: 'Ngữ pháp', reading: 'Đọc', listening: 'Nghe',
});

function lessonButton(item, label = 'Học ngay') {
  const found = findLesson(item.lessonId);
  const title = item.title || found?.lesson?.title || item.lessonId;
  return `
    <article class="plan-item">
      <div>
        <span class="plan-item-type">${item.type === 'review' ? 'Ôn lỗi sai' : escapeHtml(CATEGORY_SHORT[item.categoryId] || item.categoryId)}</span>
        <div class="plan-item-title" lang="ja">${renderFurigana(title)}</div>
      </div>
      <button type="button" class="study-btn" data-learning-open="${escapeHtml(item.lessonId)}">${label}</button>
    </article>`;
}

function renderLearningHub(data) {
  const hub = document.getElementById('learning-hub');
  if (!hub) return;
  const reviews = learningState.getReviews();
  const dueReviews = learningState.getDueReviews();
  const progress = getProgressMap();
  const plan = buildDailyPlan({ lessons: data, progress, reviews, maxItems: 5 });
  const readiness = calculateReadiness({ lessons: data, progress, reviews, examHistory: [] });
  const bookmarks = learningState.getBookmarks().map((lessonId) => {
    const found = findLesson(lessonId);
    return found ? { type: 'bookmark', lessonId, categoryId: found.category.id, title: found.lesson.title } : null;
  }).filter(Boolean);
  const categoryMeters = Object.entries(readiness.byCategory).map(([categoryId, value]) => `
    <div class="readiness-row">
      <span>${escapeHtml(CATEGORY_SHORT[categoryId] || categoryId)}</span>
      <progress max="100" value="${value}" aria-label="${escapeHtml(CATEGORY_SHORT[categoryId] || categoryId)}: ${value}%">${value}%</progress>
      <strong>${value}%</strong>
    </div>`).join('');

  hub.innerHTML = `
    <header class="learning-hub-head">
      <div><p class="eyebrow">Lộ trình thích ứng</p><h2 id="learning-hub-title">Hôm nay học gì?</h2></div>
      <div class="readiness-score" aria-label="Mức sẵn sàng thi ${readiness.overall}%"><strong>${readiness.overall}%</strong><span>Sẵn sàng thi</span></div>
    </header>
    <div class="learning-hub-grid">
      <div class="daily-plan" aria-label="Kế hoạch học hôm nay">
        ${plan.length ? plan.map((item) => lessonButton(item)).join('') : '<p class="dash-empty-state">Bạn đã hoàn thành kế hoạch hôm nay 🎉</p>'}
      </div>
      <aside class="readiness-card" aria-label="Mức sẵn sàng theo kỹ năng">${categoryMeters}</aside>
    </div>
    <div class="learning-tools">
      <label class="curriculum-search"><span class="sr-only">Tìm trong toàn bộ nội dung N2</span><input type="search" data-learning-search placeholder="Tìm kanji, từ vựng, ngữ pháp…" autocomplete="off"><span aria-hidden="true">⌕</span></label>
      <span class="learning-tool-count">${dueReviews.length} mục đến hạn ôn · ${bookmarks.length} bài đã lưu</span>
    </div>
    <div class="learning-search-results" data-learning-results aria-live="polite"></div>
    ${bookmarks.length ? `<details class="saved-lessons"><summary>Bài đã lưu (${bookmarks.length})</summary><div>${bookmarks.slice(0, 8).map((item) => lessonButton(item, 'Mở')).join('')}</div></details>` : ''}
  `;
  bindLearningHub(data, hub);
}

function bindLearningHub(data, hub) {
  const searchIndex = buildSearchIndex(data, getBookContent);
  const results = hub.querySelector('[data-learning-results]');
  hub.addEventListener('click', (event) => {
    const open = event.target.closest('[data-learning-open]');
    if (!open?.dataset.learningOpen) return;
    captureDashboardState();
    navigate(`#/lesson/${encodeURIComponent(open.dataset.learningOpen)}`);
  });
  hub.querySelector('[data-learning-search]')?.addEventListener('input', (event) => {
    const query = event.target.value.trim();
    if (!query) {
      results.innerHTML = '';
      return;
    }
    const matches = searchCurriculum(searchIndex, query, 12);
    results.innerHTML = matches.length
      ? `<p class="search-result-count">${matches.length} kết quả gần nhất</p><div class="search-result-grid">${matches.map((item) => lessonButton({ ...item, type: 'search' }, 'Mở')).join('')}</div>`
      : '<p class="dash-empty-state">Không tìm thấy nội dung phù hợp.</p>';
  });
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
        ${expanded ? lessons.map(renderLessonItem).join('') : ''}
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
      <button type="button" class="bookmark-btn${learningState.isBookmarked(lesson.id) ? ' is-saved' : ''}" data-action="bookmark" aria-pressed="${learningState.isBookmarked(lesson.id)}" aria-label="${learningState.isBookmarked(lesson.id) ? 'Bỏ lưu' : 'Lưu'} bài ${escapeHtml(title.replace(/\{([^|{}]+)\|[^{}]+\}/g, '$1'))}">${learningState.isBookmarked(lesson.id) ? '★' : '☆'}</button>
      <button type="button" class="study-btn" aria-label="Học ${escapeHtml(title.replace(/\{([^|{}]+)\|[^{}]+\}/g, '$1'))}">Học</button>
    </article>`;
}

function updateAncestorCounts(item, data) {
  const weekCard = item.closest('.week-card');
  if (weekCard) {
    const [categoryId, weekNumber] = (weekCard.dataset.weekKey || '').split(':');
    const lessons = data.categories?.find((category) => category.id === categoryId)?.weeks
      ?.find((week) => String(week.week) === weekNumber)?.lessons || [];
    const count = lessons.filter((lesson) => isDone(lesson.id)).length;
    const total = lessons.length;
    const output = weekCard.querySelector('.week-count');
    if (output) output.textContent = `${count}/${total}`;
  }
  const category = item.closest('.category-block');
  if (category) {
    const categoryData = data.categories?.find((entry) => entry.id === category.dataset.catId);
    const lessons = (categoryData?.weeks || []).flatMap((week) => week.lessons || []);
    const count = lessons.filter((lesson) => isDone(lesson.id)).length;
    const total = lessons.length;
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
      if (expanded) {
        dashboardState.expandedWeeks.add(key);
        if (!panel.childElementCount) {
          const [categoryId, weekNumber] = key.split(':');
          const lessons = data.categories
            ?.find((category) => category.id === categoryId)?.weeks
            ?.find((week) => String(week.week) === weekNumber)?.lessons || [];
          panel.innerHTML = lessons.map(renderLessonItem).join('');
        }
      } else {
        dashboardState.expandedWeeks.delete(key);
        panel.innerHTML = '';
      }
      return;
    }

    const item = event.target.closest('.lesson-item');
    if (!item) return;
    const id = item.dataset.id;
    if (!id) return;

    const bookmarkButton = event.target.closest('[data-action="bookmark"]');
    if (bookmarkButton) {
      const saved = learningState.toggleBookmark(id);
      bookmarkButton.classList.toggle('is-saved', saved);
      bookmarkButton.setAttribute('aria-pressed', String(saved));
      bookmarkButton.setAttribute('aria-label', `${saved ? 'Bỏ lưu' : 'Lưu'} bài ${item.querySelector('.lesson-title')?.textContent?.trim() || id}`);
      bookmarkButton.textContent = saved ? '★' : '☆';
      renderLearningHub(data);
      return;
    }

    if (event.target.closest('.study-btn')) {
      captureDashboardState();
      navigate(`#/lesson/${encodeURIComponent(id)}`);
      return;
    }

    const completionButton = event.target.closest('.complete-btn');
    if (!completionButton) return;
    const syncPromise = toggleLessonCompletion({
      lessonId: id,
      categoryId: item.closest('.category-block')?.getAttribute('data-cat-id') || '',
    });
    const done = isDone(id);
    item.classList.toggle('completed', done);
    completionButton.setAttribute('aria-pressed', String(done));
    const lessonTitle = item.querySelector('.lesson-title')?.textContent?.trim() || id;
    completionButton.setAttribute('aria-label', `${done ? 'Đánh dấu chưa hoàn thành' : 'Đánh dấu hoàn thành'}: ${lessonTitle}`);
    updateAncestorCounts(item, data);
    renderStats();
    void syncPromise.finally(renderStats);
    if (done) {
      announceLessonCompleted({ id, done, streak: Number((getStreak() || {}).streak) || 0 });
    }
  });
}

