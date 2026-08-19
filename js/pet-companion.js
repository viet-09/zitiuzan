// Pixel desktop-companion runtime. The DOM remains transparent outside the
// character controls, so the pet can wander without blocking study UI.

import {
  PET_COMPANION_STATES,
  chooseNextPetState,
  clampPetPosition,
  getContextualPetAdvice,
} from './pet-companion-state.js?v=12';

const POSITION_STORAGE_KEY = 'n2_pet_position_v1';
const STATE_DURATION = Object.freeze({
  idle: 6200,
  look: 3200,
  walk: 5200,
  sleep: 5400,
  'deep-sleep': 6200,
  advice: 4800,
});

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
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionQuery.matches;
  let coach = options.coach || {};
  let state = 'idle';
  let stateTimer = 0;
  let destroyed = false;
  let suppressClickUntil = 0;
  let panelOpen = false;
  let drag = null;

  function petSize() {
    const rect = owner.getBoundingClientRect();
    return { width: rect.width || 124, height: rect.height || 184 };
  }

  function defaultPosition() {
    const size = petSize();
    return {
      x: 14,
      y: Math.max(8, window.innerHeight - size.height - 88),
    };
  }

  let position = storedPosition(window.localStorage) || defaultPosition();

  function boundedPosition(next = position, overrides = {}) {
    return clampPetPosition(next, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, petSize(), {
      bottomInset: 74,
      rightPanelWidth: panelOpen ? 300 : 0,
      ...overrides,
    });
  }

  function applyPosition(duration = 0) {
    position = boundedPosition();
    owner.style.setProperty('--pet-travel-duration', `${Math.max(0, duration)}ms`);
    owner.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  function clearStateTimer() {
    if (!stateTimer) return;
    window.clearTimeout(stateTimer);
    stateTimer = 0;
  }

  function scheduleNext(delay = STATE_DURATION[state]) {
    clearStateTimer();
    if (destroyed || reducedMotion || drag) return;
    stateTimer = window.setTimeout(() => {
      const next = chooseNextPetState(state, random());
      setState(next, { announce: next === 'advice' });
    }, delay);
  }

  function roam(duration) {
    const size = petSize();
    const maxX = Math.max(14, window.innerWidth - size.width - 18);
    const direction = random() > 0.5 ? 1 : -1;
    const distance = 72 + Math.round(random() * Math.min(220, window.innerWidth * 0.28));
    position = boundedPosition({ ...position, x: position.x + direction * distance });
    if (position.x <= 0 || position.x >= maxX - 2) host.dataset.facing = direction > 0 ? 'left' : 'right';
    else host.dataset.facing = direction > 0 ? 'right' : 'left';
    applyPosition(duration);
  }

  function setState(next, { announce = false } = {}) {
    state = PET_COMPANION_STATES.includes(next) ? next : 'idle';
    host.dataset.petState = state;
    host.dataset.motion = reducedMotion ? 'reduced' : 'active';
    if (reducedMotion) {
      state = 'idle';
      host.dataset.petState = state;
      applyPosition(0);
      return;
    }
    const duration = STATE_DURATION[state];
    if (state === 'walk') roam(duration - 300);
    else applyPosition(180);
    if (announce) options.onAdvice?.(getContextualPetAdvice(coach, random()));
    scheduleNext(duration);
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
    setState('idle');
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !event.target.closest('[data-pet-interaction], [data-pet-direct-interaction]')) return;
    clearStateTimer();
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
    position = boundedPosition({
      x: drag.origin.x + deltaX,
      y: drag.origin.y + deltaY,
    });
    applyPosition(0);
  }

  function onMotionPreference(event) {
    reducedMotion = event.matches;
    clearStateTimer();
    setState('idle');
    if (!reducedMotion) scheduleNext(5600);
  }

  function onResize() {
    applyPosition(0);
  }

  host.dataset.renderer = 'pixel-sprite';
  host.dataset.petState = state;
  host.dataset.motion = reducedMotion ? 'reduced' : 'active';
  host.dataset.facing = 'right';
  host.dataset.companionReady = 'true';
  owner.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
  motionQuery.addEventListener('change', onMotionPreference);
  window.addEventListener('resize', onResize);
  applyPosition(0);
  if (!reducedMotion) scheduleNext(6200 + Math.round(random() * 2800));

  return {
    react(kind) {
      clearStateTimer();
      const mapped = {
        pat: 'look',
        tease: 'walk',
        highfive: 'advice',
        complete: 'advice',
        'tier-up': 'advice',
      }[kind] || 'look';
      setState(mapped);
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
      owner.classList.remove('is-dragging');
    },
  };
}
