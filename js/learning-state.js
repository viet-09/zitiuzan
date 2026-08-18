import { getDueReviews, recordReviewResult } from './learning-engine.js';

export const REVIEW_STORAGE_KEY = 'n2_reviews_v1';
export const BOOKMARK_STORAGE_KEY = 'n2_bookmarks_v1';

function readJSON(storage, key, fallback) {
  try {
    const parsed = JSON.parse(storage?.getItem(key) || 'null');
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJSON(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* storage is best effort */ }
}

export function createLearningState(storage = globalThis.localStorage) {
  const getReviews = () => {
    const value = readJSON(storage, REVIEW_STORAGE_KEY, []);
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  };
  const getBookmarks = () => {
    const value = readJSON(storage, BOOKMARK_STORAGE_KEY, []);
    return Array.isArray(value)
      ? [...new Set(value.filter((id) => typeof id === 'string' && id))]
      : [];
  };

  return {
    getReviews,
    getDueReviews(now = new Date()) {
      return getDueReviews(getReviews().filter((item) => (
        (Number(item?.lapses) || 0) > 0 || item?.lastResult === 'wrong'
      )), now);
    },
    recordReview(input) {
      const reviews = getReviews();
      const index = reviews.findIndex((item) => item.key === String(input?.key || ''));
      const next = recordReviewResult(index >= 0 ? reviews[index] : null, input || {});
      if (index >= 0) reviews[index] = next;
      else reviews.push(next);
      writeJSON(storage, REVIEW_STORAGE_KEY, reviews.slice(-1000));
      return next;
    },
    getBookmarks,
    isBookmarked(lessonId) {
      return getBookmarks().includes(String(lessonId || ''));
    },
    toggleBookmark(lessonId) {
      const id = String(lessonId || '');
      if (!id) return false;
      const bookmarks = getBookmarks();
      const index = bookmarks.indexOf(id);
      if (index >= 0) bookmarks.splice(index, 1);
      else bookmarks.push(id);
      writeJSON(storage, BOOKMARK_STORAGE_KEY, bookmarks);
      return index < 0;
    },
  };
}

export const learningState = createLearningState();
