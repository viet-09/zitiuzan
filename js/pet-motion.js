export const PET_SPRITE_GRID = Object.freeze({ columns: 5, rows: 4, frames: 20 });

// Frame order maps directly to the 5×4 generated sprite sheets. Repeating
// settle frames makes the tiny motions readable instead of a hard cut.
export const PET_MOTION_FRAMES = Object.freeze({
  wake: Object.freeze([0, 1, 2, 3]),
  idle: Object.freeze([2, 3, 4, 3]),
  look: Object.freeze([5, 6, 7, 8, 9]),
  walk: Object.freeze([10, 11, 12, 13]),
  play: Object.freeze([14, 15, 14, 15]),
  sleep: Object.freeze([16, 17, 16, 17]),
  'deep-sleep': Object.freeze([18, 19, 18, 19]),
});

const FRAME_TIMINGS = Object.freeze({
  wake: 170,
  idle: 460,
  look: 260,
  walk: 135,
  play: 190,
  sleep: 720,
  'deep-sleep': 960,
});

function safeFrame(frame) {
  const value = Math.trunc(Number(frame));
  return Math.min(PET_SPRITE_GRID.frames - 1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function getPetFramePosition(frame) {
  const value = safeFrame(frame);
  const column = value % PET_SPRITE_GRID.columns;
  const row = Math.floor(value / PET_SPRITE_GRID.columns);
  return {
    x: `${Number((column / (PET_SPRITE_GRID.columns - 1) * 100).toFixed(4))}%`,
    y: `${Number((row / (PET_SPRITE_GRID.rows - 1) * 100).toFixed(4))}%`,
  };
}

function validState(state) {
  return Object.hasOwn(PET_MOTION_FRAMES, state) ? state : 'idle';
}

export function mountPetMotion(host, options = {}) {
  if (!(host instanceof HTMLElement)) return null;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = validState(options.initialState || host.dataset.petState);
  let timer = 0;
  let frameIndex = 0;
  let reduced = motionQuery.matches;
  let destroyed = false;

  function paint(frame) {
    const position = getPetFramePosition(frame);
    host.dataset.petFrame = String(frame);
    host.style.setProperty('--pet-frame-x', position.x);
    host.style.setProperty('--pet-frame-y', position.y);
  }

  function clear() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  }

  function tick() {
    if (destroyed || reduced) return;
    const frames = PET_MOTION_FRAMES[state];
    paint(frames[frameIndex % frames.length]);
    frameIndex += 1;
    timer = window.setTimeout(tick, FRAME_TIMINGS[state]);
  }

  function setState(next) {
    state = validState(next);
    frameIndex = 0;
    clear();
    paint(PET_MOTION_FRAMES[state][0]);
    if (!reduced) tick();
  }

  function onMotionPreference(event) {
    reduced = event.matches;
    setState(state);
  }

  motionQuery.addEventListener('change', onMotionPreference);
  setState(state);
  return {
    setState,
    destroy() {
      destroyed = true;
      clear();
      motionQuery.removeEventListener('change', onMotionPreference);
    },
  };
}
