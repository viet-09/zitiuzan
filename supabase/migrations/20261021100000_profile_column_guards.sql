-- supabase/migrations/20261021100000_profile_column_guards.sql
--
-- The RLS policy "profile update self" allows any authenticated client to
-- UPDATE its own user_profiles row. That is correct for editable columns
-- (display name, avatar, furigana, exam target date, tutor memory) but it also
-- left the server-owned counters writable from the browser:
--
--   * streak / last_study_date  — supposed to be advanced only by
--     touch_user_streak() / set_lesson_completion()
--   * total_study_ms            — supposed to be credited only by
--     heartbeat_study_session() from server timestamps
--
-- A crafted client could issue
--   update user_profiles set streak = 9999, total_study_ms = 1e12
-- and the leaderboard (which ranks on completed lessons, then streak) would
-- take it at face value. Revoking UPDATE on the whole table would break the
-- editable columns, so this narrows the grant to the columns a learner is
-- actually meant to change.

-- Column-level UPDATE grants. Only these columns may be written by a browser
-- session; every other column keeps the table-level revoke below.
grant update (display_name, avatar_type, avatar_data, furigana, exam_target_date, tutor_memory)
  on public.user_profiles to authenticated;

-- Remove the broad table-level UPDATE that Supabase grants by default.
-- Column grants above survive this because they are separate privileges.
revoke update on public.user_profiles from authenticated;
grant update (display_name, avatar_type, avatar_data, furigana, exam_target_date, tutor_memory)
  on public.user_profiles to authenticated;

-- Defense in depth: even a future broad grant cannot move a server-owned
-- counter from a browser session, because the trigger restores the old value.
--
-- The role check uses current_user, and the function is deliberately NOT
-- SECURITY DEFINER. That combination is what makes the two paths differ:
--
--   * A browser session issuing a direct UPDATE runs the statement as
--     'authenticated', so current_user reads 'authenticated' and the guard
--     restores the counters.
--   * The SECURITY DEFINER RPCs (touch_user_streak, heartbeat_study_session)
--     run their UPDATE as the function owner, so current_user reads
--     'postgres' inside the trigger and the guard lets it through.
--
-- The two alternatives both break: SECURITY DEFINER + current_user would
-- always read the owner ('postgres') and the guard would never fire, while
-- SECURITY DEFINER + session_user would always read the original login role
-- ('authenticated') and would also block the legitimate RPC writes.
create or replace function public.guard_profile_server_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.streak := old.streak;
    new.last_study_date := old.last_study_date;
    new.total_study_ms := old.total_study_ms;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists user_profiles_guard_server_columns on public.user_profiles;
create trigger user_profiles_guard_server_columns
  before update on public.user_profiles
  for each row execute function public.guard_profile_server_columns();

revoke all on function public.guard_profile_server_columns() from public, anon, authenticated;
