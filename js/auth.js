// js/auth.js
// Mandatory Google authentication gate.

import { signInWithGoogle } from './supabase.js';
import { activateModalDialog } from './modal-dialog.js';

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
        <p class="profile-modal__help">Đăng nhập Google để học, đồng bộ tiến độ và tham gia bảng xếp hạng.</p>
        <button type="button" class="auth-pill auth-modal__google" data-gate-action="google">Đăng nhập bằng Google</button>
        <p class="profile-status" data-gate-status role="status" aria-live="polite"></p>
      </div>
    </section>`;

  document.body.appendChild(overlay);
  const status = overlay.querySelector('[data-gate-status]');
  const googleBtn = overlay.querySelector('[data-gate-action="google"]');
  let modalDialog = null;
  let closed = false;

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.classList.toggle('is-error', kind === 'error');
  }

  function closeDialog() {
    if (closed) return;
    closed = true;
    modalDialog?.release({ restoreFocus: false });
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

  // This gate is mandatory, so Escape is contained but intentionally does not close it.
  modalDialog = activateModalDialog(overlay, { initialFocus: googleBtn });
  activeDialog = { close: closeDialog, element: overlay };
  return activeDialog;
}
