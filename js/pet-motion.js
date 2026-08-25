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

// Premium atlases tell a different story from the original companion sheet:
// one row for personality, travel, a signature emote and a four-beat recall.
// Keeping this map separate lets existing users retain the classic sleep cycle
// while every skin gets the much more expressive choreography it was drawn for.
export const PET_SKIN_FRAMES = Object.freeze({
  idleA: 0, idleB: 1, idleC: 2, idleD: 3,
  travelA: 4, travelB: 5, travelC: 6, travelD: 7,
  signatureA: 8, signatureB: 9, signatureC: 10, signatureD: 11,
  recallA: 12, recallB: 13, recallC: 14, recallD: 15,
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
    steps: Object.freeze(steps.map(([frame, hold, sheet = null]) => Object.freeze({ frame, hold, sheet }))),
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

  signature: clip({
    steps: [[F.cheer, 1500]],
    loop: false,
    next: 'idle',
    motion: { bob: 7, bobHz: 2.3, tilt: 3, tiltHz: 1.15, breathe: 0.02, breatheHz: 2.3 },
  }),

  recall: clip({
    steps: [[F.cheer, 520], [F.stretch, 650], [F.sleepA, 650], [F.dozeB, 900]],
    loop: false,
    next: 'idle',
    motion: { bob: 3.5, bobHz: 1.1, tilt: 2, tiltHz: 0.55, breathe: 0.018, breatheHz: 0.55 },
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

const SF = PET_SKIN_FRAMES;
const PREMIUM_SKIN_IDS = new Set([
  'peacemaker-high-noon', 'prestige-heartsteel', 'high-noon', 'dawnbringer',
  'elementalist', 'prestige-spirit-blossom', 'dark-cosmic', 'cosmic',
]);

const SKIN_RHYTHMS = Object.freeze({
  'peacemaker-high-noon': Object.freeze({ idle: [1050, 320, 840, 450], travel: [190, 150, 180, 150], signature: [460, 430, 520, 760], recall: [540, 620, 660, 980] }),
  'prestige-heartsteel': Object.freeze({ idle: [820, 280, 760, 420], travel: [155, 155, 155, 155], signature: [390, 390, 470, 820], recall: [520, 560, 720, 1050] }),
  'high-noon': Object.freeze({ idle: [1150, 260, 760, 420], travel: [205, 145, 195, 145], signature: [430, 390, 500, 850], recall: [490, 660, 760, 1100] }),
  dawnbringer: Object.freeze({ idle: [1100, 340, 900, 500], travel: [220, 180, 220, 180], signature: [520, 560, 620, 900], recall: [650, 720, 820, 1150] }),
  elementalist: Object.freeze({ idle: [760, 760, 760, 760], travel: [210, 190, 210, 190], signature: [480, 480, 560, 900], recall: [620, 680, 780, 1050] }),
  'prestige-spirit-blossom': Object.freeze({ idle: [1050, 380, 880, 520], travel: [230, 190, 220, 190], signature: [560, 500, 640, 980], recall: [680, 760, 840, 1200] }),
  'dark-cosmic': Object.freeze({ idle: [1250, 400, 980, 560], travel: [250, 210, 240, 210], signature: [600, 640, 720, 1100], recall: [720, 820, 960, 1350] }),
  cosmic: Object.freeze({ idle: [980, 360, 840, 480], travel: [205, 175, 205, 175], signature: [500, 520, 600, 920], recall: [640, 720, 820, 1100] }),
});

function skinSteps(frames, holds) {
  return frames.map((frame, index) => [frame, holds[index]]);
}

const PREMIUM_RECALL_HOLDS = Object.freeze([
  Object.freeze([320, 100, 90, 90, 85, 85, 80, 80, 80, 80, 80, 80, 80, 85, 95, 180]),
  Object.freeze([140, 85, 80, 80, 75, 75, 70, 70, 70, 75, 75, 80, 80, 85, 95, 180]),
  Object.freeze([180, 90, 85, 85, 80, 80, 75, 75, 75, 80, 80, 85, 85, 90, 105, 220]),
  Object.freeze([180, 90, 85, 85, 80, 80, 75, 75, 75, 80, 80, 85, 90, 120, 180, 600]),
]);

const PREMIUM_RECALL_TEMPO = Object.freeze({
  'peacemaker-high-noon': 0.98,
  'prestige-heartsteel': 0.94,
  'high-noon': 0.99,
  dawnbringer: 1,
  elementalist: 0.96,
  'prestige-spirit-blossom': 0.97,
  'dark-cosmic': 0.95,
  cosmic: 0.93,
});

function premiumRecallSteps(skinId) {
  const tempo = PREMIUM_RECALL_TEMPO[skinId] || 1;
  return PREMIUM_RECALL_HOLDS.flatMap((holds, actIndex) => holds.map((hold, frame) => [
    frame,
    Math.max(65, Math.round((hold * tempo) / 5) * 5),
    `${skinId}-recall-act-${actIndex + 1}`,
  ]));
}

function buildPremiumClips(skinId) {
  const rhythm = SKIN_RHYTHMS[skinId] || SKIN_RHYTHMS.cosmic;
  const idleFrames = [SF.idleA, SF.idleB, SF.idleC, SF.idleD];
  const travelFrames = [SF.travelA, SF.travelB, SF.travelC, SF.travelD];
  const signatureFrames = [SF.signatureA, SF.signatureB, SF.signatureC, SF.signatureD];
  const recallSteps = premiumRecallSteps(skinId);
  const recallMotion = { bob: 1.2, bobHz: 0.32, tilt: 0.6, tiltHz: 0.22, breathe: 0.01, breatheHz: 0.28 };
  return Object.freeze({
    idle: clip({ steps: skinSteps(idleFrames, rhythm.idle), motion: { bob: 1.2, bobHz: 0.3, breathe: 0.016, breatheHz: 0.3 } }),
    look: clip({ steps: skinSteps([SF.idleA, SF.idleB, SF.idleC, SF.idleA], [260, 360, 760, 300]), loop: false, next: 'idle', motion: { bob: 1, bobHz: 0.5, tilt: 1, tiltHz: 0.5 } }),
    walk: clip({ steps: skinSteps(travelFrames, rhythm.travel), motion: { bob: 2.4, bobHz: 2.8, tilt: 1.2, tiltHz: 1.4 } }),
    play: clip({ steps: skinSteps(signatureFrames, rhythm.signature), loop: false, next: 'idle', motion: { bob: 4.8, bobHz: 1.8, tilt: 2.8, tiltHz: 0.9 } }),
    cheer: clip({ steps: skinSteps(signatureFrames, rhythm.signature), loop: false, next: 'idle', motion: { bob: 5.8, bobHz: 2, tilt: 3.2, tiltHz: 1 } }),
    signature: clip({ steps: skinSteps(signatureFrames, rhythm.signature), loop: false, next: 'idle', motion: { bob: 5.8, bobHz: 2, tilt: 3.2, tiltHz: 1 } }),
    recall: clip({ steps: recallSteps, loop: false, next: 'idle', motion: recallMotion }),
    drowsy: clip({ steps: skinSteps([SF.idleA, SF.idleB], [1100, 1600]), motion: { bob: 0.7, bobHz: 0.18, breathe: 0.022, breatheHz: 0.18 } }),
    settle: clip({ steps: [[SF.idleD, 1000]], loop: false, next: 'sleep', motion: { breathe: 0.02, breatheHz: 0.24 } }),
    sleep: clip({ steps: skinSteps([SF.idleD, SF.idleA], [1700, 1700]), motion: { breathe: 0.026, breatheHz: 0.15 } }),
    doze: clip({ steps: skinSteps([SF.idleD, SF.idleB], [2100, 2100]), motion: { breathe: 0.034, breatheHz: 0.1 } }),
    wake: clip({ steps: skinSteps([SF.idleD, SF.idleC, SF.idleB, SF.idleA], [430, 650, 250, 320]), loop: false, next: 'idle', motion: { bob: 1.6, bobHz: 0.55, breathe: 0.028, breatheHz: 0.55 } }),
  });
}

export const PET_SKIN_MOTION_CLIPS = Object.freeze(Object.fromEntries(
  [...PREMIUM_SKIN_IDS].map((skinId) => [skinId, buildPremiumClips(skinId)]),
));

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

export function getPetClip(state, skinId = 'classic') {
  const clips = PET_SKIN_MOTION_CLIPS[skinId] || PET_MOTION_CLIPS;
  return clips[state] || clips.idle;
}

/** True when a clip repeats forever; one-shot clips report their own ending. */
export function isPetClipLooping(state, skinId = 'classic') {
  return getPetClip(state, skinId).loop;
}

/** Total runtime of one pass through a clip. */
export function getClipDuration(state, skinId = 'classic') {
  return getPetClip(state, skinId).steps.reduce((total, step) => total + step.hold, 0);
}

/** Timeline step shown `elapsed` ms into a clip, including its optional atlas. */
export function getClipStep(state, elapsed = 0, skinId = 'classic') {
  const { steps, loop } = getPetClip(state, skinId);
  const duration = steps.reduce((total, step) => total + step.hold, 0);
  const time = Math.max(0, Number(elapsed) || 0);
  if (!loop && time >= duration) return steps[steps.length - 1];
  let cursor = loop ? time % duration : time;
  for (const step of steps) {
    if (cursor < step.hold) return step;
    cursor -= step.hold;
  }
  return steps[steps.length - 1];
}

export function getClipFrame(state, elapsed = 0, skinId = 'classic') {
  return getClipStep(state, elapsed, skinId).frame;
}

/** Sub-frame rig offsets: lift, rock and breath at `elapsed` ms into a clip. */
export function getClipOffsets(state, elapsed = 0, skinId = 'classic') {
  const { bob, bobHz, tilt, tiltHz, breathe, breatheHz } = getPetClip(state, skinId).motion;
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
  let skinId = PREMIUM_SKIN_IDS.has(options.skinId) ? options.skinId : 'classic';
  let state = PET_MOTION_STATES.includes(options.initialState) ? options.initialState : 'idle';
  let startedAt = 0;
  let frameRequest = 0;
  let paintedFrame = '';
  let announcedEnd = false;
  let destroyed = false;

  function paintFrame(frame, sheet = null) {
    const paintKey = `${sheet || ''}:${frame}`;
    if (paintKey === paintedFrame) return;
    paintedFrame = paintKey;
    const position = getPetFramePosition(frame);
    host.dataset.petFrame = String(frame);
    if (sheet) host.dataset.petSheet = sheet;
    else delete host.dataset.petSheet;
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
    const step = getClipStep(state, elapsed, skinId);
    paintFrame(step.frame, step.sheet);
    paintOffsets(getClipOffsets(state, elapsed, skinId));
    const clipState = state;
    if (!getPetClip(state, skinId).loop && !announcedEnd && elapsed >= getClipDuration(state, skinId)) {
      announcedEnd = true;
      onClipEnd?.(clipState, getPetClip(clipState, skinId).next);
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
    const target = PET_MOTION_STATES.includes(next) ? next : 'idle';
    if (!restart && target === state) return;
    state = target;
    startedAt = 0;
    announcedEnd = false;
    paintedFrame = '';
    host.dataset.petClip = state;
    stop();
    const step = getClipStep(state, 0, skinId);
    paintFrame(step.frame, step.sheet);
    paintOffsets(getClipOffsets(state, 0, skinId));
    start();
  }

  function onMotionPreference(event) {
    reduced = event.matches;
    host.dataset.motion = reduced ? 'reduced' : 'active';
    if (reduced) {
      stop();
      paintOffsets(getClipOffsets(state, 0, skinId));
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
    setSkin(nextSkinId) {
      skinId = PREMIUM_SKIN_IDS.has(nextSkinId) ? nextSkinId : 'classic';
      host.dataset.petSkin = skinId;
      play('idle');
    },
    get state() { return state; },
    get skin() { return skinId; },
    destroy() {
      destroyed = true;
      stop();
      motionQuery.removeEventListener('change', onMotionPreference);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
