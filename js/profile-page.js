// js/profile-page.js — dedicated "account" page: avatar, name, email,
// edit-profile entry point, sign-out, pet companion customizer. Reached via
// the top-right avatar icon (see index.html #btn-account, wired in app.js)
// or #/profile directly.

import { currentUser, signInWithGoogle, signOut, ready as supabaseReady } from './supabase.js';
import { getProfile, renderAvatar, openProfileDialog, saveProfile } from './profile.js';
import { PET_TYPES, getPetEvolution, getPetMemories, getPetPreferences, getPetSkins, setPetPreferences, renderPet } from './pet.js?v=41';
import { mountPetMotion } from './pet-motion.js?v=41';
import { clearUserScopedStorage } from './account-storage.js';
import { learningState } from './learning-state.js';
import { flushCompletionQueue, flushReviewQueue } from './sync.js';
import { clearExamSession } from './exam-session.js';

let profilePreviewMotion = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function optionsMarkup(items, selected) {
  return items.map((item) => (
    `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`
  )).join('');
}

function skinOptionsMarkup(petType, selected) {
  return getPetSkins(petType).map((skin) => `
    <label class="pet-skin-option" data-skin-tier="${escapeHtml(skin.tier.toLowerCase())}">
      <input type="radio" name="pet-skin" value="${escapeHtml(skin.id)}" data-pet-setting="petSkin"${skin.id === selected ? ' checked' : ''}>
      <span class="pet-skin-option__art" aria-hidden="true">${renderPet({ petType, petSkin: skin.id, decorative: true })}</span>
      <span class="pet-skin-option__copy"><strong>${escapeHtml(skin.label)}</strong><small>${escapeHtml(skin.tier)}</small></span>
    </label>`).join('');
}

export function renderProfilePage(root) {
  root.innerHTML = `
    <h2 class="sr-only" data-route-heading>Hồ sơ cá nhân</h2>
    <section class="profile-page" id="profile-page" aria-label="Hồ sơ cá nhân">
      <p class="dash-empty-state">Đang tải…</p>
    </section>
  `;
  paint(root.querySelector('#profile-page'));
  return {
    preserveScroll: false,
    cleanup() {
      profilePreviewMotion?.destroy();
      profilePreviewMotion = null;
    },
  };
}

async function paint(el) {
  if (!el) return;
  await supabaseReady();
  if (!el.isConnected) return;
  const user = await currentUser();
  const profile = getProfile();
  const displayName = profile.name || user?.user_metadata?.full_name || 'Học viên';
  const petPrefs = getPetPreferences();
  const evolution = getPetEvolution(learningState.getReviews());
  const memories = getPetMemories();

  el.innerHTML = `
    <header class="profile-page__head">
      <div class="profile-page__avatar">${renderAvatar(profile)}</div>
      <h1 class="section-heading">${escapeHtml(displayName)}</h1>
      ${user ? `<p class="profile-page__email">${escapeHtml(user.email || '')}</p>` : ''}
    </header>
    <div class="profile-page__actions">
      <button type="button" class="tts-btn" data-action="edit-profile">Chỉnh tên / ảnh đại diện</button>
      <button type="button" class="tts-btn back-btn" data-action="${user ? 'sign-out' : 'sign-in'}">${user ? 'Đăng xuất' : 'Đăng nhập bằng Google để đồng bộ'}</button>
    </div>

    <section class="pet-customizer" aria-labelledby="pet-customizer-heading">
      <h3 id="pet-customizer-heading" class="subheading">Bạn đồng hành</h3>
      <p class="profile-modal__help">Bạn nhỏ gợi ý đúng một việc nên làm tiếp theo và tiến hóa khi bạn sửa được lỗi thật.</p>
      <div class="pet-customizer__layout">
        <div class="pet-customizer__showcase">
          <div class="pet-customizer__preview" data-pet-preview data-pet-skin="${escapeHtml(petPrefs.petSkin)}"><span class="pixel-pet-host" data-pet-preview-art>${renderPet({ ...petPrefs, evolutionId: evolution.id, decorative: true })}</span></div>
          <div class="pet-preview-actions" aria-label="Xem trước hành động skin">
            <button type="button" data-pet-preview-action="walk">Dạo bước</button>
            <button type="button" data-pet-preview-action="signature">Múa / emote</button>
            <button type="button" data-pet-preview-action="recall">B về</button>
          </div>
          <p class="pet-preview-caption" data-pet-preview-caption>Đang đứng yên · chọn một hành động để xem.</p>
        </div>
        <div class="pet-customizer__fields">
          <label class="pet-customizer__species" for="pet-customizer-type">Loài
            <select id="pet-customizer-type" data-pet-setting="petType">${optionsMarkup(PET_TYPES, petPrefs.petType)}</select>
          </label>
          <fieldset class="pet-skin-picker">
            <legend>Ngoại trang</legend>
            <p>4 skin cao cấp lấy cảm hứng từ Yone hoặc Lux, gồm cả dáng và hiệu ứng riêng.</p>
            <div class="pet-skin-picker__grid" data-pet-skin-options>${skinOptionsMarkup(petPrefs.petType, petPrefs.petSkin)}</div>
          </fieldset>
          <p class="pet-mastery"><strong>${escapeHtml(evolution.label)}</strong> · ${evolution.mastered} lỗi đã làm chủ · ${evolution.balancedSkills}/5 kỹ năng cân bằng</p>
        </div>
      </div>
      <details class="pet-memory-journal">
        <summary>Nhật ký kỷ niệm (${memories.length})</summary>
        ${memories.length ? `<ol>${memories.slice(0, 6).map((memory) => `<li><strong>${escapeHtml(memory.title)}</strong>${memory.detail ? `<span>${escapeHtml(memory.detail)}</span>` : ''}</li>`).join('')}</ol>` : '<p>Những lần hoàn thành bài và sửa được lỗi lặp sẽ xuất hiện ở đây.</p>'}
      </details>
    </section>
  `;

  profilePreviewMotion?.destroy();
  const preview = el.querySelector('[data-pet-preview]');
  profilePreviewMotion = mountPetMotion(preview, {
    initialState: 'idle',
    skinId: petPrefs.petSkin,
    onClipEnd: () => profilePreviewMotion?.play('idle'),
  });

  el.querySelector('[data-action="edit-profile"]')?.addEventListener('click', (event) => {
    openProfileDialog({
      trigger: event.currentTarget,
      onSave: () => paint(el),
    });
  });

  el.querySelector('[data-action="sign-out"]')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      // Push anything still waiting in the offline queues before the session
      // and its local copies disappear. Signing out used to clear these
      // outright, so a lesson completed on a flaky connection could be lost
      // without a word. If a flush fails the queues survive in localStorage
      // and are retried on the next sign-in, so the sign-out still proceeds.
      const user = await currentUser();
      if (user?.id) {
        try {
          await flushCompletionQueue(user.id);
          await flushReviewQueue(user.id);
        } catch (syncErr) {
          console.warn('[profile] pending sync could not be flushed:', syncErr);
        }
      }
      await signOut();
      clearUserScopedStorage();
      // A leftover sessionStorage snapshot from a previous sitting would otherwise
      // be offered to the next (possibly different) learner on this browser.
      try { clearExamSession(); } catch { /* sessionStorage may be blocked */ }
      // Full reload so the mandatory sign-in gate re-runs from a clean state.
      location.hash = '#/';
      location.reload();
    } catch (err) {
      console.warn('[profile] sign-out failed:', err);
      btn.disabled = false;
    }
  });

  el.querySelector('[data-action="sign-in"]')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      await signInWithGoogle();
    } catch (err) {
      console.warn('[profile] sign-in failed:', err);
      btn.disabled = false;
    }
  });

  el.querySelector('.pet-customizer')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-pet-preview-action]')?.dataset.petPreviewAction;
    if (!action) return;
    profilePreviewMotion?.play(action);
    const caption = el.querySelector('[data-pet-preview-caption]');
    if (caption) caption.textContent = {
      walk: 'Dáng di chuyển riêng của ngoại trang.',
      signature: 'Điệu múa / emote đặc trưng của ngoại trang.',
      recall: 'Chuỗi B về riêng gồm 4 hồi và 64 khung chuyển động.',
    }[action];
  });

  el.querySelector('.pet-customizer')?.addEventListener('change', (event) => {
    const select = event.target.closest('[data-pet-setting]');
    if (!select) return;
    const next = setPetPreferences({ [select.dataset.petSetting]: select.value });
    if (select.dataset.petSetting === 'petType') {
      const currentProfile = getProfile();
      if (currentProfile.avatarType === 'preset') {
        saveProfile({ ...currentProfile, avatarData: next.petType });
        const pageAvatar = el.querySelector('.profile-page__avatar');
        if (pageAvatar) pageAvatar.innerHTML = renderAvatar(getProfile());
      }
      const skinOptions = el.querySelector('[data-pet-skin-options]');
      if (skinOptions) skinOptions.innerHTML = skinOptionsMarkup(next.petType, next.petSkin);
    }
    const preview = el.querySelector('[data-pet-preview]');
    if (preview) {
      preview.dataset.petSkin = next.petSkin;
      const previewArt = preview.querySelector('[data-pet-preview-art]');
      if (previewArt) previewArt.innerHTML = renderPet({ ...next, evolutionId: evolution.id, decorative: true });
    }
    profilePreviewMotion?.setSkin(next.petSkin);
    const caption = el.querySelector('[data-pet-preview-caption]');
    if (caption) caption.textContent = 'Đang đứng yên · chọn một hành động để xem.';
  });
}
