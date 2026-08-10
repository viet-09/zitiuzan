// js/profile-page.js — dedicated "account" page: avatar, name, email,
// edit-profile entry point, sign-out. Reached via the top-right avatar icon
// (see index.html #btn-account, wired in app.js) or #/profile directly.

import { currentUser, signOut, ready as supabaseReady } from './supabase.js';
import { getProfile, renderAvatar, openProfileDialog } from './profile.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
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

  el.innerHTML = `
    <header class="profile-page__head">
      <div class="profile-page__avatar">${renderAvatar(profile)}</div>
      <h1 class="section-heading">${escapeHtml(displayName)}</h1>
      ${user ? `<p class="profile-page__email">${escapeHtml(user.email || '')}</p>` : ''}
    </header>
    <div class="profile-page__actions">
      <button type="button" class="tts-btn" data-action="edit-profile">Chỉnh tên / ảnh đại diện</button>
      <button type="button" class="tts-btn back-btn" data-action="sign-out">Đăng xuất</button>
    </div>
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
      // Full reload so the mandatory sign-in gate re-runs from a clean state.
      location.hash = '#/';
      location.reload();
    } catch (err) {
      console.warn('[profile] sign-out failed:', err);
      btn.disabled = false;
    }
  });
}
