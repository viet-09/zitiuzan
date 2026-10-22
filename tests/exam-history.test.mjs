import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeStorage } from './helpers/fake-storage.mjs';
import { createExamHistoryStore, EXAM_HISTORY_STORAGE_KEY } from '../js/exam-history.js';

// The score shape an exam_attempts row actually arrives in: exam-review
// writes percentage as a string with a percent sign (index.ts:190).
const attempt = (id, percentage, created_at) => ({ id, score: { percentage }, created_at });

test('exam evidence cache is bounded, deduplicated and survives reloads', () => {
  const storage = createFakeStorage();
  const first = createExamHistoryStore(storage);
  first.replace([
    attempt('a', '70%', '2026-08-17T00:00:00Z'),
    attempt('b', '80%', '2026-08-18T00:00:00Z'),
  ]);
  first.add(attempt('b', '85%', '2026-08-18T00:00:00Z'));

  const second = createExamHistoryStore(storage);
  assert.equal(second.get().length, 2);
  assert.equal(second.get()[0].score.percentage, '85%');
  assert.match(storage.getItem(EXAM_HISTORY_STORAGE_KEY), /"percentage":"85%"/);
});

test('malformed exam cache safely falls back to an empty list', () => {
  const storage = createFakeStorage({ [EXAM_HISTORY_STORAGE_KEY]: '{broken' });
  assert.deepEqual(createExamHistoryStore(storage).get(), []);
});

test('a hand-written cache entry cannot inflate readiness', () => {
  // The cache lives in localStorage, so the learner can edit it. An entry
  // without a server-assigned id must not reach calculateReadiness.
  const storage = createFakeStorage();
  storage.setItem(EXAM_HISTORY_STORAGE_KEY, JSON.stringify([
    { score: { percentage: '100%' }, created_at: new Date().toISOString() },
  ]));
  assert.deepEqual(createExamHistoryStore(storage).get(), []);
});

test('an edited grader entry with an impossible score is dropped', () => {
  // A real attempt id with a tampered score. The score format is the only
  // check that runs client-side, so anything outside 0-99% is discarded.
  const storage = createFakeStorage();
  storage.setItem(EXAM_HISTORY_STORAGE_KEY, JSON.stringify([
    attempt('real-uuid', '250%', '2026-08-18T00:00:00Z'),
    attempt('real-uuid2', 'not-a-score', '2026-08-18T00:00:00Z'),
  ]));
  assert.deepEqual(createExamHistoryStore(storage).get(), []);
});

test('entries without a timestamp are dropped', () => {
  const storage = createFakeStorage();
  storage.setItem(EXAM_HISTORY_STORAGE_KEY, JSON.stringify([
    { id: 'a', score: { percentage: '100%' }, created_at: 'garbage' },
  ]));
  assert.deepEqual(createExamHistoryStore(storage).get(), []);
});
