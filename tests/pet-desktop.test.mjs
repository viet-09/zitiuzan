import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_ACTIVITY_WEIGHTS,
  PET_COMPANION_STATES,
  PET_STATE_TRANSITIONS,
  PET_TRAVEL,
  chooseNextPetState,
  choosePetWaypoint,
  clampPetPosition,
  getContextualPetAdvice,
  getPetBounds,
  getPetEnergy,
  getPetStatePath,
} from '../js/pet-companion-state.js';

const VIEWPORT = Object.freeze({ width: 1024, height: 768 });
const PET = Object.freeze({ width: 74, height: 110 });
const AREA = Object.freeze({ bottomInset: 74, topInset: 56 });

test('desktop companion exposes the full calm-to-asleep state flow', () => {
  assert.deepEqual(PET_COMPANION_STATES, [
    'wake', 'idle', 'look', 'walk', 'play', 'cheer', 'drowsy', 'settle', 'sleep', 'doze',
  ]);
  assert.deepEqual(PET_STATE_TRANSITIONS.drowsy, ['idle', 'settle']);
  assert.deepEqual(PET_STATE_TRANSITIONS.settle, ['sleep']);
  // Waking up is a route, not a jump: the pet gets up before it does anything.
  assert.deepEqual(getPetStatePath('doze', 'cheer'), ['doze', 'wake', 'idle', 'cheer']);
  assert.deepEqual(getPetStatePath('sleep', 'look'), ['sleep', 'wake', 'idle', 'look']);
});

test('energy runs down with time left alone and resets to lively on contact', () => {
  assert.equal(getPetEnergy(0), 'lively');
  assert.equal(getPetEnergy(30_000), 'lively');
  assert.equal(getPetEnergy(60_000), 'calm');
  assert.equal(getPetEnergy(150_000), 'drowsy');
  assert.equal(getPetEnergy(240_000), 'asleep');
  assert.equal(getPetEnergy(600_000), 'deep');
});

test('a pet left alone winds down into sleep instead of drawing it at random', () => {
  // Nothing energetic is even on the menu once the pet is sleepy.
  assert.deepEqual(Object.keys(PET_ACTIVITY_WEIGHTS.drowsy), ['drowsy', 'idle', 'look']);
  assert.ok(!('walk' in PET_ACTIVITY_WEIGHTS.drowsy));

  const asleep = { idleMs: 240_000, random: () => 0.5 };
  assert.equal(chooseNextPetState('idle', asleep), 'drowsy');
  assert.equal(chooseNextPetState('drowsy', asleep), 'settle');
  assert.equal(chooseNextPetState('settle', asleep), 'sleep');
  assert.equal(chooseNextPetState('sleep', asleep), 'sleep');

  // Even when the pet is long past bedtime it still lies down before it sleeps
  // and sleeps before it dozes — no rung of the ladder gets skipped.
  const deep = { idleMs: 600_000, random: () => 0.5 };
  assert.equal(chooseNextPetState('idle', deep), 'drowsy');
  assert.equal(chooseNextPetState('drowsy', deep), 'settle');
  assert.equal(chooseNextPetState('settle', deep), 'sleep');
  assert.equal(chooseNextPetState('sleep', deep), 'doze');
  assert.equal(chooseNextPetState('doze', deep), 'doze');

  // A fresh interaction resets the clock, so the sleeper gets up.
  assert.equal(chooseNextPetState('doze', { idleMs: 0, random: () => 0.5 }), 'wake');
});

test('a lively pet picks activities by weight and never repeats one back to back', () => {
  assert.equal(chooseNextPetState('idle', { idleMs: 0, random: () => 0 }), 'idle');
  assert.equal(chooseNextPetState('idle', { idleMs: 0, random: () => 0.99 }), 'play');
  assert.equal(chooseNextPetState('walk', { idleMs: 0, random: () => 0.6 }), 'idle');
  assert.equal(chooseNextPetState('look', { idleMs: 0, random: () => 0.4 }), 'idle');
});

test('advice prefers the learner current weakness before generic encouragement', () => {
  assert.equal(getContextualPetAdvice({
    quest: { reason: '2 lỗi ngữ pháp đang đến hạn.' },
  }, 0.5), '2 lỗi ngữ pháp đang đến hạn.');
  assert.match(getContextualPetAdvice({}, 0), /lỗi sai|ôn/i);
});

test('the travel area covers the screen and keeps the whole pet visible', () => {
  const bounds = getPetBounds(VIEWPORT, PET, AREA);
  assert.deepEqual(bounds, { minX: 8, minY: 64, maxX: 942, maxY: 584 });
  // Free roaming needs real vertical room, not just a strip along the bottom.
  assert.ok(bounds.maxY - bounds.minY > VIEWPORT.height * 0.5);
});

test('drag position stays on screen and leaves room for an open coach panel', () => {
  assert.deepEqual(clampPetPosition({ x: 900, y: -200 }, VIEWPORT, PET, {
    ...AREA, rightPanelWidth: 300,
  }), { x: 642, y: 64 });
  assert.deepEqual(clampPetPosition({ x: -200, y: 900 }, { width: 375, height: 812 }, PET, AREA),
    { x: 8, y: 628 });
});

test('a stroll moves in two dimensions without flipping the pet mid-step', () => {
  const bounds = getPetBounds(VIEWPORT, PET, AREA);
  const start = { x: 480, y: 320 };
  const vertical = [];
  let turns = 0;
  let facing = 'right';

  for (let step = 0; step < 200; step += 1) {
    const seeds = [step / 200, ((step * 37) % 200) / 200];
    let index = 0;
    const waypoint = choosePetWaypoint(start, bounds, {
      facing,
      random: () => seeds[index++ % seeds.length],
    });
    assert.ok(waypoint.x >= bounds.minX && waypoint.x <= bounds.maxX);
    assert.ok(waypoint.y >= bounds.minY && waypoint.y <= bounds.maxY);
    assert.ok(waypoint.duration >= PET_TRAVEL.minDuration && waypoint.duration <= PET_TRAVEL.maxDuration);

    // A step that is barely sideways must not spin the pet around.
    const deltaX = waypoint.x - start.x;
    if (Math.abs(deltaX) < PET_TRAVEL.facingDeadzone) assert.equal(waypoint.facing, facing);
    else assert.equal(waypoint.facing, deltaX < 0 ? 'left' : 'right');

    if (waypoint.facing !== facing) turns += 1;
    facing = waypoint.facing;
    vertical.push(Math.abs(waypoint.y - start.y));
  }

  assert.ok(Math.max(...vertical) > 40, 'the pet must be able to walk up and down the screen');
  assert.ok(turns < 100, 'facing must follow travel, not flip on every step');
});

test('a stroll from a corner still finds somewhere to go', () => {
  const bounds = getPetBounds(VIEWPORT, PET, AREA);
  const waypoint = choosePetWaypoint({ x: bounds.minX, y: bounds.maxY }, bounds, { random: () => 0.5 });
  assert.ok(waypoint.distance > 0);
  assert.ok(waypoint.x >= bounds.minX && waypoint.y <= bounds.maxY);
});
