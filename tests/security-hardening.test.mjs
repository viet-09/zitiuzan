import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the browser client uses the PKCE flow, not the implicit one', () => {
  // The implicit flow adopts any URL fragment carrying access_token, so a
  // crafted link signs the reader into the sender's account. PKCE refuses
  // without the verifier this browser generated.
  const source = read('js/supabase.js');
  assert.match(source, /flowType:\s*'pkce'/, 'the auth client must use PKCE');
  assert.doesNotMatch(source, /flowType:\s*'implicit'/);

  // The vendored client must actually support it, or the option is ignored.
  const vendor = read('vendor/supabase.js');
  assert.match(vendor, /flowType:"pkce"|"pkce"/, 'the vendored client must know the pkce flow');
});

test('exam-review only reveals the answer to the questions the learner got wrong', () => {
  // Returning the key for every question turned one throwaway submission
  // into the full answer key.
  const source = read('supabase/functions/exam-review/index.ts');
  assert.match(
    source,
    /const revealedAnswer = !isCorrect && selectedIndex >= 0 \? q\.options\[q\.answerIndex\] \?\? '' : '';/,
    'the correct answer must only be revealed for a wrong, answered question',
  );
  assert.doesNotMatch(
    source,
    /correct_answer:\s*q\.options\[q\.answerIndex\]/,
    'the response must not carry the whole answer key',
  );
});

test('exam-review-explain never hands the key of a correct answer to the browser', () => {
  const source = read('supabase/functions/exam-review-explain/index.ts');
  assert.match(source, /function forClient\(/);
  assert.match(
    source,
    /entry\.is_correct \? \{ \.\.\.entry, correct_answer: '' \} : entry/,
    'a correct question must not carry its answer to the client',
  );
  // The live key is re-read from exam_content, so an unanswered question
  // still has the right answer when the AI explains it.
  assert.match(
    source,
    /const correctAnswerText = q\.options\[q\.answerIndex\]/,
    'the explanation step must take the key from exam_content',
  );
});

test('the shared review-quiz table is not written from a client-supplied corpus', () => {
  // The set is read by every learner, so a crafted corpus would seed it.
  const source = read('supabase/functions/lesson-review-quiz/index.ts');
  assert.match(source, /async function fetchLessonCorpus\(/, 'the corpus must come from the server');
  assert.match(
    source,
    /if \(publish\) \{[\s\S]{0,200}from\('lesson_review_quiz'\)[\s\S]{0,120}upsert/,
    'the shared row must only be written for a server-side corpus',
  );
  assert.match(
    source,
    /const publish = serverCorpus !== null;/,
    'a client-supplied corpus must not be published',
  );
});

test('the AI quota is enforced by a durable ledger, not an in-memory map', () => {
  const source = read('supabase/functions/gemini-proxy/index.ts');
  assert.match(source, /consume_ai_calls/, 'the proxy must charge the durable ledger');
  assert.match(source, /RATE_LIMIT_DAILY/);

  const schema = read('supabase/schema.sql');
  assert.match(schema, /create table if not exists public\.ai_call_ledger/);
  assert.match(schema, /create or replace function public\.consume_ai_calls\(p_max integer\)/);
  // The ceiling has to be applied inside the statement, or two concurrent
  // requests both pass the check.
  assert.match(schema, /where public\.ai_call_ledger\.call_count < p_max/);
  // Learners may read their own row but never write one.
  assert.match(schema, /revoke insert, update, delete on public\.ai_call_ledger from anon, authenticated;/);
  assert.match(schema, /revoke all on function public\.consume_ai_calls\(integer\) from public, anon;/);
});

test('the settings key is wiped with the rest of the account data', () => {
  // The exam target date is the previous learner's exam schedule.
  const source = read('js/account-storage.js');
  assert.match(source, /'n2_settings_v2'/, 'settings must be user-scoped');
});
