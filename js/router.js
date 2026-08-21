// js/router.js
// Minimal hash router.
//   ``, `#`, `#/`      -> routes.dashboard(rootEl)
//   `#/lesson/<id>`    -> routes.lesson(rootEl, id)
//   `#/tutor`          -> routes.tutor(rootEl)
//   `#/voice`          -> routes.voice(rootEl)
//   `#/leaderboard`    -> routes.leaderboard(rootEl)
//   `#/exam`           -> routes.exam(rootEl)
//   `#/review`         -> routes.review(rootEl)
// Renderers may return `{ cleanup, preserveScroll }`. Cleanup runs before the next
// route so microphone/audio and event resources cannot outlive their page.

let _routes = null;
let _rootEl = null;
let _cleanup = null;
let _currentRoute = { name: 'dashboard', params: [] };
let _renderEpoch = 0;

/** Fired on <window> after every route render, once the new route is active. */
export const ROUTE_CHANGED_EVENT = 'n2:route-changed';

function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean); // '' | '/' -> []

  if (parts.length === 0) return { name: 'dashboard', params: [] };
  if (parts[0] === 'lesson' && parts[1]) {
    let id = parts[1];
    try { id = decodeURIComponent(id); } catch (err) { /* keep encoded id */ }
    return { name: 'lesson', params: [id] };
  }
  if (parts[0] === 'tutor') return { name: 'tutor', params: [] };
  if (parts[0] === 'voice') return { name: 'voice', params: [] };
  if (parts[0] === 'leaderboard') return { name: 'leaderboard', params: [] };
  if (parts[0] === 'exam') return { name: 'exam', params: [] };
  if (parts[0] === 'profile') return { name: 'profile', params: [] };
  if (parts[0] === 'review') return { name: 'review', params: [] };
  return { name: 'dashboard', params: [] };
}

function updateActiveNav(routeName) {
  try {
    const activeRoute = routeName === 'lesson' || routeName === 'review' ? 'dashboard' : routeName;
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      const route = btn.getAttribute('data-route');
      const active = route === activeRoute;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  } catch (err) {
    // No DOM / no nav present — ignore.
  }
}

function scrollAppToTop() {
  try {
    const app = _rootEl || document.getElementById('app');
    if (app) {
      if (typeof app.scrollTo === 'function') app.scrollTo(0, 0);
      app.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  } catch (err) {
    // ignore
  }
}

function updateRouteMetadata(routeName) {
  // Chat-heavy routes restyle the masthead from CSS; keep the active route on
  // the root element so no page has to reach up and mutate the shell itself,
  // and announce the swap so shell-level layout can remeasure.
  try {
    document.documentElement.dataset.route = routeName;
    window.dispatchEvent(new CustomEvent(ROUTE_CHANGED_EVENT, { detail: { route: routeName } }));
  } catch (err) { /* no DOM */ }

  const labels = {
    dashboard: 'Tổng quan',
    lesson: 'Bài học',
    tutor: 'Gia sư AI',
    voice: 'Luyện nói',
    leaderboard: 'Bảng xếp hạng',
    exam: 'Thi thử',
    profile: 'Hồ sơ cá nhân',
    review: 'Mini-test điểm yếu',
  };
  const label = labels[routeName] || labels.dashboard;
  document.title = `${label} – 日本語総まとめ N2`;
  const status = document.getElementById('route-status');
  if (status) status.textContent = `Đã mở ${label}`;
}

function runCleanup() {
  if (typeof _cleanup !== 'function') return;
  try { _cleanup(); } catch (err) { console.warn('[router] route cleanup failed:', err); }
  _cleanup = null;
}

function render() {
  if (!_routes || !_rootEl) return;
  const { name, params } = parseHash(location.hash);
  runCleanup();
  _currentRoute = { name, params: [...params] };
  _renderEpoch += 1;
  let result = null;

  _rootEl.setAttribute('aria-busy', 'true');

  try {
    if (name === 'lesson' && typeof _routes.lesson === 'function') {
      result = _routes.lesson(_rootEl, params[0]);
    } else if (name === 'tutor' && typeof _routes.tutor === 'function') {
      result = _routes.tutor(_rootEl);
    } else if (name === 'voice' && typeof _routes.voice === 'function') {
      result = _routes.voice(_rootEl);
    } else if (name === 'leaderboard' && typeof _routes.leaderboard === 'function') {
      result = _routes.leaderboard(_rootEl);
    } else if (name === 'exam' && typeof _routes.exam === 'function') {
      result = _routes.exam(_rootEl);
    } else if (name === 'profile' && typeof _routes.profile === 'function') {
      result = _routes.profile(_rootEl);
    } else if (name === 'review' && typeof _routes.review === 'function') {
      result = _routes.review(_rootEl);
    } else if (typeof _routes.dashboard === 'function') {
      result = _routes.dashboard(_rootEl);
    }
  } catch (err) {
    console.error('[router] failed to render route:', name, err);
  }

  if (typeof result === 'function') _cleanup = result;
  else if (result && typeof result.cleanup === 'function') _cleanup = result.cleanup;

  updateActiveNav(name);
  updateRouteMetadata(name);
  _rootEl.setAttribute('aria-busy', 'false');

  if (!(result && result.preserveScroll)) {
    scrollAppToTop();
    requestAnimationFrame(() => {
      const target = _rootEl.querySelector('h1, h2, [data-route-heading]') || _rootEl;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
  }
}

/**
 * @param {{dashboard:Function, lesson:Function, tutor:Function, voice:Function, leaderboard:Function}} routes
 * @param {HTMLElement} rootEl
 */
export function initRouter(routes, rootEl) {
  window.removeEventListener('hashchange', render);
  runCleanup();
  _routes = routes || {};
  _rootEl = rootEl || document.getElementById('app');
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.addEventListener('hashchange', render);
  render();
}

export function getCurrentRoute() {
  return { name: _currentRoute.name, params: [..._currentRoute.params], epoch: _renderEpoch };
}

export function isRouteActive(name, param = null, epoch = null) {
  if (_currentRoute.name !== name) return false;
  if (param != null && _currentRoute.params[0] !== param) return false;
  return epoch == null || epoch === _renderEpoch;
}

/**
 * Navigate to a hash route, e.g. navigate('#/lesson/g1d1').
 * @param {string} hash
 */
export function navigate(hash) {
  try {
    const target = String(hash || '#/');
    const normalized = target.startsWith('#') ? target : `#${target}`;
    if (location.hash === normalized) {
      render();
    } else {
      location.hash = normalized;
    }
  } catch (err) {
    // ignore
  }
}
