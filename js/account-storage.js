// Account-safe local storage lifecycle helpers.
// The legacy migration marker is global to this browser: legacy data belongs
// to the first account that claims it and must never be replayed into a second
// account on the same device.

export const LEGACY_MIGRATION_MARKER = 'n2_migrated_v1';

export const USER_SCOPED_STORAGE_KEYS = Object.freeze([
  'n2_progress_v2',
  'n2_streak_v2',
  'n2_tutor_v2',
  'n2_tutor_context_v2',
  'n2_tutor_memory_v2',
  'n2_voice_transcript_v2',
  'n2_kanji_gloss_v2',
  'n2_profile_v2',
  'n2_profile_prompt_seen_v2',
  'n2_completion_queue_v1',
  'n2_reviews_v1',
  'n2_bookmarks_v1',
  'n2_exam_history_cache_v1',
]);

export function shouldRunLegacyMigration(markerValue) {
  return markerValue == null || markerValue === '';
}

export function clearUserScopedStorage(storage = globalThis.localStorage) {
  if (!storage) return;
  for (const key of USER_SCOPED_STORAGE_KEYS) {
    try { storage.removeItem(key); } catch { /* storage may be blocked */ }
  }
}

function readJSON(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Migrate every present legacy entry as a single logical operation. Local
 * values are removed only after all remote writes succeed.
 */
export async function migrateLegacyStorage({ storage, userId, definitions, upsert }) {
  if (!storage || !userId || !definitions || typeof upsert !== 'function') {
    return { migrated: false, skipped: true };
  }
  if (!shouldRunLegacyMigration(storage.getItem(LEGACY_MIGRATION_MARKER))) {
    return { migrated: false, skipped: true };
  }

  const migratedKeys = [];
  for (const [key, definition] of Object.entries(definitions)) {
    const raw = readJSON(storage, key);
    if (raw == null) continue;
    const rows = definition.map(raw, userId);
    if (!rows || (Array.isArray(rows) && rows.length === 0)) continue;
    const result = await upsert(definition.table, rows);
    if (result?.error) {
      const error = result.error instanceof Error
        ? result.error
        : new Error(result.error.message || String(result.error));
      throw error;
    }
    migratedKeys.push(key);
  }

  for (const key of migratedKeys) storage.removeItem(key);
  storage.setItem(LEGACY_MIGRATION_MARKER, '1');
  return { migrated: migratedKeys.length > 0, skipped: false };
}
