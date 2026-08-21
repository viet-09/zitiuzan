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
  -- Either a preset pet id, or the learner's own photo as a data URL. The
  -- photo is synced so every learner sees the same avatar on any device and
  -- on the leaderboard; js/profile.js crops it to 256px and re-encodes to
  -- WebP first, which lands around 10-30 KB.
  avatar_data          text not null default 'fox',
  streak               integer not null default 0 check (streak >= 0),
  last_study_date      date,
  tutor_memory         text not null default '',
  furigana             boolean not null default true,
  -- Real (not estimated) study time, credited by heartbeat_study_session()
  -- from server timestamps — see js/study-time.js.
  total_study_ms       bigint not null default 0 check (total_study_ms >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- A 256px WebP avatar is tens of KB; this only stops a hand-rolled client
-- from parking megabytes in a row every account reads.
alter table public.user_profiles drop constraint if exists user_profiles_avatar_data_len;
alter table public.user_profiles add constraint user_profiles_avatar_data_len
  check (char_length(avatar_data) <= 200000);

-- Retired columns. The app teaches a single JLPT level (N2), so a per-learner
-- level is noise; ai_level/ai_level_updated_at were only ever written by an
-- Edge Function no client called. study_session_count fed a per-session
-- average the leaderboard no longer shows, and total_score fed a points
-- display that never shipped — the board ranks on completed lessons.
alter table public.user_profiles
  drop column if exists ai_level,
  drop column if exists ai_level_updated_at,
  drop column if exists study_session_count,
  drop column if exists total_score;

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

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. curriculum registry + learning_progress
-- ---------------------------------------------------------------------------
create table if not exists public.curriculum_lessons (
  lesson_id   text primary key,
  category_id text not null check (category_id in ('kanji','vocabulary','grammar','reading','listening'))
);

alter table public.user_profiles
  add column if not exists exam_target_date date;

insert into public.curriculum_lessons (lesson_id, category_id)
select prefix || week_no || 'd' || day_no, category_id
from (values
  ('k', 'kanji', 8, 7),
  ('v', 'vocabulary', 8, 7),
  ('g', 'grammar', 8, 7),
  ('r', 'reading', 6, 7)
) as regular(prefix, category_id, max_week, max_day)
cross join lateral generate_series(1, max_week) as week_no
cross join lateral generate_series(1, max_day) as day_no
union all
select 'l' || week_no || 'd' || day_no, 'listening'
from (values (1,5), (2,7), (3,5), (4,5), (5,1)) as listening(week_no, max_day)
cross join lateral generate_series(1, max_day) as day_no
on conflict (lesson_id) do update set category_id = excluded.category_id;

alter table public.curriculum_lessons enable row level security;
drop policy if exists "curriculum read" on public.curriculum_lessons;
create policy "curriculum read" on public.curriculum_lessons
  for select to anon, authenticated using (true);
grant select on public.curriculum_lessons to anon, authenticated;

create table if not exists public.learning_progress (
  user_id      uuid not null references auth.users(id) on delete cascade,
  lesson_id    text not null,
  category_id  text not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create index if not exists learning_progress_user_completed_idx
  on public.learning_progress (user_id, completed_at desc);

-- Normalize legacy rows before adding the curriculum foreign key. Invalid
-- lesson ids were never reachable in the UI and are removed so they cannot
-- inflate leaderboard completion.
update public.learning_progress as progress
set category_id = curriculum.category_id
from public.curriculum_lessons as curriculum
where progress.lesson_id = curriculum.lesson_id
  and progress.category_id is distinct from curriculum.category_id;

delete from public.learning_progress as progress
where not exists (
  select 1 from public.curriculum_lessons as curriculum
  where curriculum.lesson_id = progress.lesson_id
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'learning_progress_curriculum_fk') then
    alter table public.learning_progress
      add constraint learning_progress_curriculum_fk
      foreign key (lesson_id) references public.curriculum_lessons(lesson_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2b. learning_reviews — account-owned spaced repetition and mistake log
-- ---------------------------------------------------------------------------
create table if not exists public.learning_reviews (
  user_id             uuid not null references auth.users(id) on delete cascade,
  review_key          text not null check (char_length(review_key) between 1 and 240),
  lesson_id           text not null references public.curriculum_lessons(lesson_id),
  category_id         text not null check (category_id in ('kanji','vocabulary','grammar','reading','listening')),
  prompt              text not null default '' check (char_length(prompt) <= 4000),
  correct_answer      text not null default '' check (char_length(correct_answer) <= 1000),
  options             jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  correct_index       integer not null default -1 check (correct_index between -1 and 7),
  selected_answer     text not null default '' check (char_length(selected_answer) <= 1000),
  source              text not null default 'lesson' check (char_length(source) <= 32),
  attempts            integer not null default 0 check (attempts >= 0),
  correct_attempts    integer not null default 0 check (correct_attempts between 0 and attempts),
  lapses              integer not null default 0 check (lapses between 0 and attempts),
  interval_days       integer not null default 0 check (interval_days between 0 and 60),
  last_result         text not null check (last_result in ('correct','wrong')),
  last_reviewed_at    timestamptz not null,
  due_at              timestamptz not null,
  updated_at          timestamptz not null default now(),
  primary key (user_id, review_key)
);
create index if not exists learning_reviews_user_due_idx
  on public.learning_reviews (user_id, due_at);

create or replace function public.keep_newest_learning_review() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.last_reviewed_at < old.last_reviewed_at then return old; end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists learning_reviews_keep_newest on public.learning_reviews;
create trigger learning_reviews_keep_newest
  before update on public.learning_reviews
  for each row execute function public.keep_newest_learning_review();
revoke all on function public.keep_newest_learning_review() from public, anon, authenticated;

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
-- 7. record_study_time — legacy client-timed study duration. Superseded by
-- the server-timed session heartbeat below and revoked from every browser
-- role; it exists only because supabase/rollback/ re-grants it to restore the
-- previous client. Always operates on auth.uid(), never a client-supplied
-- user_id, so even then a caller can only inflate their own stats.
-- ---------------------------------------------------------------------------
create or replace function public.record_study_time(p_duration_ms integer, p_new_session boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Defensive bounds: ignore non-positive values and anything above a
  -- generous single-flush cap (a real flush interval is well under this;
  -- a much larger value can only be a bad client, not real study time).
  if p_duration_ms is null or p_duration_ms <= 0 or p_duration_ms > 3 * 60 * 60 * 1000 then
    return;
  end if;
  update public.user_profiles
  set total_study_ms = total_study_ms + p_duration_ms,
      updated_at = now()
  where user_id = auth.uid();
end;
$$;

grant execute on function public.record_study_time(integer, boolean) to authenticated;

-- Replace caller-supplied durations with server-timed, single-active-session
-- heartbeats. The legacy function remains for rollback compatibility but is
-- no longer executable by browser roles.
revoke execute on function public.record_study_time(integer, boolean) from public, anon, authenticated;

create table if not exists public.study_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  lesson_id      text not null references public.curriculum_lessons(lesson_id),
  started_at     timestamptz not null default now(),
  last_heartbeat timestamptz not null default now(),
  credited_ms    bigint not null default 0 check (credited_ms >= 0),
  closed_at      timestamptz
);
create index if not exists study_sessions_user_open_idx
  on public.study_sessions (user_id, last_heartbeat desc) where closed_at is null;
alter table public.study_sessions enable row level security;
drop policy if exists "study sessions read self" on public.study_sessions;
create policy "study sessions read self" on public.study_sessions
  for select to authenticated using (auth.uid() = user_id);

create or replace function public.start_study_session(p_lesson_id text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.curriculum_lessons where lesson_id = p_lesson_id) then
    raise exception 'Unknown lesson id';
  end if;
  update public.study_sessions set closed_at = now()
    where user_id = v_user and closed_at is null;
  insert into public.study_sessions (user_id, lesson_id)
    values (v_user, p_lesson_id) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.heartbeat_study_session(p_session_id uuid, p_close boolean default false)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_last timestamptz;
  v_delta bigint;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select last_heartbeat into v_last
    from public.study_sessions
    where id = p_session_id and user_id = v_user and closed_at is null
    for update;
  if not found then return 0; end if;

  v_delta := greatest(0, least(60000, floor(extract(epoch from (v_now - v_last)) * 1000)::bigint));
  update public.study_sessions
    set last_heartbeat = v_now,
        credited_ms = credited_ms + v_delta,
        closed_at = case when p_close then v_now else null end
    where id = p_session_id;

  if v_delta >= 1000 then
    update public.user_profiles
      set total_study_ms = total_study_ms + v_delta,
          updated_at = now()
      where user_id = v_user;
  end if;
  return case when v_delta >= 1000 then v_delta else 0 end;
end;
$$;

revoke all on function public.start_study_session(text) from public, anon;
revoke all on function public.heartbeat_study_session(uuid, boolean) from public, anon;
grant execute on function public.start_study_session(text) to authenticated;
grant execute on function public.heartbeat_study_session(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. leaderboard RPC — sanitized projection, gated to authenticated
-- ---------------------------------------------------------------------------
-- Defined after study_sessions because the projection reads today's credited
-- session time. A SECURITY DEFINER view bypasses RLS implicitly; this explicit,
-- narrow RPC exposes only the safe aggregate fields below.
--
-- There is deliberately no JLPT level here: the whole app is one N2 course, so
-- ranking learners by level said nothing that completion percent does not.
drop view if exists public.leaderboard cascade;
drop function if exists public.get_leaderboard(integer);
create or replace function public.get_leaderboard(p_limit integer default 50)
returns table (
  rank bigint,
  user_id uuid,
  display_name text,
  avatar_type text,
  avatar_data text,
  streak integer,
  completed_count bigint,
  completion_percent integer,
  total_study_ms bigint,
  today_study_ms bigint
)
language sql stable security definer set search_path = public as $$
  select ranked.rank, ranked.user_id, ranked.display_name, ranked.avatar_type,
    ranked.avatar_data, ranked.streak, ranked.completed_count,
    ranked.completion_percent, ranked.total_study_ms, ranked.today_study_ms
  from (
    select
      row_number() over (order by coalesce(lp.completed_count, 0) desc, up.streak desc, up.created_at asc) as rank,
      up.user_id,
      up.display_name,
      up.avatar_type,
      -- Avatars are shared on purpose: the board shows every learner the same
      -- picture their account shows. Photos used to be nulled out here because
      -- they never left the device that chose them.
      up.avatar_data,
      up.streak,
      coalesce(lp.completed_count, 0) as completed_count,
      least(100, round(
        coalesce(lp.completed_count, 0) * 100.0
        / nullif((select count(*) from public.curriculum_lessons), 0)
      ))::int as completion_percent,
      up.total_study_ms,
      coalesce(ts.today_ms, 0)::bigint as today_study_ms
    from public.user_profiles up
    left join (
      select progress.user_id, count(distinct progress.lesson_id) as completed_count
      from public.learning_progress as progress
      group by progress.user_id
    ) lp on lp.user_id = up.user_id
    -- "Today" follows the same Asia/Tokyo day boundary as the streak, so both
    -- stats roll over together. A session opened before midnight counts
    -- against the day it started, which is where the learner watched it tick.
    left join (
      select sessions.user_id, sum(sessions.credited_ms) as today_ms
      from public.study_sessions as sessions
      where (sessions.started_at at time zone 'Asia/Tokyo')::date
            = (now() at time zone 'Asia/Tokyo')::date
      group by sessions.user_id
    ) ts on ts.user_id = up.user_id
    where auth.uid() is not null
      and (coalesce(lp.completed_count, 0) > 0 or up.streak > 0)
  ) as ranked
  order by ranked.rank
  limit least(100, greatest(1, coalesce(p_limit, 50)));
$$;

revoke all on function public.get_leaderboard(integer) from public, anon;
grant execute on function public.get_leaderboard(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. touch_user_streak — atomic day-bump streak (Asia/Tokyo timezone).
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

revoke all on function public.touch_user_streak(uuid) from public, anon;
grant execute on function public.touch_user_streak(uuid) to authenticated;

-- Atomic, idempotent completion mutation. Direct progress writes are revoked
-- below so streak and progress cannot diverge and unknown lesson ids cannot
-- be used to game the leaderboard.
create or replace function public.set_lesson_completion(
  p_lesson_id text,
  p_category_id text,
  p_done boolean
)
returns table(done boolean, streak integer, last_date date)
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_changed text;
  v_streak integer;
  v_last date;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.curriculum_lessons
    where lesson_id = p_lesson_id and category_id = p_category_id
  ) then
    raise exception 'Lesson/category is not in the N2 curriculum';
  end if;

  if p_done then
    insert into public.learning_progress (user_id, lesson_id, category_id)
      values (v_user, p_lesson_id, p_category_id)
      on conflict (user_id, lesson_id) do nothing
      returning lesson_id into v_changed;
    if v_changed is not null then
      select touched.streak, touched.last_date into v_streak, v_last
        from public.touch_user_streak(v_user) as touched;
    end if;
  else
    delete from public.learning_progress
      where user_id = v_user and lesson_id = p_lesson_id
      returning lesson_id into v_changed;
  end if;

  select profile.streak, profile.last_study_date into v_streak, v_last
    from public.user_profiles as profile where profile.user_id = v_user;
  return query select p_done, coalesce(v_streak, 0), v_last;
end;
$$;

revoke all on function public.set_lesson_completion(text, text, boolean) from public, anon;
grant execute on function public.set_lesson_completion(text, text, boolean) to authenticated;

-- The points system it served was never surfaced anywhere in the client, so
-- the score column and this RPC are gone; ranking uses completed lessons.
drop function if exists public.bump_score(uuid, int);

-- ---------------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.user_profiles        enable row level security;
alter table public.learning_progress    enable row level security;
alter table public.learning_reviews enable row level security;
alter table public.lesson_content_cache enable row level security;
alter table public.tutor_messages       enable row level security;
alter table public.voice_messages       enable row level security;
alter table public.kanji_gloss_cache    enable row level security;

-- user_profiles: only the row owner can read the raw row. get_leaderboard is
-- the public projection, and it is what shares display_name and avatar_data
-- with other learners — nothing else in the row is exposed.
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

revoke insert, update, delete on public.learning_progress from anon, authenticated;
grant select on public.learning_progress to authenticated;

drop policy if exists "reviews read self" on public.learning_reviews;
drop policy if exists "reviews insert self" on public.learning_reviews;
drop policy if exists "reviews update self" on public.learning_reviews;
drop policy if exists "reviews delete self" on public.learning_reviews;
create policy "reviews read self"
  on public.learning_reviews for select using (auth.uid() = user_id);
create policy "reviews insert self"
  on public.learning_reviews for insert with check (auth.uid() = user_id);
create policy "reviews update self"
  on public.learning_reviews for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "reviews delete self"
  on public.learning_reviews for delete using (auth.uid() = user_id);
revoke all on public.learning_reviews from anon;
grant select, insert, update, delete on public.learning_reviews to authenticated;

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
