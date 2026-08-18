// js/profile-page.js — dedicated "account" page: avatar, name, email,
// edit-profile entry point, sign-out, pet companion customizer. Reached via
// the top-right avatar icon (see index.html #btn-account, wired in app.js)
// or #/profile directly.

import { currentUser, signInWithGoogle, signOut, ready as supabaseReady } from './supabase.js';
import { getProfile, renderAvatar, openProfileDialog } from './profile.js';
import { PET_ACCESSORIES, PET_TYPES, getPetEvolution, getPetMemories, getPetPreferences, setPetPreferences, renderPet } from './pet.js?v=10';
import { clearUserScopedStorage } from './account-storage.js';
import { learningState } from './learning-state.js';

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

function accessoryOptionsMarkup(items, selected, mastered) {
  return items.map((item) => {
    const locked = mastered < item.minMastered;
    const suffix = locked ? ` — mở khi làm chủ ${item.minMastered} lỗi` : '';
    return `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}${locked ? ' disabled' : ''}>${escapeHtml(item.label + suffix)}</option>`;
  }).join('');
}

export function renderProfilePage(root) {
  root.innerHTML = `
    <h2 class="sr-only" data-route-heading>Hồ sơ cá nhân</h2>
    <section class="profile-page" id="profile-page" aria-label="Hồ sơ cá nhân">
      <p class="dash-empty-state">Đang tải…</p>
    </section>
  `;
  paint(root.querySelector('#profile-page'));
  return { preserveScroll: false };
}

async function paint(el) {
  if (!el) return;
  await supabaseReady();
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
        <div class="pet-customizer__preview" data-pet-preview>${renderPet({ ...petPrefs, evolutionId: evolution.id, decorative: true })}</div>
        <div class="pet-customizer__fields">
          <label for="pet-customizer-type">Loài
            <select id="pet-customizer-type" data-pet-setting="petType">${optionsMarkup(PET_TYPES, petPrefs.petType)}</select>
          </label>
          <label for="pet-customizer-accessory">Phụ kiện
            <select id="pet-customizer-accessory" data-pet-setting="petAccessory">${accessoryOptionsMarkup(PET_ACCESSORIES, petPrefs.petAccessory, evolution.mastered)}</select>
          </label>
          <p class="pet-mastery"><strong>${escapeHtml(evolution.label)}</strong> · ${evolution.mastered} lỗi đã làm chủ · ${evolution.balancedSkills}/5 kỹ năng cân bằng</p>
        </div>
      </div>
      <details class="pet-memory-journal">
        <summary>Nhật ký kỷ niệm (${memories.length})</summary>
        ${memories.length ? `<ol>${memories.slice(0, 6).map((memory) => `<li><strong>${escapeHtml(memory.title)}</strong>${memory.detail ? `<span>${escapeHtml(memory.detail)}</span>` : ''}</li>`).join('')}</ol>` : '<p>Những lần hoàn thành bài và sửa được lỗi lặp sẽ xuất hiện ở đây.</p>'}
      </details>
    </section>
  `;

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
      await signOut();
      clearUserScopedStorage();
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

  el.querySelector('.pet-customizer')?.addEventListener('change', (event) => {
    const select = event.target.closest('[data-pet-setting]');
    if (!select) return;
    const next = setPetPreferences({ [select.dataset.petSetting]: select.value });
    const preview = el.querySelector('[data-pet-preview]');
    if (preview) preview.innerHTML = renderPet({ ...next, evolutionId: evolution.id, decorative: true });
  });
}
