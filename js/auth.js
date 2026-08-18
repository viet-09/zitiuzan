// js/auth.js
// First-run account choice. Google unlocks cloud sync and rankings, while
// guest mode keeps the complete core curriculum available on this device.

import { signInWithGoogle } from './supabase.js';
import { guestPreference } from './guest-mode.js';

let activeDialog = null;
let dialogSequence = 0;

/**
 * Open the mandatory sign-in gate. Returns `{ close() }` (used only once
 * sign-in redirects away), or the already-open controller if one is active.
 */
export function openSignInGate(options = {}) {
  if (typeof document === 'undefined') return null;
  if (activeDialog) return activeDialog;

  const sequence = ++dialogSequence;
  const titleId = `signin-gate-title-${sequence}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay auth-modal active';
  overlay.innerHTML = `
    <section class="modal-card auth-modal__card" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="modal-header">
        <h2 id="${titleId}">Bắt đầu học N2</h2>
      </header>
      <div class="modal-body">
        <p class="profile-modal__help">Đăng nhập Google để đồng bộ tiến độ và bảng xếp hạng, hoặc dùng thử trên thiết bị này mà không cần tài khoản.</p>
        <button type="button" class="auth-pill auth-modal__google" data-gate-action="google">Đăng nhập bằng Google</button>
        <button type="button" class="tts-btn back-btn auth-modal__guest" data-gate-action="guest">Dùng thử không đăng nhập</button>
        <p class="profile-status" data-gate-status role="status" aria-live="polite"></p>
      </div>
    </section>`;

  document.body.appendChild(overlay);
  const backgroundState = Array.from(document.body.children)
    .filter((element) => element !== overlay && element instanceof HTMLElement)
    .map((element) => ({
      element,
      inert: Boolean(element.inert),
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
  backgroundState.forEach(({ element }) => {
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  });

  const status = overlay.querySelector('[data-gate-status]');
  const googleBtn = overlay.querySelector('[data-gate-action="google"]');
  const guestBtn = overlay.querySelector('[data-gate-action="guest"]');
  let closed = false;

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.classList.toggle('is-error', kind === 'error');
  }

  function closeDialog() {
    if (closed) return;
    closed = true;
    backgroundState.forEach(({ element, inert, ariaHidden }) => {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    });
    overlay.remove();
    activeDialog = null;
  }

  googleBtn.addEventListener('click', async () => {
    googleBtn.disabled = true;
    setStatus('Đang chuyển tới Google…');
    try {
      await signInWithGoogle();
      // Browser navigates away on success; nothing else to do here.
    } catch (error) {
      if (!closed) {
        setStatus(error instanceof Error ? error.message : 'Không thể mở đăng nhập Google.', 'error');
        googleBtn.disabled = false;
      }
    }
  });

  guestBtn.addEventListener('click', () => {
    guestPreference.enable();
    closeDialog();
    options.onSkip?.();
  });

  activeDialog = { close: closeDialog, element: overlay };
  window.setTimeout(() => googleBtn?.focus(), 0);
  return activeDialog;
}
