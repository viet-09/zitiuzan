-- "Ôn lại": AI practice per lesson, shared by every learner.
--
-- Deliberately not keyed by user like lesson_content_cache is. The questions
-- belong to the lesson, and the Gemini free tier is a couple of dozen calls a
-- day — caching per learner would multiply one lesson into one call each.
-- Only the lesson-review-quiz Edge Function writes, with the service role.

-- ---------------------------------------------------------------------------
-- 3b. lesson_review_quiz — AI "Ôn lại" questions, shared by every learner
-- ---------------------------------------------------------------------------
-- Unlike lesson_content_cache these rows are NOT per user: the questions are a
-- property of the lesson, so generating them once and sharing them keeps the
-- Gemini free tier (a couple of dozen calls a day) from being multiplied by the
-- number of learners. Clients may read but never write — only the
-- lesson-review-quiz Edge Function does, with the service role, so a crafted
-- client cannot poison what everyone else studies.
create table if not exists public.lesson_review_quiz (
  lesson_id   text primary key references public.curriculum_lessons(lesson_id) on delete cascade,
  questions   jsonb not null check (jsonb_typeof(questions) = 'array'),
  model       text not null default '',
  created_at  timestamptz not null default now()
);
alter table public.lesson_review_quiz enable row level security;
drop policy if exists "lesson review quiz read" on public.lesson_review_quiz;
create policy "lesson review quiz read"
  on public.lesson_review_quiz for select to authenticated using (true);
revoke insert, update, delete on public.lesson_review_quiz from anon, authenticated;
