// Small local cache of server-authored mock-exam evidence. It lets the
// dashboard calculate readiness immediately while the remote history loads.
//
// The cache is a convenience, not a source of truth. It is writable by the
// learner (DevTools, an extension) and readiness is a self-assessment, so the
// goal is not to make forgery impossible — it is to make sure a cache that was
// hand-written or tampered with cannot quietly inflate a score. Every entry
// must therefore look like a graded attempt: a server-assigned id, a numeric
// score, and a plausible created_at. Anything else is dropped.

export const EXAM_HISTORY_STORAGE_KEY = 'n2_exam_history_cache_v1';
const MAX_HISTORY = 20;

function read(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(EXAM_HISTORY_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function identity(item, index = 0) {
  return String(item?.id || item?.session_id || `exam:${item?.created_at || index}`);
}

/**
 * A graded attempt must carry the id the server assigned it. A hand-written
 * cache entry has no such id and is dropped rather than trusted.
 */
function isGradedAttempt(item) {
  if (!item?.id && !item?.session_id) return false;
  const pct = item?.score?.percentage;
  if (pct != null) {
    // The server writes "<n>%". Anything else — a bare number, a forged
    // 250%, a word — is a tampered entry.
    const match = /^(\d{1,3})%$/.exec(String(pct));
    if (!match) return false;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value > 100) return false;
  }
  const createdAt = Date.parse(item?.created_at || 0);
  return Number.isFinite(createdAt) && createdAt > 0;
}

function normalize(items) {
  const byId = new Map();
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    if (!isGradedAttempt(item)) return;
    const key = identity(item, index);
    if (!byId.has(key)) byId.set(key, { ...item });
  });
  return [...byId.values()]
    .sort((a, b) => Date.parse(b?.created_at || 0) - Date.parse(a?.created_at || 0))
    .slice(0, MAX_HISTORY);
}

export function createExamHistoryStore(storage = globalThis.localStorage) {
  const write = (items) => {
    const next = normalize(items);
    try { storage?.setItem(EXAM_HISTORY_STORAGE_KEY, JSON.stringify(next)); } catch { /* best effort */ }
    return next;
  };
  return {
    get() { return normalize(read(storage)); },
    replace(items) { return write(items); },
    add(item) { return write([item, ...read(storage)]); },
  };
}

export const examHistoryStore = createExamHistoryStore();
