import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('database exposes idempotent completion RPC instead of direct leaderboard writes', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.curriculum_lessons/i);
  assert.match(sql, /create or replace function public\.set_lesson_completion/i);
  assert.match(sql, /revoke\s+(?:all|insert[\s\S]*delete)[\s\S]*learning_progress[\s\S]*authenticated/i);
  assert.match(sql, /least\(100[\s\S]*completion_percent/i);
  assert.match(sql, /function public\.get_leaderboard/i);
  assert.doesNotMatch(sql, /create view public\.leaderboard/i);
  assert.match(sql, /drop function if exists public\.bump_score\(uuid, int\);/i);
});

test('study time is credited from server-timed sessions, not arbitrary client durations', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.study_sessions/i);
  assert.match(sql, /create or replace function public\.start_study_session/i);
  assert.match(sql, /create or replace function public\.heartbeat_study_session/i);
  assert.match(sql, /revoke execute on function public\.record_study_time/i);
});

test('spaced repetition sync is owner-scoped and profile stores the target exam date', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists exam_target_date date/i);
  assert.match(sql, /create table if not exists public\.learning_reviews/i);
  assert.match(sql, /primary key \(user_id, review_key\)/i);
  assert.match(sql, /alter table public\.learning_reviews enable row level security/i);
  assert.match(sql, /learning_reviews[\s\S]*auth\.uid\(\) = user_id/i);
});

test('the leaderboard drops the JLPT level and reports time studied today', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

  // One N2 course means one level, and the stored column was write-only: its
  // sole writer was an Edge Function no client path called.
  for (const column of ['ai_level', 'ai_level_updated_at', 'study_session_count', 'total_score']) {
    assert.match(sql, new RegExp(`drop column if exists ${column}[,;]`, 'i'));
  }
  assert.doesNotMatch(sql, /^\s*ai_level\s+text not null/im);
  assert.doesNotMatch(sql, /^\s*total_score\s+integer not null/im);
  assert.doesNotMatch(sql, /get_leaderboard[\s\S]*?level text/i);
  // The completion RPC used to move a score nothing displayed.
  assert.doesNotMatch(sql, /set_lesson_completion[\s\S]*?total_score/i);

  // Today's minutes roll over on the same Asia/Tokyo boundary as the streak.
  assert.match(sql, /today_study_ms bigint/i);
  assert.doesNotMatch(sql, /avg_study_ms|study_session_count integer/i);
  assert.match(sql, /sum\(sessions\.credited_ms\) as today_ms[\s\S]*?at time zone 'Asia\/Tokyo'/i);

  // A `create or replace` cannot change a function's result columns.
  assert.match(sql, /drop function if exists public\.get_leaderboard\(integer\);/i);
  // study_sessions has to exist before a SQL function may reference it.
  assert.ok(
    sql.indexOf('create table if not exists public.study_sessions')
      < sql.indexOf('create or replace function public.get_leaderboard'),
    'get_leaderboard must be defined after the tables it reads'
  );
});

test('the retired AI level evaluator is gone from the repo and the deploy list', async () => {
  const deploy = await readFile(new URL('../scripts/link-and-deploy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(deploy, /evaluate-ai/);
  await assert.rejects(readFile(new URL('../supabase/functions/evaluate-ai/index.ts', import.meta.url)));
});

test('the retired WebGL pet renderer leaves no build, asset or dependency behind', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const vendorBuild = await readFile(new URL('../scripts/build-vendor.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../css/styles.css', import.meta.url), 'utf8');

  // The companion renders as a pixel sprite; nothing ever mounted the scene.
  assert.equal(pkg.dependencies.three, undefined);
  assert.equal(pkg.scripts['build:models'], undefined);
  assert.doesNotMatch(vendorBuild, /pet-scene/);
  assert.doesNotMatch(css, /pet-webgl|is-three-ready/);
  for (const gone of [
    '../js/pet-scene.js', '../vendor/pet-scene.js',
    '../scripts/generate-pet-models.mjs',
    '../assets/pets/fox-mascot.glb', '../assets/pets/fox-3d.png',
    '../assets/pets/fox-sprites.png',
  ]) {
    await assert.rejects(readFile(new URL(gone, import.meta.url)), `${gone} must be gone`);
  }
});
