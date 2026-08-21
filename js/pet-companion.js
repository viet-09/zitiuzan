// Pixel desktop-companion runtime. The DOM remains transparent outside the
// character controls, so the pet can wander without blocking study UI.

import {
  PET_COMPANION_STATES,
  PET_RESTING_STATES,
  choosePetWaypoint,
  chooseNextPetState,
  clampPetPosition,
  getContextualPetAdvice,
  getPetBounds,
  getPetStatePath,
} from './pet-companion-state.js?v=18';
import { getClipDuration, isPetClipLooping, mountPetMotion } from './pet-motion.js?v=18';

const POSITION_STORAGE_KEY = 'n2_pet_position_v1';
const BOTTOM_INSET = 74;
const PANEL_WIDTH = 300;
const TOP_INSET = 56;

// How long a looping action runs before the scheduler picks the next one.
// One-shot clips (look, play, cheer, settle, wake) end themselves.
const LOOP_DURATION = Object.freeze({
  idle: 5200,
  drowsy: 7400,
  sleep: 9000,
  doze: 12_000,
});

// Poses passed through on the way to a state are held only briefly.
const LINK_DURATION = 260;

function storedPosition(storage) {
  try {
    const value = JSON.parse(storage?.getItem(POSITION_STORAGE_KEY) || 'null');
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return value;
  } catch { /* use the calm default position */ }
  return null;
}

function savePosition(storage, position) {
  try { storage?.setItem(POSITION_STORAGE_KEY, JSON.stringify(position)); } catch { /* best effort */ }
}

/** Mount autonomous states, contextual advice, roaming and pointer dragging. */
export function mountPetCompanion(host, options = {}) {
  if (!(host instanceof HTMLElement)) return null;
  const owner = options.mount instanceof HTMLElement ? options.mount : host.closest('.streak-pet-mount');
  if (!owner) return null;

  const random = typeof options.random === 'function' ? options.random : Math.random;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionQuery.matches;
  let coach = options.coach || {};
  let state = 'idle';
  let stateTimer = 0;
  let queuedPath = [];
  let pendingAnnounce = false;
  let pendingRestart = false;
  let destroyed = false;
  let suppressClickUntil = 0;
  let panelOpen = false;
  let drag = null;
  let facing = 'right';
  let lastInteraction = now();

  function petSize() {
    const rect = owner.getBoundingClientRect();
    return { width: rect.width || 56, height: rect.height || 83 };
  }

  function travelOptions() {
    return {
      bottomInset: BOTTOM_INSET,
      topInset: TOP_INSET,
      rightPanelWidth: panelOpen ? PANEL_WIDTH : 0,
    };
  }

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function bounds() {
    return getPetBounds(viewport(), petSize(), travelOptions());
  }

  function boundedPosition(next) {
    return clampPetPosition(next, viewport(), petSize(), travelOptions());
  }

  function defaultPosition() {
    const area = bounds();
    return { x: area.minX + 6, y: area.maxY };
  }

  let position = boundedPosition(storedPosition(window.localStorage) || defaultPosition());

  function setFacing(next) {
    facing = next === 'left' ? 'left' : 'right';
    host.dataset.facing = facing;
  }

  function applyPosition(duration = 0) {
    position = boundedPosition(position);
    owner.style.setProperty('--pet-travel-duration', `${Math.max(0, duration)}ms`);
    owner.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  function clearStateTimer() {
    if (!stateTimer) return;
    window.clearTimeout(stateTimer);
    stateTimer = 0;
  }

  function scheduleNext(delay) {
    clearStateTimer();
    if (destroyed || reducedMotion || drag) return;
    stateTimer = window.setTimeout(() => advance(), Math.max(0, delay));
  }

  function idleMs() {
    return Math.max(0, now() - lastInteraction);
  }

  function roam() {
    const waypoint = choosePetWaypoint(position, bounds(), { random, facing });
    setFacing(waypoint.facing);
    position = { x: waypoint.x, y: waypoint.y };
    applyPosition(waypoint.duration);
    return waypoint.duration;
  }

  /** Play one action now. `walk` also books the stroll it animates through. */
  function enterState(next, { announce = false, restart = false } = {}) {
    const previous = state;
    state = PET_COMPANION_STATES.includes(next) ? next : 'idle';
    host.dataset.petState = state;
    host.dataset.resting = PET_RESTING_STATES.includes(state) ? 'true' : 'false';
    // Two scheduler turns on the same action keep one flowing loop; only a real
    // interaction replays a clip the pet is already in.
    spriteMotion?.play(state, { restart: restart || state !== previous });
    if (announce) options.onAdvice?.(getContextualPetAdvice(coach, random()));

    if (reducedMotion) {
      applyPosition(0);
      return;
    }
    if (state === 'walk') {
      scheduleNext(roam() + 140);
      return;
    }
    applyPosition(0);
    // A one-shot clip normally reports its own ending; the timer is the safety
    // net for when frames are throttled, so the pet can never freeze mid-action.
    scheduleNext(LOOP_DURATION[state] || getClipDuration(state) + 400);
  }

  /** Step the behaviour forward: finish a queued pose chain, else pick anew. */
  function advance(preferred) {
    if (destroyed || reducedMotion || drag) return;
    if (queuedPath.length) {
      const step = queuedPath.shift();
      const isFinalStep = queuedPath.length === 0;
      const restart = pendingRestart;
      pendingRestart = false;
      enterState(step, { announce: isFinalStep && pendingAnnounce, restart });
      if (isFinalStep) pendingAnnounce = false;
      else if (isPetClipLooping(step)) scheduleNext(LINK_DURATION);
      return;
    }
    const next = preferred && PET_COMPANION_STATES.includes(preferred)
      ? preferred
      : chooseNextPetState(state, { idleMs: idleMs(), random });
    enterState(next, { announce: next === 'play' || next === 'cheer' });
  }

  /** Reach a state through the shortest valid pose chain — never by cutting. */
  function transitionTo(target, { announce = false } = {}) {
    clearStateTimer();
    const path = getPetStatePath(state, target).slice(1);
    queuedPath = path.length ? path : [target];
    pendingAnnounce = announce;
    pendingRestart = true;
    advance();
  }

  const spriteMotion = mountPetMotion(host, {
    initialState: state,
    onClipEnd: (finished, next) => {
      // A one-shot clip stopped animating; hand back to the scheduler instead
      // of letting the pet freeze on its last pose.
      if (destroyed || drag || finished !== state) return;
      advance(next);
    },
  });

  function noteInteraction() {
    lastInteraction = now();
  }

  function finishDrag(event) {
    if (!drag || (event.pointerId != null && event.pointerId !== drag.pointerId)) return;
    const moved = drag.moved;
    drag = null;
    owner.classList.remove('is-dragging');
    if (moved) {
      suppressClickUntil = Date.now() + 420;
      savePosition(window.localStorage, position);
    }
    noteInteraction();
    transitionTo('look');
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !event.target.closest('[data-pet-interaction], [data-pet-direct-interaction]')) return;
    clearStateTimer();
    queuedPath = [];
    pendingRestart = false;
    noteInteraction();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...position },
      moved: false,
    };
    owner.classList.add('is-dragging');
    owner.style.setProperty('--pet-travel-duration', '0ms');
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.hypot(deltaX, deltaY) > 6) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    position = boundedPosition({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY });
    applyPosition(0);
  }

  function onMotionPreference(event) {
    reducedMotion = event.matches;
    host.dataset.motion = reducedMotion ? 'reduced' : 'active';
    clearStateTimer();
    queuedPath = [];
    enterState('idle');
    if (!reducedMotion) scheduleNext(LOOP_DURATION.idle);
  }

  function onResize() {
    applyPosition(0);
  }

  host.dataset.renderer = 'pixel-sprite';
  host.dataset.petState = state;
  host.dataset.resting = 'false';
  host.dataset.motion = reducedMotion ? 'reduced' : 'active';
  host.dataset.companionReady = 'true';
  setFacing('right');
  owner.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
  motionQuery.addEventListener('change', onMotionPreference);
  window.addEventListener('resize', onResize);
  applyPosition(0);
  if (!reducedMotion) scheduleNext(2600 + Math.round(random() * 2400));

  return {
    react(kind) {
      noteInteraction();
      transitionTo({
        pat: 'look',
        tease: 'play',
        highfive: 'cheer',
        complete: 'cheer',
        'tier-up': 'cheer',
      }[kind] || 'look');
    },
    updateCoach(nextCoach = {}) {
      coach = nextCoach;
    },
    setPanelOpen(next) {
      panelOpen = Boolean(next);
      applyPosition(220);
    },
    shouldSuppressClick() {
      return Date.now() < suppressClickUntil;
    },
    destroy() {
      destroyed = true;
      clearStateTimer();
      owner.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', finishDrag);
      document.removeEventListener('pointercancel', finishDrag);
      motionQuery.removeEventListener('change', onMotionPreference);
      window.removeEventListener('resize', onResize);
      spriteMotion?.destroy();
      owner.classList.remove('is-dragging');
    },
  };
}
