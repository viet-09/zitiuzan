// Saves a half-finished writing sheet so reopening a lesson picks up where the
// pen left off.
//
// Ink is bulky — a single stroke is a couple of dozen points, and a full sheet
// is a dozen characters times a dozen squares — so points are stored as flat
// arrays of integers on a 0..1000 grid rather than as objects of floats. That
// is about a fifth of the JSON, and a thousandth of a square is far finer than
// anyone can draw. Empty squares are dropped entirely, which is most of them
// for most of a session.
//
// Pure apart from the storage handle, so the encoding is testable on its own.

export const SHEET_STORAGE_KEY = 'n2_kanji_sheet_v1';

/** Sheets kept before the oldest is evicted, so storage cannot grow forever. */
export const MAX_SAVED_SHEETS = 12;

const GRID = 1000;

const clamp = (value) => Math.min(GRID, Math.max(0, Math.round(value)));

/**
 * One stroke, canvas pixels in, flat 0..1000 integers out.
 * @param {{x:number,y:number}[]} points
 * @param {number} size the canvas edge length these points were drawn on
 */
export function encodeStroke(points, size) {
  const scale = GRID / (size || GRID);
  const out = [];
  for (const point of points || []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    out.push(clamp(point.x * scale), clamp(point.y * scale));
  }
  return out;
}

/** The inverse, back to canvas pixels. */
export function decodeStroke(flat, size) {
  const scale = (size || GRID) / GRID;
  const out = [];
  for (let index = 0; index + 1 < (flat?.length || 0); index += 2) {
    out.push({ x: flat[index] * scale, y: flat[index + 1] * scale });
  }
  return out;
}

function readAll(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(SHEET_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The saved sheet for one lesson.
 * @returns {{rows: object, savedAt: number}|null}
 */
export function loadSheet(lessonId, storage = globalThis.localStorage) {
  const entry = readAll(storage)[String(lessonId || '')];
  return entry && typeof entry.rows === 'object' ? entry : null;
}

/**
 * Persist one lesson's sheet, evicting the least recently saved when full.
 * A sheet with no ink at all is removed rather than stored.
 * @param {string} lessonId
 * @param {object} rows `{ [character]: { [cellIndex]: { s: number[][], a: number } } }`
 */
export function saveSheet(lessonId, rows, storage = globalThis.localStorage) {
  const key = String(lessonId || '');
  if (!key) return false;
  const all = readAll(storage);
  const hasInk = Object.values(rows || {}).some((row) => Object.keys(row || {}).length);

  // Recency is a counter, not a clock. Timestamps tie whenever two sheets are
  // saved inside the same millisecond, and a stable sort then keeps them in
  // insertion order — oldest first — so eviction threw away the newest sheet
  // instead of the stalest one.
  const nextSeq = Math.max(0, ...Object.values(all).map((entry) => Number(entry?.seq) || 0)) + 1;
  if (!hasInk) delete all[key];
  else all[key] = { rows, savedAt: Date.now(), seq: nextSeq };

  const newestFirst = Object.keys(all).sort((a, b) => (all[b].seq || 0) - (all[a].seq || 0));
  for (const stale of newestFirst.slice(MAX_SAVED_SHEETS)) delete all[stale];

  try {
    storage?.setItem(SHEET_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    // A full quota should never cost the learner the stroke they just drew;
    // the sheet stays correct on screen, it just will not survive a reload.
    return false;
  }
}

/** Forget one lesson's sheet, e.g. after "Xóa cả tờ". */
export function clearSheet(lessonId, storage = globalThis.localStorage) {
  return saveSheet(lessonId, {}, storage);
}
