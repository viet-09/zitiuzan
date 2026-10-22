// js/book-content.js
// The lesson bodies, classification, images and Vietnamese explanations total
// ~2.3 MB — most of it text a learner never opens. Fetching all of it at boot
// cost several seconds on mobile before the dashboard could settle, so the
// payload is now fetched one category at a time, on first use.
//
// The manifest at data/book/manifest.json carries the lessonIds per category,
// which is all the router needs to decide which single file a lesson belongs
// to; the manifest itself is 5 KB and is the only thing loaded at boot.
//
// Two in-memory maps are kept here rather than in store.js: `loaded` records
// the categories whose payload is resident, and `inflight` dedupes concurrent
// requests for the same category so a fast double-navigation (or a lesson plus
// a search) cannot issue the same fetch twice.

import {
  mergeBookContent,
  setQuestionClassification,
  setLessonImages,
  setVietnameseExplanations,
  resetBookContent,
} from './store.js';

/** @typedef {{file:string, lessonIds:string[], enrichmentFiles?:string[]}} CategoryEntry */

/** @type {Map<string, boolean>} category id -> payload resident */
const loaded = new Map();

/** @type {Map<string, Promise<void>>} category id -> pending load */
const inflight = new Map();

/** The manifest, fetched once on first demand. */
let manifestPromise = null;

/** Cached category lookup: lessonId -> category id. */
const lessonCategory = new Map();

/**
 * Fetch and remember data/book/manifest.json.
 * @returns {Promise<Record<string, CategoryEntry>>}
 */
async function getManifest() {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const res = await fetch('data/book/manifest.json');
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const manifest = await res.json();
    const categories = manifest?.categories;
    if (!categories || typeof categories !== 'object') throw new Error('manifest has no categories');
    for (const [id, entry] of Object.entries(categories)) {
      if (!entry || !Array.isArray(entry.lessonIds)) continue;
      for (const lessonId of entry.lessonIds) lessonCategory.set(lessonId, id);
    }
    return categories;
  })();
  manifestPromise.catch(() => { manifestPromise = null; });
  return manifestPromise;
}

/** Category that owns this lesson, or '' when the id is unknown. */
function categoryFor(lessonId) {
  return lessonCategory.get(String(lessonId || '')) || '';
}

/**
 * Load one category's main payload plus its enrichment files.
 * Idempotent: a second call for the same category resolves at once.
 * @param {string} category
 * @param {Record<string, CategoryEntry>} categories manifest categories
 */
function loadCategory(category, categories) {
  if (loaded.get(category)) return Promise.resolve();
  if (inflight.has(category)) return inflight.get(category);

  const entry = categories[category];
  const task = (async () => {
    if (!entry?.file) return;
    const main = await fetch(`data/book/${encodeURIComponent(entry.file)}`);
    if (!main.ok) throw new Error(`${entry.file} HTTP ${main.status}`);
    mergeBookContent(await main.json());

    for (const suffix of Array.isArray(entry.enrichmentFiles) ? entry.enrichmentFiles : []) {
      try {
        // Enrichment is optional per category — a missing file must not fail
        // the load, matching the previous all-at-once behaviour.
        const res = await fetch(`data/book/${encodeURIComponent(category)}.${encodeURIComponent(suffix)}`);
        if (!res.ok) continue;
        const data = await res.json();
        if (!data || typeof data !== 'object') continue;
        if (suffix === 'classification.json') {
          for (const [lessonId, body] of Object.entries(data)) {
            if (body && Array.isArray(body.questions)) setQuestionClassification(lessonId, body.questions);
          }
        } else if (suffix === 'images.json') {
          for (const [lessonId, list] of Object.entries(data)) {
            if (Array.isArray(list)) setLessonImages(lessonId, list);
          }
        } else if (suffix === 'vietnamese.json') {
          for (const [lessonId, list] of Object.entries(data)) {
            if (Array.isArray(list)) setVietnameseExplanations(lessonId, list);
          }
        }
      } catch {
        // enrichment is optional; skip silently
      }
    }
    loaded.set(category, true);
  })();

  inflight.set(category, task);
  return task.finally(() => inflight.delete(category));
}

/**
 * Make one lesson's book content available. Resolves once the category is
 * resident, or immediately if no manifest entry owns the lesson.
 *
 * @param {string} lessonId
 * @returns {Promise<'loaded'|'missing'|'failed'>} 'loaded' when the body is
 *   resident, 'missing' when the manifest does not know this lesson, and
 *   'failed' when the fetch failed — the caller shows a different message for
 *   each, so a network error never looks like an empty lesson.
 */
export async function ensureLessonContent(lessonId) {
  const id = String(lessonId || '');
  if (!id) return 'missing';
  if (loaded.get(categoryFor(id))) return 'loaded';
  try {
    const categories = await getManifest();
    const category = categoryFor(id);
    if (!category) return 'missing';
    await loadCategory(category, categories);
    return loaded.get(category) ? 'loaded' : 'failed';
  } catch (err) {
    console.warn('[book] category load failed:', err);
    return 'failed';
  }
}

/**
 * Load every category. Only the curriculum search needs this — it scores every
 * lesson's body text — and it is invoked the first time the learner focuses the
 * search field, never at boot.
 * @returns {Promise<void>}
 */
export async function ensureAllBookContent() {
  const categories = await getManifest();
  await Promise.all(
    Object.keys(categories).map((category) => loadCategory(category, categories).catch((err) => {
      console.warn('[book] category load failed:', err);
    }))
  );
}

/** How many categories are currently resident. Used by tests and diagnostics. */
export function loadedCategoryCount() {
  let count = 0;
  for (const value of loaded.values()) if (value) count += 1;
  return count;
}

/** Drop every resident payload (e.g. a stale manifest after a content update). */
export function resetLoadedCategories() {
  loaded.clear();
  inflight.clear();
  lessonCategory.clear();
  manifestPromise = null;
  resetBookContent();
}
