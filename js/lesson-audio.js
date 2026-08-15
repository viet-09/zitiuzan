// js/lesson-audio.js — resolves listening-lesson audio storage keys (e.g.
// "cd1/02.mp3") to short-lived signed URLs via the lesson-audio-url Edge
// Function. The raw CD-rip source lives in N2_somatome/ (gitignored,
// owned/copyrighted — never shipped to production as a static file), so
// data/book/listening.json's audioTracks/introTracks `src` fields hold a
// storage key rather than a directly-servable path. Same pattern as
// js/exam.js's exam-fetch audio handling, just resolved lazily per lesson
// instead of upfront with the rest of the exam content.

import { getClient } from './supabase.js';

const cache = new Map(); // key -> { url, expiresAt }
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // server signs for 1h; refresh a bit early

async function resolveKeys(keys) {
  const now = Date.now();
  const uncached = keys.filter((key) => {
    const hit = cache.get(key);
    return !hit || hit.expiresAt - REFRESH_MARGIN_MS < now;
  });
  if (uncached.length === 0) return;

  const sb = await getClient();
  if (!sb) return;
  try {
    const { data, error } = await sb.functions.invoke('lesson-audio-url', { body: { keys: uncached } });
    if (error || !data?.urls) return;
    const expiresAt = now + 55 * 60 * 1000;
    for (const [key, url] of Object.entries(data.urls)) {
      if (url) cache.set(key, { url, expiresAt });
    }
  } catch {
    // Audio is a nice-to-have on top of the transcript/questions — leave
    // the <audio> elements without a src rather than breaking the page.
  }
}

/**
 * Finds every `<audio data-lesson-audio-key="...">` under `root`, resolves
 * their signed URLs (batched, cached), and sets `.src`. Safe to call after
 * every re-render — already-resolved, still-fresh elements are left alone.
 */
export async function hydrateLessonAudio(root) {
  if (!root) return;
  const elements = Array.from(root.querySelectorAll('audio[data-lesson-audio-key]'));
  if (elements.length === 0) return;

  const keys = [...new Set(elements.map((el) => el.dataset.lessonAudioKey).filter(Boolean))];
  await resolveKeys(keys);

  for (const el of elements) {
    const hit = cache.get(el.dataset.lessonAudioKey);
    if (hit && el.src !== hit.url) el.src = hit.url;
  }
}
