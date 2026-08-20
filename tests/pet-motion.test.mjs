import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_MOTION_FRAMES,
  PET_SPRITE_GRID,
  getPetFramePosition,
} from '../js/pet-motion.js';

test('motion sprite sheet has twenty cells and each state uses a multi-frame cycle', () => {
  assert.deepEqual(PET_SPRITE_GRID, { columns: 5, rows: 4, frames: 20 });
  for (const state of ['wake', 'idle', 'look', 'walk', 'play', 'sleep', 'deep-sleep']) {
    assert.ok(PET_MOTION_FRAMES[state].length >= 3, `${state} needs transition frames`);
  }
  assert.deepEqual(PET_MOTION_FRAMES.walk, [10, 11, 12, 13]);
  assert.deepEqual(PET_MOTION_FRAMES['deep-sleep'], [18, 19, 18, 19]);
});

test('sprite positions address every frame in a five by four sheet', () => {
  assert.deepEqual(getPetFramePosition(0), { x: '0%', y: '0%' });
  assert.deepEqual(getPetFramePosition(4), { x: '100%', y: '0%' });
  assert.deepEqual(getPetFramePosition(5), { x: '0%', y: '33.3333%' });
  assert.deepEqual(getPetFramePosition(19), { x: '100%', y: '100%' });
});
