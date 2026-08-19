import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_COMPANION_STATES,
  chooseNextPetState,
  clampPetPosition,
  getContextualPetAdvice,
} from '../js/pet-companion-state.js';

test('desktop companion exposes the six calm states from the reference flow', () => {
  assert.deepEqual(PET_COMPANION_STATES, [
    'idle', 'look', 'walk', 'sleep', 'deep-sleep', 'advice',
  ]);
});

test('autonomous state selection is deterministic and avoids an immediate repeat', () => {
  assert.equal(chooseNextPetState('idle', 0), 'look');
  assert.equal(chooseNextPetState('idle', 0.999), 'advice');
  assert.notEqual(chooseNextPetState('walk', 0.5), 'walk');
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
