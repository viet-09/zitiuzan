import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeReviewCollections,
  reviewFromRow,
  reviewToRow,
} from '../js/review-sync.js';

test('review sync rows round-trip the complete answerable weakness', () => {
  const review = {
    key: 'g1d1:q0', lessonId: 'g1d1', categoryId: 'grammar', prompt: '雨が降る（　）。',
    correctAnswer: 'に違いない', options: ['ために', 'に違いない'], correctIndex: 1,
    selectedAnswer: 'ために', source: 'mini-test', attempts: 3, correctAttempts: 1,
    lapses: 2, intervalDays: 1, lastResult: 'correct',
    lastReviewedAt: '2026-08-18T00:00:00.000Z', dueAt: '2026-08-19T00:00:00.000Z',
  };
  const row = reviewToRow(review, 'user-1');
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.review_key, review.key);
  assert.deepEqual(reviewFromRow(row), review);
});

test('review sync merge keeps the newest review per key across devices', () => {
  const local = [
    { key: 'shared', prompt: 'local old', lastReviewedAt: '2026-08-17T00:00:00Z' },
    { key: 'local-only', prompt: 'local', lastReviewedAt: '2026-08-18T00:00:00Z' },
  ];
  const remote = [
    { key: 'shared', prompt: 'remote new', lastReviewedAt: '2026-08-18T00:00:00Z' },
    { key: 'remote-only', prompt: 'remote', lastReviewedAt: '2026-08-16T00:00:00Z' },
  ];
  const merged = mergeReviewCollections(local, remote);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((item) => item.key === 'shared').prompt, 'remote new');
  assert.deepEqual(merged.map((item) => item.key), ['local-only', 'shared', 'remote-only']);
});
