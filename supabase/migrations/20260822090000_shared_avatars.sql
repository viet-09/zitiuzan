-- Avatars follow the account instead of the device.
--
-- A chosen photo used to stay in localStorage: the profile dialog promised it
-- would never be uploaded, pushProfile forwarded only preset ids, and the
-- leaderboard projection nulled avatar_data for 'upload' rows. The result was
-- that every learner saw a default pet for anyone with a real picture — their
-- own row included, and a second device showed a pet too.
--
-- js/profile.js crops to 256px and re-encodes to WebP before storing, so a row
-- carries tens of KB; the CHECK below is what keeps a hand-rolled client from
-- parking megabytes in a row that every account reads through get_leaderboard.

-- A 256px WebP avatar is tens of KB; this only stops a hand-rolled client
-- from parking megabytes in a row every account reads.
alter table public.user_profiles drop constraint if exists user_profiles_avatar_data_len;
alter table public.user_profiles add constraint user_profiles_avatar_data_len
  check (char_length(avatar_data) <= 200000);

-- get_leaderboard now passes avatar_data through for uploads as well.
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
