import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDailyPlan,
  buildSearchIndex,
  calculateReadiness,
  getDueReviews,
  recordReviewResult,
  searchCurriculum,
} from '../js/learning-engine.js';

const lessons = {
  categories: [
    {
      id: 'kanji', name: 'Hán tự', weeks: [{ week: 1, lessons: [
        { id: 'k1d1', day: 1, title: '{禁止|きんし}', titleEn: 'Prohibition' },
        { id: 'k1d2', day: 2, title: '{駅|えき}', titleEn: 'Station' },
      ] }],
    },
    {
      id: 'grammar', name: 'Ngữ pháp', weeks: [{ week: 1, lessons: [
        { id: 'g1d1', day: 1, title: '～に違いない', titleEn: 'must be' },
      ] }],
    },
  ],
};

test('search finds Japanese, Vietnamese category and English content', () => {
  const index = buildSearchIndex(lessons, (id) => (
    id === 'k1d1' ? { words: [{ jp: '禁煙', reading: 'きんえん', en: 'no smoking' }] } : null
  ));

  assert.equal(searchCurriculum(index, '禁煙')[0].lessonId, 'k1d1');
  assert.equal(searchCurriculum(index, 'han tu')[0].lessonId, 'k1d1');
  assert.equal(searchCurriculum(index, 'must be')[0].lessonId, 'g1d1');
  assert.deepEqual(searchCurriculum(index, '   '), []);
});

test('wrong answers become due reviews and successful reviews increase interval', () => {
  const now = new Date('2026-08-18T00:00:00Z');
  const wrong = recordReviewResult(null, {
    key: 'k1d1:q0', lessonId: 'k1d1', categoryId: 'kanji', prompt: '禁止', correct: false, now,
  });
  assert.equal(wrong.lapses, 1);
  assert.equal(getDueReviews([wrong], new Date('2026-08-18T00:10:00Z')).length, 1);

  const correct = recordReviewResult(wrong, {
    ...wrong, correct: true, now: new Date('2026-08-18T01:00:00Z'),
  });
  assert.equal(correct.intervalDays, 1);
  assert.equal(getDueReviews([correct], new Date('2026-08-18T12:00:00Z')).length, 0);
  assert.equal(getDueReviews([correct], new Date('2026-08-20T00:00:00Z')).length, 1);
});

test('daily plan prioritizes due reviews then the next unfinished lessons across skills', () => {
  const due = [{
    key: 'k1d1:q0', lessonId: 'k1d1', categoryId: 'kanji', prompt: '禁止',
    dueAt: '2026-08-17T00:00:00.000Z', intervalDays: 0, lapses: 1,
  }];
  const plan = buildDailyPlan({
    lessons,
    progress: { k1d1: true },
    reviews: due,
    now: new Date('2026-08-18T00:00:00Z'),
    maxItems: 3,
  });

  assert.equal(plan[0].type, 'review');
  assert.deepEqual(plan.slice(1).map((item) => item.lessonId), ['k1d2', 'g1d1']);
});

test('readiness combines completion, review accuracy and mock-exam evidence', () => {
  const readiness = calculateReadiness({
    lessons,
    progress: { k1d1: true, k1d2: true },
    reviews: [
      { categoryId: 'kanji', attempts: 4, correctAttempts: 3 },
      { categoryId: 'grammar', attempts: 2, correctAttempts: 1 },
    ],
    examHistory: [{ score: { percentage: 80 } }],
  });

  assert.ok(readiness.overall > 0 && readiness.overall <= 100);
  assert.ok(readiness.byCategory.kanji > readiness.byCategory.grammar);
});
