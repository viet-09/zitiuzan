import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_SCOPED_STORAGE_KEYS } from '../js/account-storage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Google OAuth requests prompt=select_account so the learner can switch accounts', () => {
  const supabaseSource = read('js/supabase.js');
  assert.match(
    supabaseSource,
    /prompt:\s*'select_account'/,
    'signInWithGoogle must request prompt=select_account so Google shows the account chooser on logout/relogin'
  );
});

test('app bootstrap flushes completion and review queues before pulling from cloud', () => {
  const appSource = read('js/app.js');
  const flushCompletionIdx = appSource.indexOf('flushCompletionQueue');
  const flushReviewIdx = appSource.indexOf('flushReviewQueue');
  const pullCloudIdx = appSource.indexOf('pullFromCloud');

  assert.ok(flushCompletionIdx > 0, 'flushCompletionQueue must be called in app bootstrap');
  assert.ok(flushReviewIdx > 0, 'flushReviewQueue must be called in app bootstrap');
  assert.ok(pullCloudIdx > 0, 'pullFromCloud must be called in app bootstrap');

  assert.ok(
    flushCompletionIdx < pullCloudIdx,
    'flushCompletionQueue must run before pullFromCloud to preserve offline progress'
  );
  assert.ok(
    flushReviewIdx < pullCloudIdx,
    'flushReviewQueue must run before pullFromCloud to preserve offline reviews'
  );
});

test('profile sign-out attempts to flush offline queues before destroying session', () => {
  const profilePageSource = read('js/profile-page.js');
  const signoutBlock = profilePageSource.slice(
    profilePageSource.indexOf('[data-action="sign-out"]')
  );

  assert.match(
    signoutBlock,
    /flushCompletionQueue/,
    'sign-out must flush pending completions before clearing local storage'
  );
  assert.match(
    signoutBlock,
    /flushReviewQueue/,
    'sign-out must flush pending reviews before clearing local storage'
  );
  assert.match(
    signoutBlock,
    /signOut\(\)/,
    'sign-out must still call supabase signOut()'
  );
});

test('pullFromCloud merges remote progress into local map rather than replacing it', () => {
  const syncSource = read('js/sync.js');
  assert.match(
    syncSource,
    /const map = getProgressMap\(\);/,
    'pullFromCloud must start from getProgressMap() so offline-completed lessons are preserved'
  );
});

test('pullFromCloud unions remote progress and never deletes a local completion', () => {
  const syncSource = read('js/sync.js');
  assert.match(
    syncSource,
    /const map = getProgressMap\(\);/,
    'pullFromCloud must start from getProgressMap() so offline-completed lessons are preserved'
  );
  // A proactive "pending un-check" filter used to delete local progress, which
  // could destroy a completion made on another device (the server row for an
  // un-checked lesson is deleted, so the filter had no way to tell a failed
  // un-check from a slow multi-device progression). The union must only add.
  const pull = syncSource.slice(
    syncSource.indexOf('export async function pullFromCloud'),
    syncSource.indexOf('\n}', syncSource.indexOf('export async function pullFromCloud')) + 2
  );
  assert.doesNotMatch(pull, /delete map\[/, 'pullFromCloud must not delete local progress entries');
  assert.doesNotMatch(pull, /pendingUndone/, 'pullFromCloud must not filter remote rows by a pending un-check set');
});

test('the exam resume snapshot is scoped to the account that created it', () => {
  const sessionSource = read('js/exam-session.js');
  assert.match(
    sessionSource,
    /export function setExamSessionOwner\(userId\)/,
    'exam-session must expose the signed-in owner so a snapshot cannot leak across accounts'
  );
  assert.match(
    sessionSource,
    /if \(!userId \|\| parsed\.userId !== userId\) return null;/,
    'readExamSession must discard a snapshot that names no owner, or another account'
  );
  // A snapshot written while signed out has no owner stamp, and would then be
  // offered to whoever signs in next. It must not be written at all.
  assert.match(
    sessionSource,
    /if \(!String\(state\.userId \?\? ownerId\)\) return null;/,
    'toSessionSnapshot must refuse to stamp a snapshot with no owner'
  );

  const appSource = read('js/app.js');
  assert.match(appSource, /setExamSessionOwner\(authedUser\.id\)/);
  assert.match(appSource, /setExamSessionOwner\(''\)/);
});

test('a session that ends without a sign-out clears the previous account data', () => {
  // An expired token fires onAuthChange(null). Without a wipe, the next person
  // to sign in on this device reads the previous learner's AI history and
  // voice transcripts, and pullFromCloud pushes the previous learner's local
  // reviews into the new account.
  const appSource = read('js/app.js');
  const authBlock = appSource.slice(appSource.indexOf('onAuthChange(async (authedUser)'));

  assert.match(
    authBlock.slice(0, 900),
    /clearUserScopedStorage\(\);[\s\S]{0,200}syncedUserId = null;/,
    'a signed-out event must wipe the previous account data before the sign-in gate opens'
  );
  assert.match(
    authBlock,
    /if \(syncedUserId && syncedUserId !== authedUser\.id\) \{\s*clearUserScopedStorage\(\);/,
    'switching to a different account must wipe the previous account data'
  );
  assert.match(appSource, /import \{ clearUserScopedStorage \} from '\.\/account-storage\.js';/);
});

test('the account wipe covers every user-scoped storage key', () => {
  // These carry private study data and must never follow a learner to the
  // next account on a shared device.
  for (const key of [
    'n2_progress_v2',
    'n2_streak_v2',
    'n2_tutor_v2',
    'n2_tutor_context_v2',
    'n2_tutor_memory_v2',
    'n2_voice_transcript_v2',
    'n2_kanji_gloss_v2',
    'n2_profile_v2',
    'n2_reviews_v1',
    'n2_bookmarks_v1',
    'n2_completion_queue_v1',
    'n2_review_sync_queue_v1',
    'n2_exam_history_cache_v1',
    'n2_pet_memories_v1',
    'n2_kanji_sheet_v1',
  ]) {
    assert.ok(USER_SCOPED_STORAGE_KEYS.includes(key), `${key} must be wiped on account switch`);
  }
});

test('sign-out clears the exam resume snapshot so it is not offered to the next account', () => {
  const profilePageSource = read('js/profile-page.js');
  const signoutBlock = profilePageSource.slice(
    profilePageSource.indexOf('[data-action="sign-out"]')
  );
  assert.match(
    signoutBlock,
    /clearExamSession\(\)/,
    'sign-out must clear the sessionStorage exam snapshot'
  );
});

test('user_profiles schema restricts UPDATE to user-editable columns and guards streak/time via trigger', () => {
  const schemaSource = read('supabase/schema.sql');
  assert.match(
    schemaSource,
    /revoke update on public\.user_profiles from authenticated;/,
    'schema must revoke broad UPDATE on user_profiles from authenticated'
  );
  assert.match(
    schemaSource,
    /grant update \(display_name, avatar_type, avatar_data, furigana, exam_target_date, tutor_memory\)/,
    'schema must grant UPDATE only on user-editable columns'
  );
  assert.match(
    schemaSource,
    /create trigger user_profiles_guard_server_columns/,
    'schema must install guard_profile_server_columns trigger to protect streak and study time'
  );
});

test('the profile guard checks current_user and is not SECURITY DEFINER', () => {
  // The guard must run as the *invoking* role, so it can tell a browser write
  // apart from a server-side RPC write:
  //   * browser UPDATE  -> current_user is 'authenticated' -> guard restores
  //     the server-owned counters.
  //   * SECURITY DEFINER RPC (touch_user_streak, heartbeat_study_session)
  //     -> current_user is the function owner ('postgres') -> guard lets it
  //     through.
  // That split only works if the trigger function itself is NOT SECURITY
  // DEFINER: inside a SECURITY DEFINER function Postgres rewrites
  // current_user to the owner, so the guard would never fire. session_user
  // is wrong in the other direction — it keeps the original login role
  // ('authenticated') even for the RPCs, which would block the legitimate
  // server writes.
  for (const file of ['supabase/schema.sql', 'supabase/migrations/20261021100000_profile_column_guards.sql']) {
    const source = read(file);
    // Only the trigger function itself — a later SECURITY DEFINER RPC in the
    // same file is unrelated to the guard.
    const start = source.indexOf('guard_profile_server_columns()');
    const guard = source.slice(start, source.indexOf('$$;', start) + 3);
    assert.match(guard, /current_user in \('authenticated', 'anon'\)/,
      `${file} must gate the profile guard on current_user`);
    assert.doesNotMatch(guard, /session_user in \('authenticated', 'anon'\)/,
      `${file} must not gate the profile guard on session_user`);
    assert.doesNotMatch(guard, /security definer/,
      `${file} must not make the profile guard SECURITY DEFINER`);
  }
});

test('streak date calculation uses Asia/Tokyo time zone to match database day boundary', () => {
  const storeSource = read('js/store.js');
  assert.match(
    storeSource,
    /Asia\/Tokyo/,
    'store.js must use Asia/Tokyo time zone so learners outside Japan do not have streaks reset at 22:00 local'
  );
});
