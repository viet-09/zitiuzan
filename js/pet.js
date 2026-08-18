// js/pet.js
// Minimal streak companion: a small emoji that bobs/wanders in a corner.
// No illustration — species preference is stored inside the existing
// settings object so changing it never overwrites unrelated settings.

import { getSettings, setSettings } from './store.js';

export const PET_UPDATED_EVENT = 'n2:pet-updated';
export const PET_COMPLETION_EVENT = 'n2:lesson-complete';
export const PET_CONTEXT_EVENT = 'n2:pet-context';
export const PET_MEMORY_STORAGE_KEY = 'n2_pet_memories_v1';

export const PET_TYPES = Object.freeze([
  Object.freeze({ id: 'fox', label: 'Cáo', sound: 'Rúc!', emoji: '🦊' }),
  Object.freeze({ id: 'rabbit', label: 'Thỏ', sound: 'Chít!', emoji: '🐰' }),
]);

export const PET_ACCESSORIES = Object.freeze([
  Object.freeze({ id: 'none', label: 'Không phụ kiện', symbol: '', minMastered: 0 }),
  Object.freeze({ id: 'pencil', label: 'Bút chì chăm học', symbol: '✏️', minMastered: 1 }),
  Object.freeze({ id: 'seal', label: 'Dấu son tiến bộ', symbol: '🔖', minMastered: 5 }),
  Object.freeze({ id: 'lamp', label: 'Đèn học bền bỉ', symbol: '🏮', minMastered: 15 }),
]);

const DEFAULT_PET = Object.freeze({ petType: 'fox', petAccessory: 'none' });
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
    petAccessory: lookup(PET_ACCESSORIES, source.petAccessory || DEFAULT_PET.petAccessory).id,
  };
}

export function setPetPreferences(patch) {
  const current = getPetPreferences();
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = {
    petType: lookup(PET_TYPES, source.petType || current.petType).id,
    petAccessory: lookup(PET_ACCESSORIES, source.petAccessory || current.petAccessory).id,
  };
  setSettings(next);

  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(PET_UPDATED_EVENT, { detail: { ...next } }));
  }
  return next;
}

export function getPetMastery(reviews = []) {
  const mastered = (Array.isArray(reviews) ? reviews : []).filter((review) => (
    (Number(review?.lapses) || 0) > 0
    && review?.lastResult === 'correct'
    && (Number(review?.intervalDays) || 0) >= 7
  ));
  return {
    mastered: mastered.length,
    balancedSkills: new Set(mastered.map((review) => review.categoryId).filter(Boolean)).size,
  };
}

/** Three calm evolution stages based on repaired mistakes and skill balance. */
export function getPetEvolution(reviews = []) {
  const mastery = getPetMastery(reviews);
  if (mastery.mastered >= 20 && mastery.balancedSkills >= 4) {
    return { id: 'mentor', label: 'Người dẫn đường', ...mastery };
  }
  if (mastery.mastered >= 5 && mastery.balancedSkills >= 2) {
    return { id: 'companion', label: 'Bạn học vững vàng', ...mastery };
  }
  return { id: 'hatchling', label: 'Bạn học mới', ...mastery };
}

const CATEGORY_LABELS = Object.freeze({
  kanji: 'hán tự', vocabulary: 'từ vựng', grammar: 'ngữ pháp', reading: 'đọc hiểu', listening: 'nghe hiểu',
});

/** Turn the learning engine snapshot into one emotionally supportive quest. */
export function buildPetCoachState({ dailyPlan = [], weaknessProfile = {}, miniTest = [], readiness = {}, reviews = [] } = {}) {
  const evolution = getPetEvolution(reviews);
  const due = Math.max(0, Number(weaknessProfile?.due) || 0);
  const total = Math.max(0, Number(weaknessProfile?.total) || 0);
  const weakest = weaknessProfile?.top?.[0]?.categoryId || readiness?.weakestCategory || '';
  const skill = CATEGORY_LABELS[weakest] || 'N2';
  if (miniTest.length && (due || total)) {
    const count = due || total;
    return {
      mood: 'focused',
      moodLabel: 'Đang cầm thẻ lỗi',
      evolution,
      quest: {
        title: due ? 'Ưu tiên ôn đúng hạn' : 'Củng cố điểm yếu',
        reason: `${count} lỗi ${skill} ${due ? 'đang đến hạn' : 'đã sẵn sàng luyện lại'}.`,
        label: 'Ôn 3 phút',
        route: '#/review',
      },
    };
  }
  const next = dailyPlan.find((item) => item?.type === 'lesson');
  if (next?.lessonId) {
    return {
      mood: 'ready',
      moodLabel: 'Sẵn sàng học cùng bạn',
      evolution,
      quest: {
        title: next.title || 'Bài tiếp theo',
        reason: `Một bước ngắn cho ${CATEGORY_LABELS[next.categoryId] || 'N2'} hôm nay.`,
        label: 'Mở bài',
        route: `#/lesson/${encodeURIComponent(next.lessonId)}`,
      },
    };
  }
  return {
    mood: 'resting',
    moodLabel: 'Đang đọc sách',
    evolution,
    quest: {
      title: 'Hôm nay đã nhẹ nhàng hoàn tất',
      reason: 'Nghỉ ngơi cũng là một phần của việc học bền vững.',
      label: 'Xem tiến độ',
      route: '#/',
    },
  };
}

export function getPetMemories(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PET_MEMORY_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object').slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function recordPetMemory(memory, storage = globalThis.localStorage) {
  const title = String(memory?.title || '').trim().slice(0, 120);
  if (!title) return getPetMemories(storage);
  const entry = {
    id: String(memory?.id || `${memory?.type || 'memory'}:${new Date().toISOString().slice(0, 10)}:${title}`),
    type: String(memory?.type || 'milestone').slice(0, 32),
    title,
    detail: String(memory?.detail || '').trim().slice(0, 240),
    createdAt: new Date(memory?.createdAt || Date.now()).toISOString(),
  };
  const next = [entry, ...getPetMemories(storage).filter((item) => item.id !== entry.id)].slice(0, 20);
  try { storage?.setItem(PET_MEMORY_STORAGE_KEY, JSON.stringify(next)); } catch { /* best effort */ }
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
    petAccessory: lookup(PET_ACCESSORIES, options.petAccessory || DEFAULT_PET.petAccessory).id,
  };
  const streak = safeStreak(options.streak);
  const tier = getPetTier(streak);
  const type = lookup(PET_TYPES, preferences.petType);
  const accessory = lookup(PET_ACCESSORIES, preferences.petAccessory);
  const evolutionId = ['hatchling', 'companion', 'mentor'].includes(options.evolutionId) ? options.evolutionId : 'hatchling';
  const decorative = options.decorative === true;
  const label = `${type.label} ${tier.label.toLocaleLowerCase('vi-VN')}`;
  const accessibility = decorative ? 'aria-hidden="true"' : `role="img" aria-label="${escapeHtml(label)}"`;

  return `<span class="pet-emoji pet--${type.id} pet--tier-${tier.id} pet--evolution-${evolutionId}" ${accessibility}>${type.emoji}${accessory.symbol ? `<span class="pet-accessory" aria-hidden="true">${accessory.symbol}</span>` : ''}</span>`;
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
  let coach = buildPetCoachState(options.coach || {});
  let panelOpen = false;
  let reactionTimer = null;
  let statusTimer = null;
  let destroyed = false;

  const statusId = `pet-widget-status-${sequence}`;

  function render() {
    if (destroyed) return;
    const tier = getPetTier(streak);
    const type = lookup(PET_TYPES, preferences.petType);
    const panelId = `pet-coach-panel-${sequence}`;
    mount.innerHTML = `
      <div class="pet-widget" data-tier="${escapeHtml(tier.id)}" data-mood="${escapeHtml(coach.mood)}" data-evolution="${escapeHtml(coach.evolution.id)}">
        <p id="${statusId}" class="pet-widget__bubble" role="status" aria-live="polite"></p>
        <section id="${panelId}" class="pet-coach-panel" role="region" aria-label="Nhiệm vụ của bạn đồng hành"${panelOpen ? '' : ' hidden'}>
          <p class="pet-coach-panel__eyebrow">${escapeHtml(coach.moodLabel)} · ${escapeHtml(coach.evolution.label)}</p>
          <h2>${escapeHtml(coach.quest.title)}</h2>
          <p>${escapeHtml(coach.quest.reason)}</p>
          <button type="button" class="complete-modal-btn" data-pet-quest="${escapeHtml(coach.quest.route)}">${escapeHtml(coach.quest.label)}</button>
        </section>
        <button type="button" class="pet-widget__button" aria-label="${panelOpen ? 'Đóng' : 'Mở'} coach học tập — ${escapeHtml(type.label)} ${escapeHtml(coach.moodLabel.toLocaleLowerCase('vi-VN'))}" aria-expanded="${panelOpen}" aria-controls="${panelId}" aria-describedby="${statusId}">
          <span class="pet-widget__stage">${renderPet({ ...preferences, streak, evolutionId: coach.evolution.id, decorative: true })}</span>
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
    const quest = event.target.closest('[data-pet-quest]');
    if (quest?.dataset.petQuest) {
      panelOpen = false;
      location.hash = quest.dataset.petQuest;
      return;
    }
    if (event.target.closest('.pet-widget__button')) {
      panelOpen = !panelOpen;
      render();
    }
  }

  function onDocumentClick(event) {
    const cameFromPet = typeof event.composedPath === 'function'
      ? event.composedPath().includes(mount)
      : mount.contains(event.target);
    if (!panelOpen || cameFromPet) return;
    panelOpen = false;
    render();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !panelOpen) return;
    panelOpen = false;
    render();
    mount.querySelector('.pet-widget__button')?.focus();
  }

  function onScroll() {
    host.classList.toggle('is-compact', (window.scrollY || 0) > 80);
  }

  function onPreferencesUpdated(event) {
    preferences = getPetPreferences(event.detail);
    render();
  }

  function onContextUpdated(event) {
    coach = buildPetCoachState(event.detail || {});
    render();
  }

  function onLessonCompleted(event) {
    if (event.detail?.done === false) return;
    const incomingStreak = event.detail?.streak;
    const tierBefore = getPetTier(streak).id;
    if (incomingStreak != null) streak = safeStreak(incomingStreak);
    recordPetMemory({
      id: `lesson:${event.detail?.id || 'unknown'}`,
      type: 'lesson',
      title: 'Hoàn thành một bài học',
      detail: event.detail?.id ? `Bài ${event.detail.id}` : '',
    });
    render();
    react(getPetTier(streak).id !== tierBefore ? 'tier-up' : 'complete');
  }

  mount.addEventListener('click', onClick);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener(PET_UPDATED_EVENT, onPreferencesUpdated);
  window.addEventListener(PET_COMPLETION_EVENT, onLessonCompleted);
  window.addEventListener(PET_CONTEXT_EVENT, onContextUpdated);
  render();
  onScroll();

  return {
    element: mount,
    react,
    update(next = {}) {
      if (Object.prototype.hasOwnProperty.call(next, 'streak')) streak = safeStreak(next.streak);
      if (next.petType) {
        preferences = { ...preferences, petType: lookup(PET_TYPES, next.petType).id };
      }
      if (next.petAccessory) preferences = { ...preferences, petAccessory: lookup(PET_ACCESSORIES, next.petAccessory).id };
      if (next.coach) coach = buildPetCoachState(next.coach);
      render();
    },
    destroy() {
      destroyed = true;
      if (reactionTimer) window.clearTimeout(reactionTimer);
      if (statusTimer) window.clearTimeout(statusTimer);
      mount.removeEventListener('click', onClick);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener(PET_UPDATED_EVENT, onPreferencesUpdated);
      window.removeEventListener(PET_COMPLETION_EVENT, onLessonCompleted);
      window.removeEventListener(PET_CONTEXT_EVENT, onContextUpdated);
      mount.remove();
    },
  };
}
