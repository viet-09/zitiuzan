// js/store.js
// Thin localStorage wrapper + in-memory lessons cache.
// Every read is defensive: malformed/missing/blocked storage falls back to a safe default.

import { STORAGE, DEFAULT_SETTINGS } from './config.js';

// ---------------------------------------------------------------------------
// Generic localStorage helpers (never throw)
// ---------------------------------------------------------------------------

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage unavailable/full/blocked (e.g. private mode) — silently ignore.
  }
}

function localDateString(date = new Date()) {
  try {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch (err) {
    return '';
  }
}

function previousLocalDateString() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDateString(date);
}

// ---------------------------------------------------------------------------
// Lessons (in-memory, set once at boot from data/lessons.json)
// ---------------------------------------------------------------------------

let _lessons = null;
const _bookById = new Map();

export function setLessons(data) {
  _lessons = data && typeof data === 'object' ? data : null;
}

export function getLessons() {
  return _lessons;
}

/** Clear book content before a fresh manifest load. */
export function resetBookContent() {
  _bookById.clear();
  _classificationById.clear();
  _imagesById.clear();
  _vietnameseById.clear();
}

// ---------------------------------------------------------------------------
// Enrichment (classification.json + images.json + vietnamese.json) —
// read-only in-memory caches.
// ---------------------------------------------------------------------------

const _classificationById = new Map();
const _imagesById = new Map();
const _vietnameseById = new Map();

export function setQuestionClassification(lessonId, entries) {
  if (typeof lessonId !== 'string' || !lessonId) return;
  if (Array.isArray(entries)) _classificationById.set(lessonId, entries);
}

/** @returns {{type:string, descriptionVi:string}|null} */
export function getQuestionClassification(lessonId, index) {
  const list = _classificationById.get(String(lessonId || ''));
  if (!Array.isArray(list)) return null;
  const item = list.find((it) => Number(it?.index) === Number(index));
  return item && typeof item.type === 'string' && typeof item.descriptionVi === 'string'
    ? { type: item.type, descriptionVi: item.descriptionVi }
    : null;
}

export function setLessonImages(lessonId, entries) {
  if (typeof lessonId !== 'string' || !lessonId) return;
  if (Array.isArray(entries)) _imagesById.set(lessonId, entries);
}

/** @returns {Array<{src:string, kind?:string, captionVi?:string}>|null} */
export function getLessonImages(lessonId) {
  return _imagesById.get(String(lessonId || '')) || null;
}

/** entries: string[], one Vietnamese explanation per item, in the exact same
 * order the lesson's own primary array (kanji[]+reviewKanji[], flattened
 * sections[].words[], or patterns[]) is iterated in — see js/lesson.js's
 * renderKanji/renderVocabulary/renderGrammar for the matching iteration. */
export function setVietnameseExplanations(lessonId, entries) {
  if (typeof lessonId !== 'string' || !lessonId) return;
  if (Array.isArray(entries)) _vietnameseById.set(lessonId, entries);
}

/** @returns {string|null} the Vietnamese explanation for the item at `index`
 * (in the same flattened order used when the enrichment file was generated). */
export function getVietnameseExplanation(lessonId, index) {
  const list = _vietnameseById.get(String(lessonId || ''));
  const value = Array.isArray(list) ? list[index] : null;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Merge one extracted book JSON payload into the in-memory lesson index.
 * Supported payloads are `{ lessonId: content }`, `{ lessons: [...] }`, or an array
 * whose entries contain an `id` field.
 */
export function mergeBookContent(payload) {
  if (!payload || typeof payload !== 'object') return;

  const add = (id, content) => {
    if (typeof id !== 'string' || !id || !content || typeof content !== 'object') return;
    _bookById.set(id, content);
  };

  if (Array.isArray(payload)) {
    payload.forEach((entry) => add(entry && entry.id, entry));
    return;
  }

  if (Array.isArray(payload.lessons)) {
    payload.lessons.forEach((entry) => add(entry && entry.id, entry));
    return;
  }

  Object.entries(payload).forEach(([id, content]) => add(id, content));
}

export function getBookContent(id) {
  return _bookById.get(String(id || '')) || null;
}

/**
 * Search every category/week for a lesson id.
 * @returns {{lesson:object, category:object, week:object}|null}
 */
export function findLesson(id) {
  try {
    if (!_lessons || !Array.isArray(_lessons.categories)) return null;
    for (const category of _lessons.categories) {
      if (!category || !Array.isArray(category.weeks)) continue;
      for (const week of category.weeks) {
        if (!week || !Array.isArray(week.lessons)) continue;
        const lesson = week.lessons.find((l) => l && l.id === id);
        if (lesson) return { lesson, category, week };
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * @returns {{total:number, done:number, byCategory:Object<string,{total:number,done:number}>}}
 */
export function countProgress() {
  const result = { total: 0, done: 0, byCategory: {} };
  try {
    if (!_lessons || !Array.isArray(_lessons.categories)) return result;
    for (const category of _lessons.categories) {
      if (!category || !Array.isArray(category.weeks)) continue;
      const bucket = result.byCategory[category.id] || { total: 0, done: 0 };
      for (const week of category.weeks) {
        if (!week || !Array.isArray(week.lessons)) continue;
        for (const lesson of week.lessons) {
          if (!lesson) continue;
          result.total += 1;
          bucket.total += 1;
          if (isDone(lesson.id)) {
            result.done += 1;
            bucket.done += 1;
          }
        }
      }
      result.byCategory[category.id] = bucket;
    }
  } catch (err) {
    return result;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Progress (done/not-done per lesson id)
// ---------------------------------------------------------------------------

function readProgressMap() {
  const map = readJSON(STORAGE.progress, {});
  return map && typeof map === 'object' ? map : {};
}

/** Defensive snapshot for planning/readiness without exposing mutable state. */
export function getProgressMap() {
  return { ...readProgressMap() };
}

function writeProgressMap(map) {
  writeJSON(STORAGE.progress, map);
}

/** Replace the entire done-map. Used by sync layer after pulling from cloud. */
export function writeProgressMapExternal(map) {
  writeProgressMap(map && typeof map === 'object' ? map : {});
}

export function isDone(id) {
  try {
    return !!readProgressMap()[id];
  } catch (err) {
    return false;
  }
}

/**
 * Flip completion state for a lesson, persist, bump streak when it becomes done.
 * @returns {boolean} the new done state
 */
export function toggleDone(id) {
  try {
    const map = readProgressMap();
    const next = !map[id];
    if (next) {
      map[id] = true;
    } else {
      delete map[id];
    }
    writeProgressMap(map);
    if (next) touchStreak();
    return next;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Streak
// ---------------------------------------------------------------------------

function readStreak() {
  const s = readJSON(STORAGE.streak, { streak: 0, lastDate: '' });
  if (!s || typeof s !== 'object') return { streak: 0, lastDate: '' };
  return {
    streak: typeof s.streak === 'number' ? s.streak : 0,
    lastDate: typeof s.lastDate === 'string' ? s.lastDate : '',
  };
}

/**
 * Update the streak counter based on today's date.
 * - same day as lastDate  -> no-op
 * - lastDate === yesterday -> streak += 1
 * - otherwise             -> streak resets to 1
 */
export function touchStreak() {
  try {
    const today = localDateString();
    const current = readStreak();
    if (!today || current.lastDate === today) return;

    const yesterday = previousLocalDateString();
    const next = {
      streak: current.lastDate === yesterday ? current.streak + 1 : 1,
      lastDate: today,
    };
    writeJSON(STORAGE.streak, next);
  } catch (err) {
    // ignore
  }
}

export function getStreak() {
  const current = readStreak();
  const today = localDateString();
  const yesterday = previousLocalDateString();
  if (!current.lastDate || (current.lastDate !== today && current.lastDate !== yesterday)) {
    return { streak: 0, lastDate: current.lastDate };
  }
  return current;
}

/** Replace streak entirely. Used by sync layer after pulling from cloud. */
export function writeStreak(value) {
  const safe = {
    streak: Number.isFinite(value?.streak) ? Math.max(0, Math.floor(value.streak)) : 0,
    lastDate: typeof value?.lastDate === 'string' ? value.lastDate : '',
  };
  writeJSON(STORAGE.streak, safe);
}

// ---------------------------------------------------------------------------
// Tutor chat history: array of { role: 'user'|'model', text }
// ---------------------------------------------------------------------------

export function getTutorHistory() {
  const arr = readJSON(STORAGE.tutor, []);
  return Array.isArray(arr) ? arr : [];
}

export function setTutorHistory(arr) {
  writeJSON(STORAGE.tutor, Array.isArray(arr) ? arr : []);
}

export function clearTutorHistory() {
  writeJSON(STORAGE.tutor, []);
}

export function getTutorContext() {
  const value = readJSON(STORAGE.tutorContext, null);
  return value && typeof value === 'object' ? value : null;
}

export function setTutorContext(context) {
  if (context && typeof context === 'object') writeJSON(STORAGE.tutorContext, context);
  else writeJSON(STORAGE.tutorContext, null);
}

// Short rolling note on the learner's habits/mistakes/preferred conversational style,
// refreshed periodically by tutor.js so future sessions can pick up where they left off.
export function getTutorMemory() {
  const value = readJSON(STORAGE.tutorMemory, '');
  return typeof value === 'string' ? value : '';
}

export function setTutorMemory(note) {
  writeJSON(STORAGE.tutorMemory, typeof note === 'string' ? note.trim().slice(0, 600) : '');
}

// ---------------------------------------------------------------------------
// Voice transcript + tap-kanji explanation cache
// ---------------------------------------------------------------------------

export function getVoiceTranscript() {
  const value = readJSON(STORAGE.voice, []);
  return Array.isArray(value) ? value : [];
}

export function setVoiceTranscript(messages) {
  writeJSON(STORAGE.voice, Array.isArray(messages) ? messages.slice(-200) : []);
}

export function clearVoiceTranscript() {
  writeJSON(STORAGE.voice, []);
}

export function getKanjiGloss(key) {
  const map = readJSON(STORAGE.kanjiGloss, {});
  return map && typeof map === 'object' ? map[String(key || '')] || null : null;
}

export function setKanjiGloss(key, value) {
  if (!key || !value) return;
  const map = readJSON(STORAGE.kanjiGloss, {});
  const safeMap = map && typeof map === 'object' ? map : {};
  safeMap[String(key)] = value;
  writeJSON(STORAGE.kanjiGloss, safeMap);
}

// ---------------------------------------------------------------------------
// Settings (merged over DEFAULT_SETTINGS)
// ---------------------------------------------------------------------------

export function getSettings() {
  try {
    const stored = readJSON(STORAGE.settings, {});
    return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(patch) {
  try {
    const merged = { ...getSettings(), ...(patch && typeof patch === 'object' ? patch : {}) };
    writeJSON(STORAGE.settings, merged);
    return merged;
  } catch (err) {
    return getSettings();
  }
}
