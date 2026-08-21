// Behaviour rules for the desktop companion: which action comes next, how it
// winds down when it is left alone, and where it is allowed to wander.

export const PET_COMPANION_STATES = Object.freeze([
  'wake', 'idle', 'look', 'walk', 'play', 'cheer', 'drowsy', 'settle', 'sleep', 'doze',
]);

// How long since the last touch. The pet does not fall asleep at random — it
// runs down through these tiers and only wakes on a real interaction.
export const PET_ENERGY_TIERS = Object.freeze([
  Object.freeze({ id: 'lively', after: 0 }),
  Object.freeze({ id: 'calm', after: 45_000 }),
  Object.freeze({ id: 'drowsy', after: 120_000 }),
  Object.freeze({ id: 'asleep', after: 200_000 }),
  Object.freeze({ id: 'deep', after: 320_000 }),
]);

// Weighted menus per tier. A lively pet explores; a calm one mostly stands
// around; a sleepy one is not offered anything energetic at all.
export const PET_ACTIVITY_WEIGHTS = Object.freeze({
  lively: Object.freeze({ idle: 30, look: 22, walk: 34, play: 14 }),
  calm: Object.freeze({ idle: 48, look: 26, walk: 24, play: 2 }),
  drowsy: Object.freeze({ drowsy: 62, idle: 26, look: 12 }),
  asleep: Object.freeze({ sleep: 100 }),
  deep: Object.freeze({ doze: 100 }),
});

// Reachable neighbours, used to walk the pet through the poses in between two
// states instead of cutting straight from a curled sleep to a pounce.
export const PET_STATE_TRANSITIONS = Object.freeze({
  wake: Object.freeze(['idle']),
  idle: Object.freeze(['look', 'walk', 'play', 'cheer', 'drowsy']),
  look: Object.freeze(['idle']),
  walk: Object.freeze(['idle']),
  play: Object.freeze(['idle']),
  cheer: Object.freeze(['idle']),
  drowsy: Object.freeze(['idle', 'settle']),
  settle: Object.freeze(['sleep']),
  sleep: Object.freeze(['doze', 'wake']),
  doze: Object.freeze(['wake']),
});

// States the pet must not be yanked out of instantly; it gets up first.
export const PET_RESTING_STATES = Object.freeze(['settle', 'sleep', 'doze']);

const GENERIC_ADVICE = Object.freeze([
  'Ôn lại một lỗi sai hôm nay sẽ nhẹ hơn học lại cả chương ngày mai.',
  'Đọc thành tiếng một câu Nhật giúp trí nhớ bám lâu hơn.',
  'Ba phút ôn đúng hạn vẫn có giá trị hơn một buổi học quá sức.',
  'Khi phân vân, hãy giải thích đáp án bằng lời của chính bạn.',
]);

function unitInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(0.999999, Math.max(0, number));
}

function validState(state) {
  return PET_COMPANION_STATES.includes(state) ? state : 'idle';
}

/** Energy tier for a pet that was last touched `idleMs` ago. */
export function getPetEnergy(idleMs = 0) {
  const elapsed = Math.max(0, Number(idleMs) || 0);
  let tier = PET_ENERGY_TIERS[0].id;
  for (const level of PET_ENERGY_TIERS) if (elapsed >= level.after) tier = level.id;
  return tier;
}

function pickWeighted(weights, randomValue) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = unitInterval(randomValue) * total;
  for (const [state, weight] of entries) {
    if (cursor < weight) return state;
    cursor -= weight;
  }
  return entries[entries.length - 1][0];
}

/**
 * The action to run after the current one finishes. Sleep is reached by
 * running out of energy, and the pet always lies down before it sleeps.
 */
export function chooseNextPetState(current = 'idle', { idleMs = 0, random = Math.random } = {}) {
  const state = validState(current);
  const energy = getPetEnergy(idleMs);

  if (energy === 'asleep' || energy === 'deep') {
    // Wind down one rung at a time: rub the eyes, lie down, sleep, sink deeper.
    if (state === 'doze') return 'doze';
    if (state === 'sleep') return energy === 'deep' ? 'doze' : 'sleep';
    if (state === 'settle') return 'sleep';
    return state === 'drowsy' ? 'settle' : 'drowsy';
  }
  if (PET_RESTING_STATES.includes(state)) return 'wake';

  const next = pickWeighted(PET_ACTIVITY_WEIGHTS[energy] || PET_ACTIVITY_WEIGHTS.calm, random());
  // Two of the same action back to back reads as a stutter rather than a habit.
  if (next === state && next !== 'idle' && next !== 'drowsy') return 'idle';
  return next;
}

/** Shortest chain of poses from one state to another. */
export function getPetStatePath(from = 'idle', to = 'idle') {
  const start = validState(from);
  const target = validState(to);
  if (start === target) return [start];
  const queue = [[start]];
  const visited = new Set([start]);
  while (queue.length) {
    const path = queue.shift();
    const current = path[path.length - 1];
    for (const next of PET_STATE_TRANSITIONS[current] || []) {
      if (visited.has(next)) continue;
      const nextPath = [...path, next];
      if (next === target) return nextPath;
      visited.add(next);
      queue.push(nextPath);
    }
  }
  return ['idle'];
}

export function getContextualPetAdvice(coach = {}, randomValue = Math.random) {
  const reason = String(coach?.quest?.reason || '').trim();
  if (reason) return reason;
  const value = typeof randomValue === 'function' ? randomValue() : randomValue;
  return GENERIC_ADVICE[Math.floor(unitInterval(value) * GENERIC_ADVICE.length)];
}

const EDGE_INSET = 8;

/** Travel area the pet is allowed to occupy, in mount-transform coordinates. */
export function getPetBounds(viewport, petSize, options = {}) {
  const width = Math.max(1, Number(viewport?.width) || 1);
  const height = Math.max(1, Number(viewport?.height) || 1);
  const petWidth = Math.max(1, Number(petSize?.width) || 1);
  const petHeight = Math.max(1, Number(petSize?.height) || 1);
  const rightPanelWidth = Math.max(0, Number(options.rightPanelWidth) || 0);
  const bottomInset = Math.max(0, Number(options.bottomInset) || 0);
  const topInset = Math.max(0, Number(options.topInset) || 0);
  const minX = EDGE_INSET;
  const minY = topInset + EDGE_INSET;
  return {
    minX,
    minY,
    maxX: Math.max(minX, width - petWidth - rightPanelWidth - EDGE_INSET),
    maxY: Math.max(minY, height - petHeight - bottomInset),
  };
}

/** Keep a position inside the travel area — used for roaming and for dragging. */
export function clampPetPosition(position, viewport, petSize, options = {}) {
  const bounds = getPetBounds(viewport, petSize, options);
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, Number(position?.x) || 0)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, Number(position?.y) || 0)),
  };
}

export const PET_TRAVEL = Object.freeze({
  minDistance: 90,
  maxDistance: 300,
  // Vertical steps stay shallower than horizontal ones so a stroll reads as a
  // stroll: the pet drifts up and down the screen instead of hopping about.
  verticalRatio: 0.55,
  speed: 52,
  minDuration: 900,
  maxDuration: 4200,
  // Below this horizontal step the pet keeps looking the way it already faced,
  // so a near-vertical move never triggers a pointless turn.
  facingDeadzone: 18,
});

/**
 * Pick the next stroll target anywhere in the travel area, plus the facing and
 * travel time that go with it.
 */
export function choosePetWaypoint(position, bounds, options = {}) {
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const facing = options.facing === 'left' ? 'left' : 'right';
  const from = {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, Number(position?.x) || 0)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, Number(position?.y) || 0)),
  };

  const attempts = 5;
  const baseAngle = random() * Math.PI * 2;
  const reach = PET_TRAVEL.minDistance + random() * (PET_TRAVEL.maxDistance - PET_TRAVEL.minDistance);

  let best = { x: from.x, y: from.y, distance: 0 };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Fan the retries around the circle rather than re-rolling the same angle,
    // so a pet cornered against two edges always finds a way out.
    const angle = baseAngle + (attempt * Math.PI * 2) / attempts;
    const x = Math.min(bounds.maxX, Math.max(bounds.minX, from.x + Math.cos(angle) * reach));
    const y = Math.min(bounds.maxY, Math.max(bounds.minY, from.y + Math.sin(angle) * reach * PET_TRAVEL.verticalRatio));
    const distance = Math.hypot(x - from.x, y - from.y);
    if (distance > best.distance) best = { x, y, distance };
    if (best.distance >= PET_TRAVEL.minDistance * 0.6) break;
  }

  const deltaX = best.x - from.x;
  return {
    x: best.x,
    y: best.y,
    distance: best.distance,
    facing: Math.abs(deltaX) < PET_TRAVEL.facingDeadzone ? facing : deltaX < 0 ? 'left' : 'right',
    duration: Math.round(Math.min(
      PET_TRAVEL.maxDuration,
      Math.max(PET_TRAVEL.minDuration, (best.distance / PET_TRAVEL.speed) * 1000),
    )),
  };
}
