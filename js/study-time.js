// js/study-time.js — tracks real (tab-visible) time spent on a lesson page
// and periodically flushes it to record_study_time() so the leaderboard's
// "Tổng giờ học" / "TB mỗi buổi" reflect actual study time, not a guess.
//
// One lesson visit = one "session" for averaging purposes: the FIRST flush
// of a visit is tagged p_new_session=true, every later flush (periodic tick,
// or the final flush on leaving) only adds duration.

import { getClient } from './supabase.js';

const FLUSH_INTERVAL_MS = 30_000;
const IDLE_CAP_MS = 3 * 60 * 60 * 1000; // matches the server's per-call cap
const MIN_FLUSH_MS = 3000; // skip near-instant accidental visits

/**
 * Starts tracking active (non-backgrounded) time on the current lesson.
 * Returns `{ flush }` — call `flush()` from the route's cleanup so the
 * final partial segment is recorded when the user navigates away.
 */
export function startLessonTimer() {
  let activeSince = document.visibilityState === 'visible' ? Date.now() : null;
  let pendingMs = 0;
  let isFirstFlush = true;
  let stopped = false;

  function takeElapsed() {
    const now = Date.now();
    if (activeSince != null) {
      pendingMs += Math.min(now - activeSince, IDLE_CAP_MS);
      activeSince = now;
    }
    const taken = pendingMs;
    pendingMs = 0;
    return taken;
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      activeSince = Date.now();
    } else if (activeSince != null) {
      pendingMs += Math.min(Date.now() - activeSince, IDLE_CAP_MS);
      activeSince = null;
    }
  }

  async function flushNow() {
    const durationMs = takeElapsed();
    if (durationMs < MIN_FLUSH_MS) return;
    const newSession = isFirstFlush;
    isFirstFlush = false;
    try {
      const sb = await getClient();
      if (!sb) return; // not signed in — nothing to sync
      await sb.rpc('record_study_time', { p_duration_ms: Math.round(durationMs), p_new_session: newSession });
    } catch (err) {
      console.warn('[study-time] failed to record:', err);
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  const intervalId = setInterval(() => { void flushNow(); }, FLUSH_INTERVAL_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', stop);
    clearInterval(intervalId);
    void flushNow();
  }
  // Router cleanup covers in-app navigation away from the lesson; pagehide
  // covers an outright tab/browser close, where the periodic tick may not
  // have run recently — best-effort only, the async RPC may not finish
  // before the page actually unloads.
  window.addEventListener('pagehide', stop);

  return { flush: stop };
}
