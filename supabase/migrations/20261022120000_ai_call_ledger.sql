-- Supabase migration: ai_call_ledger
-- Purpose: a durable per-user call ledger so the AI Edge Functions can enforce a
-- rate limit that survives a cold start and holds across isolates. The previous
-- limiters were in-memory Maps: each edge instance had its own, and an instance
-- restarts whenever the platform decides to, so a motivated account could spend
-- far more of the shared Gemini quota than one user should be able to.
--
-- One row per (user, day). The security is not in the counting but in the write
-- policy: the app only has insert/update of its own row for today, while the
-- reset action is exercised through a SECURITY DEFINER function that forbids
-- back-dating via a trigger guard (the function itself sets day explicitly, so
-- the trigger must not trip on it — CURRENT_USER inside the trigger of a
-- non-SECURITY-DEFINER function invoked by an SECURITY DEFINER function is the
-- invoker, i.e. the authenticated user, which is exactly the escape hatch).
--
-- Written: 2026-10-22. Tested by tests/schema-security.test.mjs.

create table if not exists public.ai_call_ledger (
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  call_count  integer not null default 0 check (call_count >= 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.ai_call_ledger enable row level security;

-- The ledger is server bookkeeping. A learner may read their own row to explain
-- why a call was refused, but never write one directly: every increment goes
-- through consume_ai_calls() below, which enforces the ceiling.
drop policy if exists "ai ledger self read" on public.ai_call_ledger;
create policy "ai ledger self read"
  on public.ai_call_ledger for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.ai_call_ledger from anon, authenticated;
grant select on public.ai_call_ledger to authenticated;

-- One call at a time, with the ceiling applied in the same statement so two
-- concurrent requests cannot both pass the check. Returns the count after the
-- call, or -1 when the ceiling refused it.
create or replace function public.consume_ai_calls(p_max integer)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_day  date := (now() at time zone 'Asia/Tokyo')::date;
  v_new  integer;
begin
  if v_user is null then
    raise exception 'consume_ai_calls: no authenticated user';
  end if;
  if p_max is null or p_max < 1 then
    raise exception 'consume_ai_calls: daily maximum must be at least 1';
  end if;

  insert into public.ai_call_ledger (user_id, day, call_count)
  values (v_user, v_day, 1)
  on conflict (user_id, day)
    do update set call_count = public.ai_call_ledger.call_count + 1,
                  updated_at = now()
    where public.ai_call_ledger.call_count < p_max
  returning call_count into v_new;

  -- The conflict target matched a row at or above the ceiling.
  if v_new is null then
    return -1;
  end if;
  return v_new;
end;
$$;

revoke all on function public.consume_ai_calls(integer) from public, anon;
grant execute on function public.consume_ai_calls(integer) to authenticated;
