import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_MOTION_FRAMES,
  PET_MOTION_ATLAS_COUNT,
  PET_SPRITE_GRID,
  getPetFrameAsset,
  getPetFramePosition,
} from '../js/pet-motion.js';

test('motion library supplies ten atlases and two hundred cells for each pet', () => {
  assert.equal(PET_MOTION_ATLAS_COUNT, 10);
  assert.deepEqual(PET_SPRITE_GRID, { columns: 5, rows: 4, framesPerAtlas: 20, frames: 200 });
  for (const state of ['wake', 'idle', 'look', 'walk', 'play', 'sleep', 'deep-sleep']) {
    assert.ok(PET_MOTION_FRAMES[state].length >= 30, `${state} needs in-between frames`);
  }
  assert.deepEqual(PET_MOTION_FRAMES.walk.slice(0, 12), [10, 30, 50, 70, 90, 110, 130, 150, 170, 190, 11, 31]);
  assert.equal(getPetFrameAsset('fox', 0), 'assets/pets/fox-motion-sprites.png');
  assert.equal(getPetFrameAsset('rabbit', 199), 'assets/pets/rabbit-motion-09.png');
});

test('sprite positions address every frame cell inside its selected atlas', () => {
  assert.deepEqual(getPetFramePosition(0), { x: '0%', y: '0%' });
  assert.deepEqual(getPetFramePosition(4), { x: '100%', y: '0%' });
  assert.deepEqual(getPetFramePosition(5), { x: '0%', y: '33.3333%' });
  assert.deepEqual(getPetFramePosition(19), { x: '100%', y: '100%' });
  assert.deepEqual(getPetFramePosition(199), { x: '100%', y: '100%' });
});
