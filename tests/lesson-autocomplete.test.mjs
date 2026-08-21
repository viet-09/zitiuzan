import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('finishing every practice question records the lesson as done', () => {
  const lesson = read('js/lesson.js');

  // Answering the last question is the learner saying they are done; making
  // them then find the button is busywork.
  assert.match(lesson, /async function maybeAutoComplete\(scope, lessonId, categoryId\)/);
  assert.match(lesson, /if \(!questions\.length \|\| answered\.length < questions\.length\) return;/);
  assert.match(lesson, /void maybeAutoComplete\(page, lessonId, categoryId\);/);

  // A repaint here would wipe .is-answered, blanking the quiz they just
  // finished, so the toolbar is patched in place instead.
  const fn = /async function maybeAutoComplete[\s\S]*?\n}/.exec(lesson)?.[0] ?? '';
  assert.doesNotMatch(fn, /\bpaint\(\)/);
  assert.match(fn, /button\.classList\.add\('is-done'\)/);
  assert.match(fn, /announceLessonCompleted/);
});

test('the automatic path can only ever mark a lesson done, never undo it', () => {
  const completion = read('js/completion.js');

  // toggleLessonCompletion flips; re-running it on an already-finished lesson
  // would un-complete it, and it also opens the sign-in gate mid-quiz.
  assert.match(completion, /export async function completeLessonOnce/);
  assert.match(completion, /if \(!lessonId \|\| isDone\(lessonId\) \|\| completing\.has\(lessonId\)\)/);

  const fn = /export async function completeLessonOnce[\s\S]*?\n}/.exec(completion)?.[0] ?? '';
  assert.doesNotMatch(fn, /openSignInGate/);
  assert.match(fn, /completing\.add\(lessonId\)/);
  assert.match(fn, /finally \{\s*completing\.delete\(lessonId\);/);
});
