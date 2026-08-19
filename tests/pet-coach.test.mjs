import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_MEMORY_STORAGE_KEY,
  announceLessonCompleted,
  buildPetCoachState,
  getPetEvolution,
  getPetMastery,
  getPetMemories,
  getPetPreferences,
  getPetTier,
  recordPetMemory,
  renderPet,
  setPetPreferences,
} from '../js/pet.js';
import { createFakeStorage } from './helpers/fake-storage.mjs';

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

test('pet preferences, unlocked visuals and memory journal remain local and bounded', () => {
  const storage = createFakeStorage();
  globalThis.localStorage = storage;
  assert.deepEqual(getPetPreferences(), { petType: 'fox', petAccessory: 'none' });
  assert.deepEqual(setPetPreferences({ petType: 'rabbit', petAccessory: 'pencil' }), {
    petType: 'rabbit', petAccessory: 'pencil',
  });
  const markup = renderPet({ petType: 'rabbit', petAccessory: 'pencil', streak: 7, evolutionId: 'mentor' });
  assert.match(markup, /class="pet-art pet-art--rabbit pixel-pet pixel-pet--rabbit"/u);
  assert.match(markup, /<svg[^>]+class="pixel-pet__svg"/u);
  assert.match(markup, /shape-rendering="crispEdges"/u);
  assert.match(markup, /pet-accessory--pencil/u);
  assert.doesNotMatch(markup, /🐰|🦊/u);

  const fox = renderPet({ petType: 'fox', petAccessory: 'none', streak: 0 });
  assert.match(fox, /class="pet-art pet-art--fox pixel-pet pixel-pet--fox"/u);
  assert.match(fox, /<svg[^>]+class="pixel-pet__svg"/u);
  assert.doesNotMatch(fox, /🐰|🦊/u);
  assert.equal(getPetTier(0).id, 'sleeping');
  assert.equal(getPetTier(2).id, 'waking');
  assert.equal(getPetTier(5).id, 'happy');
  assert.equal(getPetTier(9).id, 'excited');
  assert.equal(getPetTier(20).id, 'legendary');

  recordPetMemory({ id: 'lesson:g1d1', type: 'lesson', title: 'Hoàn thành bài', detail: 'g1d1' }, storage);
  recordPetMemory({ id: 'lesson:g1d1', type: 'lesson', title: 'Hoàn thành lại', detail: 'g1d1' }, storage);
  assert.equal(getPetMemories(storage).length, 1);
  assert.equal(getPetMemories(storage)[0].title, 'Hoàn thành lại');
  assert.ok(storage.snapshot()[PET_MEMORY_STORAGE_KEY]);
  announceLessonCompleted({ id: 'g1d1' });
});
