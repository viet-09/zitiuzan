// js/lesson-audio.js — points every `<audio data-lesson-audio-key>` at its
// track on the GitHub Release that hosts the listening audio (see
// js/audio-source.js). data/book/listening.json's audioTracks/introTracks
// `src` fields hold a storage key like "cd1/02.mp3" rather than a servable
// path, because the CD rip is gitignored and never ships with the site.
//
// This used to mint short-lived signed URLs through the lesson-audio-url Edge
// Function, which meant a network round trip and an expiry cache before any
// audio could play. Release URLs are permanent and public, so hydration is now
// a synchronous rewrite.

import { lessonAudioUrl } from './audio-source.js';

/**
 * Finds every `<audio data-lesson-audio-key="...">` under `root` and sets its
 * `src`. Safe to call after every re-render — elements already pointing at the
 * right track are left alone so playback is never interrupted.
 * @param {ParentNode | null} root
 */
export function hydrateLessonAudio(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('audio[data-lesson-audio-key]')) {
    const url = lessonAudioUrl(el.dataset.lessonAudioKey);
    if (url && el.src !== url) el.src = url;
  }
}
