import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { existingPrompts, lessonDigest, MIN_REVIEW_QUESTIONS } from '../js/lesson-review.js';
import {
  MIN_QUESTIONS,
  sanitiseQuestions,
  targetQuestionCount,
} from '../supabase/functions/_shared/lesson-review-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// The Edge Function and this test import the very same rules module, so what
// is pinned here is what the server actually runs.
const question = (prompt, extra = {}) => ({ prompt, options: ['あ', 'い', 'う'], answerIndex: 1, note: 'vì thế', ...extra });

test('the lesson digest never feeds the book answers back as the source', () => {
  // practice is what the new questions must differ from; handing it to the
  // generator as "lesson content" invites it to reproduce them.
  const digest = lessonDigest({ title: '～っぽい' }, { patterns: ['A っぽい'], practice: [{ prompt: 'ĐÃ CÓ' }] });
  assert.match(digest, /～っぽい/);
  assert.match(digest, /A っぽい/);
  assert.doesNotMatch(digest, /ĐÃ CÓ/);
});

test('existing prompts are collected for the do-not-repeat list', () => {
  assert.deepEqual(existingPrompts([{ prompt: ' a ' }, { prompt: '' }, null, { prompt: 'b' }]), ['a', 'b']);
});

test('a question repeating the book is dropped however it is annotated', () => {
  // Same sentence, different furigana and numbering — still the same question.
  const existing = ['① この{牛乳|ぎゅうにゅう}は{水|みず}っぽい。'];
  const kept = sanitiseQuestions([
    question('この牛乳は水っぽい。'),
    question('{冷蔵庫|れいぞうこ}に{牛乳|ぎゅうにゅう}がある。'),
  ], existing);
  assert.equal(kept.length, 1);
  assert.match(kept[0].prompt, /冷蔵庫/);
});

test('malformed questions never reach the shared cache', () => {
  const kept = sanitiseQuestions([
    question('ok một', { options: ['a'] }),                    // too few options
    question('ok hai', { answerIndex: 9 }),                    // answer out of range
    question('ok ba', { options: ['same', 'same', 'x'] }),     // duplicate options
    question('x'),                                             // prompt too short
    { prompt: 'thiếu options' },
    question('câu hợp lệ ở đây'),
  ], []);
  assert.deepEqual(kept.map((q) => q.prompt), ['câu hợp lệ ở đây']);
});

test('two generated questions cannot duplicate each other either', () => {
  const kept = sanitiseQuestions([question('cùng một câu hỏi'), question('cùng một câu hỏi')], []);
  assert.equal(kept.length, 1);
});

test('the set scales with the lesson but never drops below ten', () => {
  assert.equal(MIN_REVIEW_QUESTIONS, 10);
  assert.equal(MIN_QUESTIONS, MIN_REVIEW_QUESTIONS, 'client and server must agree on the floor');
  assert.equal(targetQuestionCount(0), 10);
  assert.equal(targetQuestionCount(5), 10);
  assert.equal(targetQuestionCount(20), 18);
  assert.equal(targetQuestionCount(100), 20, 'capped so one lesson cannot run away');
});

test('the review set is shared, read-only to clients, and kept out of completion', () => {
  const schema = read('supabase/schema.sql');
  const lesson = read('js/lesson.js');

  // Shared, not per user: the free tier is a few dozen calls a day.
  assert.match(schema, /create table if not exists public\.lesson_review_quiz \(\s*\n\s*lesson_id\s+text primary key/);
  assert.match(schema, /revoke insert, update, delete on public\.lesson_review_quiz from anon, authenticated/);
  const table = /create table if not exists public\.lesson_review_quiz \(([\s\S]*?)\);/.exec(schema)?.[1] ?? '';
  assert.ok(table, 'lesson_review_quiz must be declared');
  assert.doesNotMatch(table, /user_id/, 'a per-user key would multiply generation by the number of learners');

  // Finishing a lesson must not require answering the AI set as well.
  assert.match(lesson, /function bookQuestions\(scope\)/);
  assert.match(lesson, /querySelectorAll\('#lesson-content \.quiz-question'\)/);
  // Its review keys are prefixed so they cannot collide with the book's.
  assert.match(lesson, /\$\{lessonId\}:r\$\{index\}/);
});
