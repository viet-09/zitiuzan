import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeStorage } from './helpers/fake-storage.mjs';
import {
  createLearningState,
  REVIEW_STORAGE_KEY,
  BOOKMARK_STORAGE_KEY,
} from '../js/learning-state.js';

test('quiz outcomes create a durable spaced-repetition review', () => {
  const storage = createFakeStorage();
  const learning = createLearningState(storage);
  const now = new Date('2026-08-18T00:00:00.000Z');

  const wrong = learning.recordReview({
    key: 'g1d1:q0',
    lessonId: 'g1d1',
    categoryId: 'grammar',
    prompt: '電車が遅れた（　）、遅刻した。',
    correctAnswer: 'ために',
    options: ['ために', 'ためで'],
    correctIndex: 0,
    selectedAnswer: 'ためで',
    correct: false,
    now,
  });

  assert.equal(wrong.lastResult, 'wrong');
  assert.deepEqual(wrong.options, ['ために', 'ためで']);
  assert.equal(wrong.correctIndex, 0);
  assert.equal(wrong.selectedAnswer, 'ためで');
  assert.equal(learning.getDueReviews(now).length, 1);
  assert.match(storage.getItem(REVIEW_STORAGE_KEY), /g1d1:q0/);

  const correct = learning.recordReview({
    key: 'g1d1:q0',
    lessonId: 'g1d1',
    categoryId: 'grammar',
    correct: true,
    now,
  });
  assert.equal(correct.intervalDays, 1);
  assert.equal(learning.getDueReviews(now).length, 0);
});

test('bookmarks toggle deterministically and survive a new state instance', () => {
  const storage = createFakeStorage();
  const first = createLearningState(storage);
  assert.equal(first.toggleBookmark('k1d1'), true);
  assert.equal(first.isBookmarked('k1d1'), true);
  assert.match(storage.getItem(BOOKMARK_STORAGE_KEY), /k1d1/);

  const second = createLearningState(storage);
  assert.deepEqual(second.getBookmarks(), ['k1d1']);
  assert.equal(second.toggleBookmark('k1d1'), false);
  assert.deepEqual(second.getBookmarks(), []);
});

test('malformed review and bookmark storage falls back safely', () => {
  const storage = createFakeStorage({
    [REVIEW_STORAGE_KEY]: '{broken',
    [BOOKMARK_STORAGE_KEY]: '{broken',
  });
  const learning = createLearningState(storage);
  assert.deepEqual(learning.getReviews(), []);
  assert.deepEqual(learning.getBookmarks(), []);
});
