// js/sync.js
// First-login migration: read every legacy localStorage key, write to Supabase,
// then clear local. Subsequent loads: pull from DB into in-memory caches.
// Idempotent via a per-user migration flag in localStorage.

import {
  getClient,
  currentUser,
} from './supabase.js';
import {
  writeProgressMapExternal,
  writeStreak,
  setSettings,
} from './store.js';
import { normalizeProfile, saveProfile } from './profile.js';
import { migrateLegacyStorage } from './account-storage.js';
import { learningState } from './learning-state.js';
import { mergeReviewCollections, reviewFromRow, reviewToRow } from './review-sync.js';

const COMPLETION_QUEUE_KEY = 'n2_completion_queue_v1';
const REVIEW_QUEUE_KEY = 'n2_review_sync_queue_v1';

// Map each legacy localStorage key → { table, mapper }.
// `mapper(legacyValue, userId)` returns the rows to upsert (with user_id set).
// Returning [] / null / undefined skips the table for that key.
const LEGACY_KEYS = {
  n2_progress_v2: {
    table: 'learning_progress',
    map(value, userId) {
      if (!value || typeof value !== 'object') return [];
      const rows = [];
      for (const [lessonId, done] of Object.entries(value)) {
        if (done) {
          // category_id is recovered later via lesson lookup; we just leave it
          // blank and let the dashboard backfill if needed.
          rows.push({ user_id: userId, lesson_id: lessonId, category_id: '' });
        }
      }
      return rows;
    },
  },
  n2_streak_v2: {
    table: 'user_profiles',
    map(value, userId) {
      // Update profile row; RLS allows auth.uid() = user_id.
      if (!value || typeof value !== 'object') return null;
      return {
        user_id: userId,
        streak: Number.isFinite(value.streak) ? Math.max(0, Math.floor(value.streak)) : 0,
        last_study_date: typeof value.lastDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.lastDate)
          ? value.lastDate
          : null,
      };
    },
  },
  n2_profile_v2: {
    table: 'user_profiles',
    map(value, userId) {
      // Uploaded photos stay local-only (see js/profile.js) — only the
      // display name and, for preset avatars, the preset id are migrated.
      const profile = normalizeProfile(value);
      const patch = { user_id: userId, display_name: profile.name };
      if (profile.avatarType === 'preset') {
        patch.avatar_type = 'preset';
        patch.avatar_data = profile.avatarData;
      }
      return patch;
    },
  },
  n2_settings_v2: {
    table: 'user_profiles',
    map(value, userId) {
      if (!value || typeof value !== 'object') return null;
      // API key intentionally NOT migrated — Edge Function owns AI calls now.
      const patch = { user_id: userId };
      if (typeof value.furigana === 'boolean') patch.furigana = value.furigana;
      if (typeof value.examTargetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.examTargetDate)) {
        patch.exam_target_date = value.examTargetDate;
      }
      return Object.keys(patch).length > 1 ? patch : null;
    },
  },
  n2_reviews_v1: {
    table: 'learning_reviews',
    map(value, userId) {
      return Array.isArray(value) ? value.map((review) => reviewToRow(review, userId)).filter((row) => row.review_key && row.lesson_id) : [];
    },
  },
  n2_content_v2: {
    table: 'lesson_content_cache',
    map(value, userId) {
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).map(([lessonId, payload]) => ({
        user_id: userId,
        lesson_id: lessonId,
        payload: payload ?? null,
      }));
    },
  },
  n2_tutor_v2: {
    table: 'tutor_messages',
    map(value, userId) {
      if (!Array.isArray(value)) return [];
      return value
        .filter((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string')
        .map((m) => ({ user_id: userId, role: m.role, text: m.text.slice(0, 4000) }));
    },
  },
  n2_tutor_memory_v2: {
    table: 'user_profiles',
    map(value, userId) {
      if (typeof value !== 'string' || !value) return null;
      return { user_id: userId, tutor_memory: value.slice(0, 600) };
    },
  },
  n2_voice_transcript_v2: {
    table: 'voice_messages',
    map(value, userId) {
      if (!Array.isArray(value)) return [];
      return value
        .filter((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string')
        .map((m) => ({
          user_id: userId,
          topic: typeof m.topic === 'string' ? m.topic : 'free',
          role: m.role,
          text: m.text.slice(0, 4000),
        }));
    },
  },
  n2_kanji_gloss_v2: {
    table: 'kanji_gloss_cache',
    map(value, userId) {
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).map(([key, payload]) => ({
        user_id: userId,
        key: String(key),
        payload: payload ?? null,
      }));
    },
  },
};

/**
 * One-shot LocalStorage → Supabase migration. Returns true if any data was
 * pushed, false if nothing to do ( no legacy data or already migrated ).
 */
export async function maybeMigrateLocalData() {
  const sb = await getClient();
  if (!sb) return false;
  const user = await currentUser();
  if (!user) return false;

  const result = await migrateLegacyStorage({
    storage: localStorage,
    userId: user.id,
    definitions: LEGACY_KEYS,
    upsert: (table, rows) => sb.from(table).upsert(rows),
  });
  return result.migrated;
}

function readCompletionQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPLETION_QUEUE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCompletionQueue(queue) {
  try { localStorage.setItem(COMPLETION_QUEUE_KEY, JSON.stringify(queue.slice(-100))); } catch { /* best effort */ }
}

function readReviewQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(REVIEW_QUEUE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeReviewQueue(queue) {
  try { localStorage.setItem(REVIEW_QUEUE_KEY, JSON.stringify(queue.slice(-1000))); } catch { /* best effort */ }
}

export function queueReviewMutation(review, userId) {
  if (!userId || !review?.key) return;
  const queue = readReviewQueue().filter((item) => !(item.userId === userId && item.review?.key === review.key));
  queue.push({ userId, review: { ...review }, queuedAt: new Date().toISOString() });
  writeReviewQueue(queue);
}

export async function pushReviewRemote(review, userId) {
  const sb = await getClient();
  if (!sb || !userId || !review?.key || !review?.lessonId) throw new Error('Review sync unavailable');
  const row = { ...reviewToRow(review, userId), updated_at: new Date().toISOString() };
  const { error } = await sb.from('learning_reviews').upsert(row, { onConflict: 'user_id,review_key' });
  if (error) throw error;
  return row;
}

export async function syncReviewRemote(review, userId) {
  try {
    await pushReviewRemote(review, userId);
  } catch (error) {
    queueReviewMutation(review, userId);
    throw error;
  }
}

export async function flushReviewQueue(userId) {
  if (!userId) return;
  const queue = readReviewQueue();
  const currentByKey = new Map(learningState.getReviews().map((review) => [review.key, review]));
  const others = queue.filter((item) => item.userId !== userId);
  const failed = [];
  for (const item of queue.filter((entry) => entry.userId === userId)) {
    const review = currentByKey.get(item.review?.key) || item.review;
    try {
      await pushReviewRemote(review, userId);
    } catch {
      failed.push({ ...item, review });
    }
  }
  writeReviewQueue([...others, ...failed]);
}

export function queueCompletionMutation(mutation, user) {
  if (!user?.id || !mutation?.lessonId) return;
  const queue = readCompletionQueue().filter((item) => !(
    item.userId === user.id && item.lessonId === mutation.lessonId
  ));
  queue.push({ ...mutation, userId: user.id, queuedAt: new Date().toISOString() });
  writeCompletionQueue(queue);
}

export async function setLessonCompletionRemote({ lessonId, categoryId, done }) {
  const sb = await getClient();
  if (!sb) throw new Error('Supabase unavailable');
  const { data, error } = await sb.rpc('set_lesson_completion', {
    p_lesson_id: lessonId,
    p_category_id: categoryId,
    p_done: Boolean(done),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { streak: Number(row.streak) || 0, lastDate: row.last_date || '' } : null;
}

export async function flushCompletionQueue(userId) {
  if (!userId) return;
  const queue = readCompletionQueue();
  const mine = queue.filter((item) => item.userId === userId);
  const others = queue.filter((item) => item.userId !== userId);
  const failed = [];
  for (const item of mine) {
    try {
      await setLessonCompletionRemote(item);
    } catch {
      failed.push(item);
    }
  }
  writeCompletionQueue([...others, ...failed]);
}

/**
 * Pull the authed user's data from Supabase and seed the in-memory caches
 * so the rest of the app can keep reading from store.js as before.
 */
export async function pullFromCloud(userId) {
  const sb = await getClient();
  if (!sb || !userId) return;

  const [profileRes, progressRes, reviewsRes] = await Promise.all([
    sb.from('user_profiles').select('display_name,avatar_type,avatar_data,streak,last_study_date,furigana,exam_target_date').eq('user_id', userId).maybeSingle(),
    sb.from('learning_progress').select('lesson_id').eq('user_id', userId),
    sb.from('learning_reviews').select('review_key,lesson_id,category_id,prompt,correct_answer,options,correct_index,selected_answer,source,attempts,correct_attempts,lapses,interval_days,last_result,last_reviewed_at,due_at').eq('user_id', userId),
  ]);

  if (profileRes.data) {
    writeStreak({
      streak: profileRes.data.streak ?? 0,
      lastDate: profileRes.data.last_study_date ?? '',
    });
    const settingsPatch = {};
    if (typeof profileRes.data.furigana === 'boolean') settingsPatch.furigana = profileRes.data.furigana;
    if (typeof profileRes.data.exam_target_date === 'string') settingsPatch.examTargetDate = profileRes.data.exam_target_date;
    if (Object.keys(settingsPatch).length) setSettings(settingsPatch);
    // Mirror the server's name/avatar locally so a second device (or a
    // fresh browser profile) shows the same identity without re-asking.
    if (typeof profileRes.data.display_name === 'string' && profileRes.data.display_name) {
      saveProfile({
        name: profileRes.data.display_name,
        avatarType: profileRes.data.avatar_type,
        avatarData: profileRes.data.avatar_data,
      });
    }
  }
  if (progressRes.data) {
    const map = {};
    for (const row of progressRes.data) map[row.lesson_id] = true;
    writeProgressMapExternal(map);
  }
  if (!reviewsRes.error) {
    const remote = (reviewsRes.data || []).map(reviewFromRow);
    const merged = mergeReviewCollections(learningState.getReviews(), remote);
    learningState.replaceReviews(merged);
    const remoteByKey = new Map(remote.map((review) => [review.key, review.lastReviewedAt]));
    for (const review of merged) {
      if (remoteByKey.get(review.key) === review.lastReviewedAt) continue;
      try { await pushReviewRemote(review, userId); } catch { queueReviewMutation(review, userId); }
    }
  }
}

/**
 * If the server profile has no display name yet, seed it from the Google
 * OAuth profile (user_metadata.full_name / name) so a first-time Google
 * sign-in shows a real name on the leaderboard without a manual prompt.
 * Never overwrites an existing name — call before pullFromCloud so the
 * seeded value gets mirrored locally in the same pass.
 */
export async function maybeSeedProfileFromGoogle(user) {
  const sb = await getClient();
  if (!sb || !user?.id) return;

  const { data } = await sb.from('user_profiles').select('display_name').eq('user_id', user.id).maybeSingle();
  if (data && data.display_name) return;

  const meta = user.user_metadata || {};
  const googleName = (typeof meta.full_name === 'string' && meta.full_name.trim())
    || (typeof meta.name === 'string' && meta.name.trim())
    || '';
  if (!googleName) return;

  await pushProfile(user.id, { displayName: googleName });
}

/**
 * Push a single done-flag toggle to the server. Fire-and-forget.
 */
export async function pushProgressToggle(userId, lessonId, categoryId, isDone) {
  const sb = await getClient();
  if (!sb) return;
  if (isDone) {
    const { error } = await sb
      .from('learning_progress')
      .upsert({ user_id: userId, lesson_id: lessonId, category_id: categoryId });
    if (error) console.warn('[sync] pushProgressToggle failed:', error.message);
  } else {
    const { error } = await sb
      .from('learning_progress')
      .delete()
      .eq('user_id', userId)
      .eq('lesson_id', lessonId);
    if (error) console.warn('[sync] pushProgressToggle delete failed:', error.message);
  }
}

/**
 * Increment streak via the DB-side function. Returns the new {streak, lastDate}
 * or null on failure / no auth.
 */
export async function pushTouchStreak(userId) {
  const sb = await getClient();
  if (!sb) return null;
  const { data, error } = await sb.rpc('touch_user_streak', { p_user_id: userId });
  if (error || !Array.isArray(data) || !data[0]) return null;
  return { streak: data[0].streak, lastDate: data[0].last_date };
}

/**
 * Push the user's profile (display_name + avatar) to Supabase.
 * `user_id` is always derived from the authed session — never trusted
 * from the caller. The trigger + RLS WITH CHECK still guards writes.
 *
 * Uploaded photos are local-only by design (see js/profile.js's own promise
 * to the user that a chosen photo never leaves the device) — avatar_data is
 * only forwarded for the 'preset' type, which is just an emoji id, never the
 * image bytes. The leaderboard view nulls avatar_data for 'upload' rows too
 * as defense-in-depth.
 */
export async function pushProfile(userId, { displayName, avatarType, avatarData, examTargetDate }) {
  const sb = await getClient();
  if (!sb) return;
  if (typeof userId !== 'string' || !userId) return;
  const patch = {};
  if (typeof displayName === 'string') patch.display_name = displayName.slice(0, 40);
  if (avatarType === 'preset' || avatarType === 'upload') patch.avatar_type = avatarType;
  if (avatarType === 'preset' && typeof avatarData === 'string' && avatarData.length <= 64) {
    patch.avatar_data = avatarData;
  }
  if (examTargetDate === '' || (typeof examTargetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(examTargetDate))) {
    patch.exam_target_date = examTargetDate || null;
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await sb
    .from('user_profiles')
    .update(patch)
    .eq('user_id', userId);
  if (error) console.warn('[sync] pushProfile failed:', error.message);
}
