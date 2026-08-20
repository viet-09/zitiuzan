import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_COMPANION_STATES,
  PET_STATE_TRANSITIONS,
  chooseNextPetState,
  clampPetPosition,
  getContextualPetAdvice,
  getPetStatePath,
} from '../js/pet-companion-state.js';

test('desktop companion exposes the calm state machine from the reference flow', () => {
  assert.deepEqual(PET_COMPANION_STATES, [
    'wake', 'idle', 'look', 'walk', 'play', 'sleep', 'deep-sleep',
  ]);
  assert.deepEqual(PET_STATE_TRANSITIONS.idle, ['look', 'walk', 'play', 'sleep']);
  assert.deepEqual(PET_STATE_TRANSITIONS.sleep, ['deep-sleep', 'wake']);
  assert.deepEqual(getPetStatePath('deep-sleep', 'look'), ['deep-sleep', 'wake', 'idle', 'look']);
});

test('autonomous state selection follows only valid neighbouring transitions', () => {
  assert.equal(chooseNextPetState('idle', 0), 'look');
  assert.equal(chooseNextPetState('idle', 0.999), 'sleep');
  assert.equal(chooseNextPetState('walk', 0.5), 'play');
});

test('advice prefers the learner current weakness before generic encouragement', () => {
  assert.equal(getContextualPetAdvice({
    quest: { reason: '2 lỗi ngữ pháp đang đến hạn.' },
  }, 0.5), '2 lỗi ngữ pháp đang đến hạn.');
  assert.match(getContextualPetAdvice({}, 0), /lỗi sai|ôn/i);
});

test('drag position stays on screen and leaves room for an open coach panel', () => {
  assert.deepEqual(clampPetPosition(
    { x: 900, y: -200 },
    { width: 1024, height: 768 },
    { width: 124, height: 184 },
    { rightPanelWidth: 300, bottomInset: 78 },
  ), { x: 586, y: -200 });
  assert.deepEqual(clampPetPosition(
    { x: -200, y: 900 },
    { width: 375, height: 812 },
    { width: 108, height: 160 },
    { rightPanelWidth: 0, bottomInset: 74 },
  ), { x: -6, y: 578 });
});
