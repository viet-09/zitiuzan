-- Account-synced SRS plus the learner's target JLPT date.
alter table public.user_profiles
  add column if not exists exam_target_date date;

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

alter table public.learning_reviews enable row level security;

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
