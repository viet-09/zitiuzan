// js/auth.js
// Mandatory sign-in gate: the app requires a Google session to be used at
// all — no offline/skip mode. Google is the only sign-in method — see
// js/supabase.js. Non-dismissable: no close button, no Escape, no backdrop
// click — the only way out is to actually sign in.

import { signInWithGoogle } from './supabase.js';

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
        <h2 id="${titleId}">Đăng nhập để sử dụng</h2>
      </header>
      <div class="modal-body">
        <p class="profile-modal__help">Ứng dụng yêu cầu đăng nhập bằng Google để lưu tiến độ, streak và điểm trên máy chủ, đồng thời hiện trên bảng xếp hạng cùng bạn bè.</p>
        <button type="button" class="auth-pill auth-modal__google" data-gate-action="google">Đăng nhập bằng Google</button>
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

  activeDialog = { close: closeDialog, element: overlay };
  window.setTimeout(() => googleBtn?.focus(), 0);
  return activeDialog;
}
