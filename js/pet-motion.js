// Sprite playback for the study companion.
//
// Frames live in a 4x4 atlas built by `scripts/build-pet-atlas.mjs`, where each
// cell is one pose of one action, planted on a shared baseline and facing left.
// A clip therefore only ever draws from its own action, and the runtime mirrors
// the whole sprite instead of swapping in an opposite-facing frame.

export const PET_ATLAS_GRID = Object.freeze({ columns: 4, rows: 4, frames: 16 });

export const PET_FRAMES = Object.freeze({
  idle: 0,
  blink: 1,
  soft: 2,
  lookHalf: 3,
  lookFull: 4,
  walkPass: 5,
  walkStrideA: 6,
  walkStrideB: 7,
  pounce: 8,
  cheer: 9,
  stretch: 10,
  flop: 11,
  sleepA: 12,
  sleepB: 13,
  dozeA: 14,
  dozeB: 15,
});

const F = PET_FRAMES;

// `bob` lifts the sprite (px), `tilt` rocks it (deg) and `breathe` squashes it.
// Together they carry the in-between motion that a four-pose sheet cannot, so
// no clip has to borrow a frame from another action to look alive.
function motion({ bob = 0, bobHz = 0, tilt = 0, tiltHz = 0, breathe = 0, breatheHz = 0 } = {}) {
  return Object.freeze({ bob, bobHz, tilt, tiltHz, breathe, breatheHz });
}

function clip({ steps, loop = true, next = null, ...rest }) {
  return Object.freeze({
    loop,
    next,
    motion: motion(rest.motion),
    steps: Object.freeze(steps.map(([frame, hold]) => Object.freeze({ frame, hold }))),
  });
}

/** Every action the companion can play, keyed by companion state. */
export const PET_MOTION_CLIPS = Object.freeze({
  // Standing at ease: only the three front-facing poses, so the mascot never
  // appears to spin on the spot while it is doing nothing.
  idle: clip({
    steps: [[F.idle, 2100], [F.blink, 150], [F.idle, 1500], [F.soft, 1900], [F.blink, 140], [F.soft, 1200]],
    motion: { bob: 1, bobHz: 0.26, breathe: 0.016, breatheHz: 0.26 },
  }),

  // A head turn away and back. Starts and ends on the front pose so it reads as
  // one glance rather than a series of unrelated stances.
  look: clip({
    steps: [[F.idle, 300], [F.lookHalf, 260], [F.lookFull, 1000], [F.lookHalf, 240], [F.idle, 320]],
    loop: false,
    next: 'idle',
    motion: { bob: 0.7, bobHz: 0.4, tilt: 0.8, tiltHz: 0.4, breathe: 0.012, breatheHz: 0.4 },
  }),

  // Two strides through a passing pose, all left-facing; travel direction comes
  // from mirroring the sprite, never from switching frames.
  walk: clip({
    steps: [[F.walkStrideA, 180], [F.walkPass, 155], [F.walkStrideB, 180], [F.walkPass, 155]],
    motion: { bob: 2.2, bobHz: 3, tilt: 1.1, tiltHz: 1.5, breathe: 0.01, breatheHz: 1.5 },
  }),

  // Crouch, spring, crouch — the pounce pose paired only with the neutral
  // left-facing stance it launches from.
  play: clip({
    steps: [[F.walkPass, 230], [F.pounce, 280], [F.walkPass, 190], [F.pounce, 300], [F.walkPass, 260]],
    loop: false,
    next: 'idle',
    motion: { bob: 5, bobHz: 1.9, tilt: 3.4, tiltHz: 1.9 },
  }),

  // Celebration is a single dedicated pose; the bounce comes from the rig.
  cheer: clip({
    steps: [[F.cheer, 1500]],
    loop: false,
    next: 'idle',
    motion: { bob: 7, bobHz: 2.3, tilt: 3, tiltHz: 1.15, breathe: 0.02, breatheHz: 2.3 },
  }),

  // Long, heavy blinks while the pet loses interest.
  drowsy: clip({
    steps: [[F.idle, 900], [F.blink, 1500], [F.idle, 700], [F.blink, 2100]],
    motion: { bob: 0.8, bobHz: 0.18, breathe: 0.022, breatheHz: 0.18 },
  }),

  // Lying down, played once on the way into sleep.
  settle: clip({
    steps: [[F.flop, 1100]],
    loop: false,
    next: 'sleep',
    motion: { breathe: 0.02, breatheHz: 0.24 },
  }),

  sleep: clip({
    steps: [[F.sleepA, 1600], [F.sleepB, 1600]],
    motion: { breathe: 0.026, breatheHz: 0.15 },
  }),

  doze: clip({
    steps: [[F.dozeA, 2000], [F.dozeB, 2000]],
    motion: { breathe: 0.034, breatheHz: 0.1 },
  }),

  // Getting up: still lying, big stretch, then eyes open.
  wake: clip({
    steps: [[F.flop, 430], [F.stretch, 780], [F.blink, 240], [F.idle, 280]],
    loop: false,
    next: 'idle',
    motion: { bob: 1.6, bobHz: 0.55, breathe: 0.028, breatheHz: 0.55 },
  }),
});

export const PET_MOTION_STATES = Object.freeze(Object.keys(PET_MOTION_CLIPS));

function safeFrame(frame) {
  const value = Math.trunc(Number(frame));
  return Math.min(PET_ATLAS_GRID.frames - 1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** Background position that isolates one atlas cell. */
export function getPetFramePosition(frame) {
  const value = safeFrame(frame);
  const column = value % PET_ATLAS_GRID.columns;
  const row = Math.floor(value / PET_ATLAS_GRID.columns);
  return {
    x: `${Number(((column / (PET_ATLAS_GRID.columns - 1)) * 100).toFixed(4))}%`,
    y: `${Number(((row / (PET_ATLAS_GRID.rows - 1)) * 100).toFixed(4))}%`,
  };
}

export function getPetClip(state) {
  return PET_MOTION_CLIPS[state] || PET_MOTION_CLIPS.idle;
}

/** True when a clip repeats forever; one-shot clips report their own ending. */
export function isPetClipLooping(state) {
  return getPetClip(state).loop;
}

/** Total runtime of one pass through a clip. */
export function getClipDuration(state) {
  return getPetClip(state).steps.reduce((total, step) => total + step.hold, 0);
}

/**
 * Frame shown `elapsed` ms into a clip. Looping clips wrap; one-shot clips hold
 * their last pose so a finished action never flickers back to its first frame.
 */
export function getClipFrame(state, elapsed = 0) {
  const { steps, loop } = getPetClip(state);
  const duration = steps.reduce((total, step) => total + step.hold, 0);
  const time = Math.max(0, Number(elapsed) || 0);
  if (!loop && time >= duration) return steps[steps.length - 1].frame;
  let cursor = loop ? time % duration : time;
  for (const step of steps) {
    if (cursor < step.hold) return step.frame;
    cursor -= step.hold;
  }
  return steps[steps.length - 1].frame;
}

/** Sub-frame rig offsets: lift, rock and breath at `elapsed` ms into a clip. */
export function getClipOffsets(state, elapsed = 0) {
  const { bob, bobHz, tilt, tiltHz, breathe, breatheHz } = getPetClip(state).motion;
  const seconds = Math.max(0, Number(elapsed) || 0) / 1000;
  const wave = (hz) => Math.sin(seconds * hz * Math.PI * 2);
  const lift = bobHz ? Math.abs(wave(bobHz)) : 0;
  const swell = breatheHz ? wave(breatheHz) * breathe : 0;
  return {
    lift,
    bob: -lift * bob,
    tilt: tiltHz ? wave(tiltHz) * tilt : 0,
    stretch: 1 + swell,
    squash: 1 - swell * 0.55,
  };
}

/**
 * Drive one sprite host. Frame stepping and rig offsets share a single
 * animation frame loop, so the pose and its in-between motion never drift apart.
 */
export function mountPetMotion(host, options = {}) {
  if (!(host instanceof HTMLElement)) return null;

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onClipEnd = typeof options.onClipEnd === 'function' ? options.onClipEnd : null;
  let reduced = motionQuery.matches;
  let state = PET_MOTION_CLIPS[options.initialState] ? options.initialState : 'idle';
  let startedAt = 0;
  let frameRequest = 0;
  let paintedFrame = -1;
  let announcedEnd = false;
  let destroyed = false;

  function paintFrame(frame) {
    if (frame === paintedFrame) return;
    paintedFrame = frame;
    const position = getPetFramePosition(frame);
    host.dataset.petFrame = String(frame);
    host.style.setProperty('--pet-frame-x', position.x);
    host.style.setProperty('--pet-frame-y', position.y);
  }

  function paintOffsets({ bob, tilt, stretch, squash, lift }) {
    host.style.setProperty('--pet-bob', `${bob.toFixed(2)}px`);
    host.style.setProperty('--pet-tilt', `${tilt.toFixed(2)}deg`);
    host.style.setProperty('--pet-stretch', stretch.toFixed(4));
    host.style.setProperty('--pet-squash', squash.toFixed(4));
    host.style.setProperty('--pet-lift', lift.toFixed(3));
  }

  function render(timestamp) {
    frameRequest = 0;
    if (destroyed) return;
    if (!startedAt) startedAt = timestamp;
    const elapsed = timestamp - startedAt;
    paintFrame(getClipFrame(state, elapsed));
    paintOffsets(getClipOffsets(state, elapsed));
    const clipState = state;
    if (!getPetClip(state).loop && !announcedEnd && elapsed >= getClipDuration(state)) {
      announcedEnd = true;
      onClipEnd?.(clipState, getPetClip(clipState).next);
      if (destroyed || state !== clipState) return;
    }
    frameRequest = window.requestAnimationFrame(render);
  }

  function stop() {
    if (!frameRequest) return;
    window.cancelAnimationFrame(frameRequest);
    frameRequest = 0;
  }

  function start() {
    if (destroyed || reduced || document.hidden || frameRequest) return;
    frameRequest = window.requestAnimationFrame(render);
  }

  function play(next, { restart = true } = {}) {
    const target = PET_MOTION_CLIPS[next] ? next : 'idle';
    if (!restart && target === state) return;
    state = target;
    startedAt = 0;
    announcedEnd = false;
    paintedFrame = -1;
    host.dataset.petClip = state;
    stop();
    paintFrame(getClipFrame(state, 0));
    paintOffsets(getClipOffsets(state, 0));
    start();
  }

  function onMotionPreference(event) {
    reduced = event.matches;
    host.dataset.motion = reduced ? 'reduced' : 'active';
    if (reduced) {
      stop();
      paintOffsets(getClipOffsets(state, 0));
      return;
    }
    startedAt = 0;
    start();
  }

  // Coming back to a hidden tab resumes where the clip left off: looping clips
  // wrap and finished one-shots keep holding their closing pose.
  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }

  motionQuery.addEventListener('change', onMotionPreference);
  document.addEventListener('visibilitychange', onVisibility);
  host.dataset.motion = reduced ? 'reduced' : 'active';
  play(state);

  return {
    play,
    setState: play,
    get state() { return state; },
    destroy() {
      destroyed = true;
      stop();
      motionQuery.removeEventListener('change', onMotionPreference);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
