// Listening audio lives on a GitHub Release, not in Supabase Storage.
//
// Release assets are the only GitHub surface built for files this size: they
// sit outside the git tree (so `git clone` and every Vercel build stay small),
// they allow 2 GB per file where Supabase Storage capped objects at 50 MB, and
// they cost nothing. That also means the URLs are plain and permanent — there
// is no signing round trip, so `<audio src>` can be set the moment a lesson or
// exam renders instead of waiting on an Edge Function.
//
// Asset names are flat: a release cannot hold `/` in a name, so the storage
// keys are folded into a prefix (`cd1/02.mp3` -> `lesson-cd1-02.mp3`).
//
// Pure module — no DOM, no network. See scripts/upload-audio-github.mjs for
// the uploader that puts the matching assets on the release.

export const AUDIO_REPO = 'viet-09/zitiuzan';
export const AUDIO_RELEASE_TAG = 'audio-v1';
export const AUDIO_RELEASE_BASE = `https://github.com/${AUDIO_REPO}/releases/download/${AUDIO_RELEASE_TAG}`;

// The same shapes the old Edge Functions validated. Names are built, never
// echoed, so a malformed key yields no URL rather than a guessable one.
const LESSON_KEY = /^cd[12]\/\d{2}\.mp3$/;
const EXAM_LEVEL = /^[Nn][1-5]$/;
const EXAM_SITTING = /^\d{4}-\d{2}$/;

/** Release asset name for a listening-lesson track key, or '' if malformed. */
export function lessonAudioAssetName(key) {
  const value = String(key ?? '');
  if (!LESSON_KEY.test(value)) return '';
  return `lesson-${value.replace('/', '-')}`;
}

/** Release asset name for one exam sitting's audio, or '' if malformed. */
export function examAudioAssetName(level, sitting) {
  const lvl = String(level ?? '');
  const sit = String(sitting ?? '');
  if (!EXAM_LEVEL.test(lvl) || !EXAM_SITTING.test(sit)) return '';
  return `exam-${lvl.toLowerCase()}-${sit}.mp3`;
}

/** Playable URL for a lesson track key, or '' if the key is malformed. */
export function lessonAudioUrl(key) {
  const name = lessonAudioAssetName(key);
  return name ? `${AUDIO_RELEASE_BASE}/${name}` : '';
}

/**
 * Playback-ordered URLs for one exam sitting.
 *
 * Supabase capped objects at 50 MB, so long sittings were split into ordered
 * parts and the client chained them. A release asset holds the whole sitting,
 * so this is always one URL — the array shape stays because js/exam.js still
 * supports multi-part playback for anything that needs it later.
 */
export function examAudioUrls(level, sitting) {
  const name = examAudioAssetName(level, sitting);
  return name ? [`${AUDIO_RELEASE_BASE}/${name}`] : [];
}
