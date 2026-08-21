// Publishes the height actually left for #app between the masthead and the
// fixed bottom nav as `--app-viewport-height`.
//
// Chat pages (gia sư AI, luyện nói) need to fill that space exactly: a chat
// column sized in `vh` overflows past the fold, which turns one conversation
// into two nested scrollbars — the page and the message list. Measuring the
// real offset instead keeps the whole conversation inside one viewport on any
// masthead height, any phone chrome and any route.

import { ROUTE_CHANGED_EVENT } from './router.js';

const MIN_HEIGHT = 280;

function readBottomNavHeight(root) {
  const raw = getComputedStyle(root).getPropertyValue('--bottom-nav-height');
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 76;
}

/**
 * Keep `--app-viewport-height` in sync with the live layout.
 * @param {HTMLElement} app the routed content host (`#app`)
 * @returns {{ measure: () => void, destroy: () => void }}
 */
export function mountAppViewportFit(app) {
  const root = document.documentElement;
  const measure = () => {
    if (!app?.isConnected) return;
    // getBoundingClientRect is viewport-relative, so add the scroll offset to
    // get the distance from the top of the document to #app.
    const top = app.getBoundingClientRect().top + window.scrollY;
    const available = window.innerHeight - top - readBottomNavHeight(root);
    root.style.setProperty('--app-viewport-height', `${Math.max(MIN_HEIGHT, Math.round(available))}px`);
  };

  // The masthead reflows with the viewport (its title is clamp()-sized) and
  // with font loading, so remeasure on both rather than only at boot.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  const masthead = document.querySelector('.masthead');
  if (masthead) observer?.observe(masthead);
  // A route swap restyles the masthead through CSS. getBoundingClientRect
  // flushes pending layout, so measuring straight away already sees the new
  // masthead — and unlike requestAnimationFrame it also runs in a background
  // tab, where the first render often happens.
  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', measure);
  window.addEventListener(ROUTE_CHANGED_EVENT, measure);
  measure();

  return {
    measure,
    destroy() {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener(ROUTE_CHANGED_EVENT, measure);
    },
  };
}
