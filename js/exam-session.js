// js/exam-session.js
// Persists an in-progress mock exam so a refresh, a crashed tab, or a phone
// that reclaims memory does not cost the learner the whole 155-minute sit.
//
// What is saved: the sitting identity, which phase the learner is in, the
// absolute phase deadline (so the clock keeps running across the reload
// instead of restarting), the answers given so far, and the listening part
// index.
//
// What is NOT saved: the exam content itself. It is re-fetched from the
// exam-fetch Edge Function on resume, which keeps the answer key on the
// server exactly where it was.

export const EXAM_SESSION_STORAGE_KEY = 'n2_exam_session_v1';

const MAX_ANSWERS = 400;

// The account the app currently considers signed in. The snapshot lives in
// sessionStorage, which outlives a sign-out/sign-in in the same tab, so
// without this the next learner on the device would be offered the previous
// one's sitting. Kept as module state (set once by the auth wiring in
// js/app.js) so the exam route can decide synchronously instead of awaiting
// `currentUser()` before its first paint.
let ownerId = '';

/** Record which account is signed in; '' when signed out. */
export function setExamSessionOwner(userId) {
  ownerId = String(userId || '');
}

/**
 * @param {{userId?:string, level?:string, sitting?:string, phaseIndex?:number, phaseDeadline?:number,
 *   activeSectionId?:string, answers?:Map<string,number>|Array<[string,number]>,
 *   audioPartIndex?:number}} state
 * @returns {object|null} the serializable snapshot, or null if not resumable
 */
export function toSessionSnapshot(state) {
  if (!state || !state.level || !state.sitting) return null;
  const answers = state.answers instanceof Map
    ? [...state.answers.entries()]
    : Array.isArray(state.answers) ? state.answers : [];
  if (!answers.length) return null;
  return {
    userId: String(state.userId ?? ownerId),
    level: String(state.level),
    sitting: String(state.sitting),
    phaseIndex: Math.max(0, Number(state.phaseIndex) || 0),
    phaseDeadline: Number(state.phaseDeadline) || 0,
    activeSectionId: String(state.activeSectionId || ''),
    answers: answers.slice(0, MAX_ANSWERS),
    audioPartIndex: Math.max(0, Number(state.audioPartIndex) || 0),
  };
}

/**
 * Read the stored snapshot, ignoring anything malformed or issued for a
 * different account.
 *
 * @param {string} [userId] defaults to the signed-in owner; a snapshot
 *   belonging to another account is discarded (treated as absent).
 */
export function readExamSession(userId = ownerId, storage = globalThis.sessionStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(EXAM_SESSION_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.level || !parsed.sitting) return null;
    if (!Array.isArray(parsed.answers) || !parsed.answers.length) return null;
    // A snapshot that names its owner belongs to that owner only. With no
    // signed-in account there is nobody to attribute it to, so it is not
    // offered at all. Snapshots written before the owner stamp existed have
    // no userId and stay readable.
    if (parsed.userId && (!userId || parsed.userId !== userId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a snapshot. Silently does nothing when storage is unavailable. */
export function writeExamSession(snapshot, storage = globalThis.sessionStorage) {
  if (!snapshot) return false;
  try {
    storage?.setItem(EXAM_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

/** Drop the stored snapshot — called once the exam has been submitted. */
export function clearExamSession(storage = globalThis.sessionStorage) {
  try {
    storage?.removeItem(EXAM_SESSION_STORAGE_KEY);
  } catch {
    /* storage may be blocked */
  }
}

/**
 * A snapshot is only worth resuming while its phase deadline is still in the
 * future. Once the clock has run out the exam is over; resuming it would let
 * a learner keep answering after their time.
 */
export function isSessionResumable(snapshot, now = Date.now()) {
  if (!snapshot) return false;
  const deadline = Number(snapshot.phaseDeadline) || 0;
  if (!deadline) return false;
  return deadline > now;
}

/** Rebuild the answers map from a stored snapshot. */
export function answersFromSnapshot(snapshot) {
  const map = new Map();
  if (!snapshot || !Array.isArray(snapshot.answers)) return map;
  for (const entry of snapshot.answers) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [key, value] = entry;
    if (typeof key !== 'string' || !key) continue;
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0) continue;
    map.set(key, index);
  }
  return map;
}
