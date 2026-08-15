// js/pet.js
// Minimal streak companion: a small emoji that bobs/wanders in a corner.
// No illustration — species preference is stored inside the existing
// settings object so changing it never overwrites unrelated settings.

import { getSettings, setSettings } from './store.js';

export const PET_UPDATED_EVENT = 'n2:pet-updated';
export const PET_COMPLETION_EVENT = 'n2:lesson-complete';

export const PET_TYPES = Object.freeze([
  Object.freeze({ id: 'fox', label: 'Cáo', sound: 'Rúc!', emoji: '🦊' }),
  Object.freeze({ id: 'rabbit', label: 'Thỏ', sound: 'Chít!', emoji: '🐰' }),
]);

const DEFAULT_PET = Object.freeze({ petType: 'fox' });
let petSequence = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function lookup(items, id) {
  return items.find((item) => item.id === id) || items[0];
}

function safeStreak(value) {
  const streak = Number(value);
  return Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0;
}

export function getPetPreferences(settings = getSettings()) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    petType: lookup(PET_TYPES, source.petType || DEFAULT_PET.petType).id,
  };
}

export function setPetPreferences(patch) {
  const current = getPetPreferences();
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = {
    petType: lookup(PET_TYPES, source.petType || current.petType).id,
  };
  setSettings(next);

  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(PET_UPDATED_EVENT, { detail: { ...next } }));
  }
  return next;
}

/** Stable streak tiers used by both the emoji label and dashboard copy. */
export function getPetTier(streakValue) {
  const streak = safeStreak(streakValue);
  if (streak === 0) {
    return {
      id: 'sleeping',
      min: 0,
      label: 'Đang chờ bạn',
      message: 'Hoàn thành một bài để đánh thức bạn nhỏ nhé.',
    };
  }
  if (streak <= 2) {
    return {
      id: 'waking',
      min: 1,
      label: 'Vừa thức giấc',
      message: `${streak} ngày liên tiếp — khởi đầu thật ấm áp.`,
    };
  }
  if (streak <= 6) {
    return {
      id: 'happy',
      min: 3,
      label: 'Rất vui vẻ',
      message: `${streak} ngày liên tiếp — bạn nhỏ đang lớn lên cùng bạn.`,
    };
  }
  if (streak <= 13) {
    return {
      id: 'excited',
      min: 7,
      label: 'Rực rỡ',
      message: `${streak} ngày liên tiếp — cả hai đang vào guồng rồi!`,
    };
  }
  return {
    id: 'legendary',
    min: 14,
    label: 'Huyền thoại',
    message: `${streak} ngày liên tiếp — một chuỗi học đáng tự hào.`,
  };
}

/**
 * Render one small emoji glyph. All dynamic values are normalized to fixed
 * allow-lists before reaching markup.
 */
export function renderPet(options = {}) {
  const preferences = {
    petType: lookup(PET_TYPES, options.type || options.petType || DEFAULT_PET.petType).id,
  };
  const streak = safeStreak(options.streak);
  const tier = getPetTier(streak);
  const type = lookup(PET_TYPES, preferences.petType);
  const decorative = options.decorative === true;
  const label = `${type.label} ${tier.label.toLocaleLowerCase('vi-VN')}`;
  const accessibility = decorative ? 'aria-hidden="true"' : `role="img" aria-label="${escapeHtml(label)}"`;

  return `<span class="pet-emoji pet--${type.id} pet--tier-${tier.id}" ${accessibility}>${type.emoji}</span>`;
}

function resolveTarget(target) {
  if (typeof target === 'string') return document.querySelector(target);
  return target instanceof Element ? target : null;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function reactionCopy(kind, type) {
  if (kind === 'complete') return `${type.sound} Tuyệt lắm — thêm một bài đã hoàn thành!`;
  if (kind === 'tier-up') return `${type.sound} Chuỗi học vừa lên một cấp mới!`;
  return `${type.sound} Mình học tiếp cùng nhau nhé!`;
}

/** Broadcast a completion so any currently mounted dashboard pet can react. */
export function announceLessonCompleted(detail = {}) {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(PET_COMPLETION_EVENT, {
    detail: detail && typeof detail === 'object' ? { ...detail } : {},
  }));
}

/**
 * Mount the corner pet and optional accessible selectors. Returns a controller
 * with update/react/destroy methods for dashboard and lesson-completion wiring.
 */
export function mountPet(target, options = {}) {
  if (typeof document === 'undefined') return null;
  const host = resolveTarget(target);
  if (!host) return null;

  const sequence = ++petSequence;
  const mount = document.createElement('div');
  mount.className = 'streak-pet-mount';
  mount.dataset.petMount = String(sequence);
  host.appendChild(mount);

  let streak = safeStreak(options.streak);
  let preferences = getPetPreferences();
  let reactionTimer = null;
  let statusTimer = null;
  let destroyed = false;

  const statusId = `pet-widget-status-${sequence}`;

  function render() {
    if (destroyed) return;
    const tier = getPetTier(streak);
    const type = lookup(PET_TYPES, preferences.petType);
    mount.innerHTML = `
      <div class="pet-widget" data-tier="${escapeHtml(tier.id)}">
        <p id="${statusId}" class="pet-widget__bubble" role="status" aria-live="polite"></p>
        <button type="button" class="pet-widget__button" aria-label="Chơi với ${escapeHtml(type.label)} — ${escapeHtml(tier.label)}, ${streak} ngày" aria-describedby="${statusId}">
          <span class="pet-widget__stage">${renderPet({ ...preferences, streak, decorative: true })}</span>
        </button>
      </div>`;
  }

  function showBubble(text) {
    const bubble = mount.querySelector('.pet-widget__bubble');
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add('is-visible');
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      bubble.classList.remove('is-visible');
      statusTimer = null;
    }, 2600);
  }

  function react(kind = 'play') {
    if (destroyed) return;
    const type = lookup(PET_TYPES, preferences.petType);
    const stage = mount.querySelector('.pet-widget__stage');
    showBubble(reactionCopy(kind, type));

    if (reactionTimer) window.clearTimeout(reactionTimer);
    if (stage && !prefersReducedMotion()) {
      stage.classList.remove('is-reacting', 'is-celebrating');
      // Force a new animation only after an explicit user/completion event.
      void stage.offsetWidth;
      stage.classList.add(kind === 'complete' || kind === 'tier-up' ? 'is-celebrating' : 'is-reacting');
      reactionTimer = window.setTimeout(() => {
        stage.classList.remove('is-reacting', 'is-celebrating');
        reactionTimer = null;
      }, 1400);
    }
    if (typeof options.onReact === 'function') options.onReact(kind);
  }

  function onClick(event) {
    if (event.target.closest('.pet-widget__button')) react('play');
  }

  function onPreferencesUpdated(event) {
    preferences = getPetPreferences(event.detail);
    render();
  }

  function onLessonCompleted(event) {
    if (event.detail?.done === false) return;
    const incomingStreak = event.detail?.streak;
    const tierBefore = getPetTier(streak).id;
    if (incomingStreak != null) streak = safeStreak(incomingStreak);
    render();
    react(getPetTier(streak).id !== tierBefore ? 'tier-up' : 'complete');
  }

  mount.addEventListener('click', onClick);
  window.addEventListener(PET_UPDATED_EVENT, onPreferencesUpdated);
  window.addEventListener(PET_COMPLETION_EVENT, onLessonCompleted);
  render();

  return {
    element: mount,
    react,
    update(next = {}) {
      if (Object.prototype.hasOwnProperty.call(next, 'streak')) streak = safeStreak(next.streak);
      if (next.petType) {
        preferences = { petType: lookup(PET_TYPES, next.petType).id };
      }
      render();
    },
    destroy() {
      destroyed = true;
      if (reactionTimer) window.clearTimeout(reactionTimer);
      if (statusTimer) window.clearTimeout(statusTimer);
      mount.removeEventListener('click', onClick);
      window.removeEventListener(PET_UPDATED_EVENT, onPreferencesUpdated);
      window.removeEventListener(PET_COMPLETION_EVENT, onLessonCompleted);
      mount.remove();
    },
  };
}
