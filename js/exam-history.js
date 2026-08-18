// Small local cache of server-authored mock-exam evidence. It lets the
// dashboard calculate readiness immediately while the remote history loads.

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
  return String(item?.id || item?.session_id || `${item?.source_file || 'exam'}:${item?.created_at || index}`);
}

function normalize(items) {
  const byId = new Map();
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
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
