-- Leaderboard cleanup: drop the JLPT level, the unused score, report today.
--
-- Four write-only columns go with this release:
--   ai_level / ai_level_updated_at — the app teaches one level (N2), and the
--     only writer was the evaluate-ai Edge Function, which no client path ever
--     called, so every learner sat on the column's 'N5' default. That function
--     is deleted in this release too.
--   study_session_count — existed solely to divide total_study_ms into a
--     per-session average the board no longer shows.
--   total_score — a points display that never shipped; ranking uses completed
--     lessons. bump_score, its only dedicated RPC, had no callers.
--
-- The board now reports time studied today instead of the per-session average.
-- Every function below is recreated because it referenced a dropped column.

drop function if exists public.bump_score(uuid, int);

alter table public.user_profiles
  drop column if exists ai_level,
  drop column if exists ai_level_updated_at,
  drop column if exists study_session_count,
  drop column if exists total_score;

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
      case when up.avatar_type = 'upload' then null else up.avatar_data end as avatar_data,
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
