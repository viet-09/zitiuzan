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
  assert.match(sql, /revoke all on function public\.bump_score\(uuid, int\) from public, anon, authenticated/i);
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
