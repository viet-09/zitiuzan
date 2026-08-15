-- supabase/schema.sql
-- Multi-user schema for N2_web. Apply via:
--   psql "$SUPABASE_DB_URL" -f supabase/schema.sql
--   OR: paste into Supabase Dashboard → SQL Editor → Run.
--
-- Idempotent: every CREATE uses IF NOT EXISTS / CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. user_profiles — 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table if not exists public.user_profiles (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  display_name         text not null default '',
  avatar_type          text not null default 'preset' check (avatar_type in ('preset','upload')),
  avatar_data          text not null default 'neko',
  streak               integer not null default 0 check (streak >= 0),
  last_study_date      date,
  total_score          integer not null default 0 check (total_score >= 0),
  ai_level             text not null default 'N5' check (ai_level in ('N5','N4','N3','N2','N1')),
  ai_level_updated_at  timestamptz,
  tutor_memory         text not null default '',
  furigana             boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Auto-create empty profile row on signup so the rest of the code can
-- always upsert against an existing row.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. learning_progress — completed lessons per user
-- ---------------------------------------------------------------------------
create table if not exists public.learning_progress (
  user_id      uuid not null references auth.users(id) on delete cascade,
  lesson_id    text not null,
  category_id  text not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create index if not exists learning_progress_user_completed_idx
  on public.learning_progress (user_id, completed_at desc);

-- ---------------------------------------------------------------------------
-- 3. lesson_content_cache — per-lesson AI explanations (tap-kanji glosses)
-- ---------------------------------------------------------------------------
create table if not exists public.lesson_content_cache (
  user_id    uuid not null references auth.users(id) on delete cascade,
  lesson_id  text not null,
  payload    jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

-- ---------------------------------------------------------------------------
-- 4. tutor_messages — chat history with AI tutor
-- ---------------------------------------------------------------------------
create table if not exists public.tutor_messages (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('user','model')),
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists tutor_messages_user_created_idx
  on public.tutor_messages (user_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. voice_messages — voice conversation transcripts
-- ---------------------------------------------------------------------------
create table if not exists public.voice_messages (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  topic      text not null,
  role       text not null check (role in ('user','model')),
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists voice_messages_user_topic_created_idx
  on public.voice_messages (user_id, topic, created_at);

-- ---------------------------------------------------------------------------
-- 6. kanji_gloss_cache — tap-kanji explanation cache
-- ---------------------------------------------------------------------------
create table if not exists public.kanji_gloss_cache (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  payload    jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- 7. leaderboard view — public projection (no avatar blob, gated to authenticated)
-- ---------------------------------------------------------------------------
-- Drop with CASCADE because the view has dependent GRANTs / future policies.
drop view if exists public.leaderboard cascade;

create view public.leaderboard as
  select
    up.user_id,
    up.display_name,
    up.avatar_type,
    -- Uploaded photos are local-only by design (see js/profile.js) and are
    -- never synced to the server; null them here too as defense-in-depth so
    -- a future sync bug can never leak one through this broadly-readable view.
    case when up.avatar_type = 'upload' then null else up.avatar_data end as avatar_data,
    up.streak,
    up.total_score,
    up.ai_level,
    row_number() over (
      order by up.total_score desc, up.streak desc, up.created_at asc
    ) as rank
  from public.user_profiles up
  where up.total_score > 0 or up.streak > 0
  order by up.total_score desc, up.streak desc, up.created_at asc;

-- Leaderboard requires sign-in (anon traffic cannot pull user data).
grant select on public.leaderboard to authenticated;

-- ---------------------------------------------------------------------------
-- 8. touch_user_streak — atomic day-bump streak (Asia/Tokyo timezone).
-- Always operates on auth.uid(); the parameter is kept for backwards
-- compatibility but is silently overridden so a malicious caller cannot
-- touch another user's streak.
-- ---------------------------------------------------------------------------
create or replace function public.touch_user_streak(p_user_id uuid)
returns table(streak int, last_date date)
language plpgsql security definer set search_path = public as $$
declare
  v_target     uuid := coalesce(p_user_id, auth.uid());
  v_today      date := (now() at time zone 'Asia/Tokyo')::date;
  v_yesterday  date := v_today - 1;
  v_cur_streak int;
  v_cur_last   date;
begin
  -- Enforce that the target equals the caller. SECURITY DEFINER + RLS bypass
  -- would otherwise let an authed user mutate any row.
  if v_target <> auth.uid() then
    raise exception 'touch_user_streak: target must equal auth.uid()';
  end if;

  select up.streak, up.last_study_date
    into v_cur_streak, v_cur_last
    from public.user_profiles up
    where up.user_id = v_target
    for update;

  if v_cur_last is null then
    update public.user_profiles
      set streak = 1, last_study_date = v_today, updated_at = now()
      where user_id = v_target;
    return query select 1, v_today;
  elsif v_cur_last = v_today then
    return query select v_cur_streak, v_cur_last;
  elsif v_cur_last = v_yesterday then
    update public.user_profiles
      set streak = v_cur_streak + 1, last_study_date = v_today, updated_at = now()
      where user_id = v_target;
    return query select v_cur_streak + 1, v_today;
  else
    update public.user_profiles
      set streak = 1, last_study_date = v_today, updated_at = now()
      where user_id = v_target;
    return query select 1, v_today;
  end if;
end;
$$;

grant execute on function public.touch_user_streak(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. bump_score — atomic score increment, clamped.
-- Same auth.uid() enforcement as touch_user_streak.
-- ---------------------------------------------------------------------------
create or replace function public.bump_score(p_user_id uuid, p_delta int)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_target uuid := coalesce(p_user_id, auth.uid());
  v_new    int;
begin
  if v_target <> auth.uid() then
    raise exception 'bump_score: target must equal auth.uid()';
  end if;
  if p_delta is null or p_delta < -1000 or p_delta > 1000 then
    raise exception 'bump_score: delta out of range (-1000..1000)';
  end if;

  update public.user_profiles
    set total_score = greatest(total_score + p_delta, 0),
        updated_at = now()
    where user_id = v_target
    returning total_score into v_new;
  return v_new;
end;
$$;

grant execute on function public.bump_score(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.user_profiles        enable row level security;
alter table public.learning_progress    enable row level security;
alter table public.lesson_content_cache enable row level security;
alter table public.tutor_messages       enable row level security;
alter table public.voice_messages       enable row level security;
alter table public.kanji_gloss_cache    enable row level security;

-- user_profiles: only the row owner can read the raw row (including
-- avatar_data). Leaderboard view provides the public projection for everyone.
drop policy if exists "profile read self or public" on public.user_profiles;
drop policy if exists "profile read self" on public.user_profiles;
create policy "profile read self"
  on public.user_profiles for select using (auth.uid() = user_id);

drop policy if exists "profile write self" on public.user_profiles;
create policy "profile write self"
  on public.user_profiles for insert with check (auth.uid() = user_id);

drop policy if exists "profile update self" on public.user_profiles;
create policy "profile update self"
  on public.user_profiles for update using (auth.uid() = user_id);

-- learning_progress: read/write/delete self
drop policy if exists "progress read self"   on public.learning_progress;
drop policy if exists "progress insert self" on public.learning_progress;
drop policy if exists "progress delete self" on public.learning_progress;
create policy "progress read self"
  on public.learning_progress for select using (auth.uid() = user_id);
create policy "progress insert self"
  on public.learning_progress for insert with check (auth.uid() = user_id);
create policy "progress delete self"
  on public.learning_progress for delete using (auth.uid() = user_id);

-- Per-row RLS via FOR ALL on the smaller tables
drop policy if exists "cache self"   on public.lesson_content_cache;
drop policy if exists "tutor read"   on public.tutor_messages;
drop policy if exists "tutor write"  on public.tutor_messages;
drop policy if exists "tutor delete" on public.tutor_messages;
drop policy if exists "voice read"   on public.voice_messages;
drop policy if exists "voice write"  on public.voice_messages;
drop policy if exists "voice delete" on public.voice_messages;
drop policy if exists "gloss self"   on public.kanji_gloss_cache;

create policy "cache self"
  on public.lesson_content_cache for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "tutor read"
  on public.tutor_messages for select using (auth.uid() = user_id);
create policy "tutor write"
  on public.tutor_messages for insert with check (auth.uid() = user_id);
create policy "tutor delete"
  on public.tutor_messages for delete using (auth.uid() = user_id);

create policy "voice read"
  on public.voice_messages for select using (auth.uid() = user_id);
create policy "voice write"
  on public.voice_messages for insert with check (auth.uid() = user_id);
create policy "voice delete"
  on public.voice_messages for delete using (auth.uid() = user_id);

create policy "gloss self"
  on public.kanji_gloss_cache for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 11. exam_content — canonical mock-exam questions + answer key, server-side
-- only. No client SELECT policy at all: the answer key and reference notes
-- live in this row, so a direct client query would leak correct answers via
-- the Network tab before/during the test. The exam-fetch Edge Function is
-- the only reader — it strips answerIndex/referenceNote before responding.
-- Populated by scripts/load-exam.mjs (service role), not by client code.
-- ---------------------------------------------------------------------------
create table if not exists public.exam_content (
  jlpt_level  text not null,
  sitting     text not null,
  content     jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (jlpt_level, sitting)
);
alter table public.exam_content enable row level security;
-- Intentionally no policies — service-role (Edge Functions, load script)
-- bypasses RLS entirely; every other role is denied by default.

-- Private bucket for exam listening audio (owned source, never public/git —
-- see .gitignore). No storage.objects policy is created: the exam-fetch
-- Edge Function mints short-lived signed URLs with the service-role key,
-- which bypasses bucket privacy the same way it bypasses table RLS.
insert into storage.buckets (id, name, public)
values ('exam-audio', 'exam-audio', false)
on conflict (id) do nothing;

-- Private bucket for book listening-lesson CD audio (same rationale as
-- exam-audio above — owned CD-rip source under N2_somatome/, never
-- public/git). The lesson-audio-url Edge Function mints short-lived signed
-- URLs with the service-role key; see js/lesson-audio.js for the client side.
insert into storage.buckets (id, name, public)
values ('lesson-audio', 'lesson-audio', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 12. exam_attempts — mock JLPT exam history + AI review + retest quiz.
-- Insert-only from the server: the exam-review Edge Function computes the
-- score/review itself (against exam_content's answer key, never a
-- client-supplied score) and writes with the service-role key, bypassing
-- RLS. There is deliberately NO client-facing insert/update policy — a
-- client that could insert its own row could fabricate a perfect score.
-- ---------------------------------------------------------------------------
create table if not exists public.exam_attempts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  jlpt_level        text not null,
  source_file       text not null,
  score             jsonb not null,            -- {total, max, percentage}
  weakness_tags     text[] not null default '{}',
  detailed_review   jsonb not null,            -- [{question_id, user_answer, correct_answer, is_correct, explanation, remediation_rule}]
  retest_generated  boolean not null default false,
  retest_questions  jsonb,                      -- generated 3-5 question re-test quiz, null until generated
  created_at        timestamptz not null default now()
);
create index if not exists exam_attempts_user_created_idx
  on public.exam_attempts (user_id, created_at desc);

alter table public.exam_attempts enable row level security;

drop policy if exists "exam attempts read self" on public.exam_attempts;
create policy "exam attempts read self"
  on public.exam_attempts for select using (auth.uid() = user_id);