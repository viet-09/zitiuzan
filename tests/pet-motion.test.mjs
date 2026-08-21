import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_ATLAS_GRID,
  PET_FRAMES,
  PET_MOTION_CLIPS,
  getClipDuration,
  getClipFrame,
  getClipOffsets,
  getPetFramePosition,
  isPetClipLooping,
} from '../js/pet-motion.js';

import { ATLAS_SLOTS, PET_SOURCE_LAYOUT } from '../scripts/lib/pet-sprite-slicer.mjs';

test('the atlas is one cell per action frame and the slot table agrees with it', () => {
  assert.deepEqual(PET_ATLAS_GRID, { columns: 4, rows: 4, frames: 16 });
  assert.equal(ATLAS_SLOTS.length, PET_ATLAS_GRID.frames);
  for (const layout of Object.values(PET_SOURCE_LAYOUT)) {
    assert.equal(layout.length, PET_ATLAS_GRID.frames);
  }
  assert.equal(Object.keys(PET_FRAMES).length, PET_ATLAS_GRID.frames);
  assert.deepEqual([...new Set(Object.values(PET_FRAMES))].sort((a, b) => a - b),
    Array.from({ length: PET_ATLAS_GRID.frames }, (_, index) => index));
});

test('sprite positions address every cell of the four by four atlas', () => {
  assert.deepEqual(getPetFramePosition(0), { x: '0%', y: '0%' });
  assert.deepEqual(getPetFramePosition(3), { x: '100%', y: '0%' });
  assert.deepEqual(getPetFramePosition(4), { x: '0%', y: '33.3333%' });
  assert.deepEqual(getPetFramePosition(15), { x: '100%', y: '100%' });
  assert.deepEqual(getPetFramePosition(99), { x: '100%', y: '100%' });
});

test('no clip borrows a frame from another action', () => {
  const F = PET_FRAMES;
  const families = {
    idle: [F.idle, F.blink, F.soft],
    look: [F.idle, F.lookHalf, F.lookFull],
    walk: [F.walkPass, F.walkStrideA, F.walkStrideB],
    play: [F.walkPass, F.pounce],
    cheer: [F.cheer],
    drowsy: [F.idle, F.blink],
    settle: [F.flop],
    sleep: [F.sleepA, F.sleepB],
    doze: [F.dozeA, F.dozeB],
    wake: [F.flop, F.stretch, F.blink, F.idle],
  };
  assert.deepEqual(Object.keys(PET_MOTION_CLIPS).sort(), Object.keys(families).sort());
  for (const [state, allowed] of Object.entries(families)) {
    for (const step of PET_MOTION_CLIPS[state].steps) {
      assert.ok(allowed.includes(step.frame), `${state} must not play frame ${step.frame}`);
      assert.ok(step.hold >= 100, `${state} frame ${step.frame} flickers at ${step.hold}ms`);
    }
  }
});

test('walking never mixes facings: every stride comes from the left-facing cells', () => {
  const strideFrames = PET_MOTION_CLIPS.walk.steps.map((step) => step.frame);
  assert.deepEqual(strideFrames, [
    PET_FRAMES.walkStrideA, PET_FRAMES.walkPass, PET_FRAMES.walkStrideB, PET_FRAMES.walkPass,
  ]);
  for (const layout of Object.values(PET_SOURCE_LAYOUT)) {
    for (const slot of [PET_FRAMES.walkPass, PET_FRAMES.walkStrideA, PET_FRAMES.walkStrideB]) {
      assert.equal(layout[slot].mirror, undefined, 'walk cells are baked facing left');
    }
  }
});

test('looping clips repeat while one-shot clips hold their closing pose', () => {
  assert.ok(isPetClipLooping('idle'));
  assert.ok(isPetClipLooping('walk'));
  assert.ok(isPetClipLooping('sleep'));
  for (const state of ['look', 'play', 'cheer', 'settle', 'wake']) {
    assert.equal(isPetClipLooping(state), false, `${state} must end`);
    assert.ok(PET_MOTION_CLIPS[state].next, `${state} must name a follow-up state`);
  }

  const idleDuration = getClipDuration('idle');
  assert.equal(getClipFrame('idle', 0), getClipFrame('idle', idleDuration));
  const lastWakeFrame = PET_MOTION_CLIPS.wake.steps.at(-1).frame;
  assert.equal(getClipFrame('wake', getClipDuration('wake') + 9000), lastWakeFrame);
});

test('the rig adds sub-frame lift and breath so short clips still read as motion', () => {
  const resting = getClipOffsets('sleep', 0);
  assert.equal(Math.abs(resting.bob), 0, 'a sleeping pet does not bounce');
  assert.ok(Math.abs(getClipOffsets('sleep', 1600).stretch - 1) > 0.005, 'sleep must breathe');

  const walkLift = Array.from({ length: 40 }, (_, index) => getClipOffsets('walk', index * 20).bob);
  assert.ok(Math.min(...walkLift) < -1.5, 'a walk cycle lifts off the ground');
  assert.ok(Math.max(...walkLift) <= 0, 'the rig only lifts, it never sinks below the baseline');

  const cheerLift = Array.from({ length: 40 }, (_, index) => getClipOffsets('cheer', index * 20).bob);
  assert.ok(Math.min(...cheerLift) < Math.min(...walkLift), 'celebrating hops higher than walking');
});
