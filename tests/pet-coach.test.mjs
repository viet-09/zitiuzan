import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPetCoachState,
  getPetEvolution,
  getPetMastery,
} from '../js/pet.js';

function mastered(categoryId, key) {
  return { key, categoryId, lapses: 2, lastResult: 'correct', intervalDays: 7 };
}

test('pet evolution follows mastered weaknesses and skill balance, not streak alone', () => {
  const reviews = [
    mastered('kanji', 'k1'), mastered('kanji', 'k2'),
    mastered('grammar', 'g1'), mastered('grammar', 'g2'),
    mastered('reading', 'r1'), mastered('vocabulary', 'v1'),
  ];
  assert.deepEqual(getPetMastery(reviews), { mastered: 6, balancedSkills: 4 });
  assert.equal(getPetEvolution(reviews).id, 'companion');
  assert.equal(getPetEvolution([], { streak: 999 }).id, 'hatchling');
});

test('pet coach chooses a due review quest before a new lesson', () => {
  const state = buildPetCoachState({
    dailyPlan: [{ type: 'lesson', lessonId: 'k1d2', categoryId: 'kanji', title: '駅' }],
    weaknessProfile: { total: 4, due: 2, top: [{ categoryId: 'grammar' }] },
    miniTest: [{ reviewKey: 'g1d1:q0' }],
    readiness: { overall: 42, weakestCategory: 'grammar' },
    reviews: [mastered('grammar', 'g1')],
  });
  assert.equal(state.mood, 'focused');
  assert.equal(state.quest.route, '#/review');
  assert.match(state.quest.reason, /2 lỗi ngữ pháp/);
  assert.equal(state.evolution.id, 'hatchling');
});
