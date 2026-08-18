// Server-timed study sessions. The client only sends heartbeats; credited
// duration is derived from database timestamps so leaderboard hours cannot be
// inflated by submitting an arbitrary millisecond value.

import { getClient } from './supabase.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export function startLessonTimer(lessonId) {
  let sessionPromise = document.visibilityState === 'visible' ? openSession() : null;
  let stopped = false;

  async function openSession() {
    try {
      const sb = await getClient();
      if (!sb) return null;
      const { data, error } = await sb.rpc('start_study_session', { p_lesson_id: lessonId });
      if (error) throw error;
      return data || null;
    } catch (error) {
      console.warn('[study-time] failed to start:', error);
      return null;
    }
  }

  async function heartbeat(close = false) {
    const current = sessionPromise;
    if (!current) return;
    const sessionId = await current;
    if (!sessionId) return;
    try {
      const sb = await getClient();
      if (!sb) return;
      const { error } = await sb.rpc('heartbeat_study_session', {
        p_session_id: sessionId,
        p_close: Boolean(close),
      });
      if (error) throw error;
    } catch (error) {
      console.warn('[study-time] heartbeat failed:', error);
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      if (!sessionPromise) sessionPromise = openSession();
    } else if (sessionPromise) {
      void heartbeat(true);
      sessionPromise = null;
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  const intervalId = setInterval(() => {
    if (document.visibilityState === 'visible') void heartbeat(false);
  }, HEARTBEAT_INTERVAL_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', stop);
    clearInterval(intervalId);
    void heartbeat(true);
    sessionPromise = null;
  }

  window.addEventListener('pagehide', stop);
  return { flush: stop };
}
