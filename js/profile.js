// js/profile.js
// User profile (display name + preset/uploaded avatar) and its UI.
// Uploaded images are validated, cropped and re-encoded in the browser before
// they are stored, then synced with the account so the same avatar follows the
// learner across devices and shows on the leaderboard (see js/sync.js).

import { activateModalDialog } from './modal-dialog.js';
import {
  AVATAR_OUTPUT_SIZE,
  DEFAULT_PROFILE,
  PROFILE_LIMITS,
  PROFILE_PRESETS,
  calculateCoverCrop,
  escapeProfileHtml as escapeHtml,
  isSafeImageDataUrl,
  normalizeProfile,
  presetById,
  renderAvatar as renderAvatarMarkup,
} from './profile-avatar.js';

export {
  AVATAR_OUTPUT_SIZE,
  DEFAULT_PROFILE,
  PROFILE_LIMITS,
  PROFILE_PRESETS,
  calculateCoverCrop,
  normalizeProfile,
} from './profile-avatar.js';

export const PROFILE_STORAGE_KEY = 'n2_profile_v2';
export const PROFILE_PROMPT_KEY = 'n2_profile_prompt_seen_v2';
export const PROFILE_UPDATED_EVENT = 'n2:profile-updated';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

let memoryProfile = { ...DEFAULT_PROFILE };
let storageAvailable = true;
let mountSequence = 0;
let dialogSequence = 0;
let promptScheduled = false;
let activeDialog = null;

function readStoredProfile() {
  if (typeof localStorage === 'undefined') return { ...memoryProfile };
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (raw == null) return { ...memoryProfile };
    const normalized = normalizeProfile(JSON.parse(raw));
    memoryProfile = normalized;
    storageAvailable = true;
    return { ...normalized };
  } catch (error) {
    storageAvailable = false;
    return { ...memoryProfile };
  }
}

export function getProfile() {
  return readStoredProfile();
}

export function getProfileStorageStatus() {
  return { persistent: storageAvailable };
}

function dispatchProfileUpdated(profile, persisted) {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, {
    detail: { profile: { ...profile }, persisted },
  }));
}

/**
 * Save a normalized profile. If storage is blocked/full, the profile remains
 * active for this page session and `getProfileStorageStatus().persistent` is false.
 */
export function saveProfile(value) {
  const profile = normalizeProfile(value);
  memoryProfile = profile;
  let persisted = false;

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
      persisted = true;
      storageAvailable = true;
    } catch (error) {
      storageAvailable = false;
    }
  } else {
    storageAvailable = false;
  }

  dispatchProfileUpdated(profile, persisted);
  return { ...profile };
}

export function hasSeenProfilePrompt() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(PROFILE_PROMPT_KEY) === '1';
  } catch (error) {
    return false;
  }
}

export function markProfilePromptSeen() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PROFILE_PROMPT_KEY, '1');
  } catch (error) {
    // A blocked prompt marker is harmless; never block the rest of the profile UI.
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh này.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function loadImageFromObjectUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve({
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Tệp đã chọn không phải là ảnh hợp lệ.'));
    };
    image.src = objectUrl;
  });
}

async function decodeAvatarSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Some older browsers cannot decode every valid JPEG through ImageBitmap.
    }
  }
  return loadImageFromObjectUrl(file);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Decode, center-crop and compress an avatar File locally. Input size is not
 * restricted: only the compact 256px result is persisted and synced.
 * SVG/GIF are intentionally rejected: static raster formats avoid script payloads
 * and keep localStorage usage predictable.
 */
export async function validateAvatarFile(file) {
  if (!(file instanceof File)) throw new TypeError('Vui lòng chọn một tệp ảnh.');
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('Tệp ảnh đang trống hoặc không đọc được.');
  }
  const decoded = await decodeAvatarSource(file);
  const { width: sourceWidth, height: sourceHeight } = decoded;
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    decoded.release();
    throw new Error('Tệp đã chọn không phải là ảnh hợp lệ.');
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_OUTPUT_SIZE;
    canvas.height = AVATAR_OUTPUT_SIZE;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Trình duyệt không thể xử lý ảnh này.');
    const { sourceX, sourceY, sourceSize } = calculateCoverCrop(sourceWidth, sourceHeight);
    context.fillStyle = '#f7f3eb';
    context.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
    context.drawImage(
      decoded.source,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      AVATAR_OUTPUT_SIZE,
      AVATAR_OUTPUT_SIZE,
    );

    let output = await canvasToBlob(canvas, 'image/webp', 0.82);
    if (!output || output.type !== 'image/webp') output = await canvasToBlob(canvas, 'image/jpeg', 0.86);
    if (!output) throw new Error('Không thể nén ảnh trên trình duyệt này.');
    const dataUrl = await readFileAsDataUrl(output);
    if (!isSafeImageDataUrl(dataUrl)) throw new Error('Ảnh sau khi nén vẫn quá lớn để lưu.');

    return {
      dataUrl,
      mimeType: output.type,
      width: AVATAR_OUTPUT_SIZE,
      height: AVATAR_OUTPUT_SIZE,
      bytes: output.size,
      sourceWidth,
      sourceHeight,
      sourceBytes: file.size,
    };
  } finally {
    decoded.release();
  }
}

/** Return safe avatar markup for mastheads, buttons, or settings previews. */
export function renderAvatar(profileValue = getProfile(), options = {}) {
  return renderAvatarMarkup(profileValue, options);
}

function resolveTarget(target) {
  if (typeof target === 'string') return document.querySelector(target);
  return target instanceof Element ? target : null;
}

function makePresetChoices(profile, groupName) {
  return PROFILE_PRESETS.map((preset) => {
    const checked = profile.avatarType === 'preset' && profile.avatarData === preset.id;
    return `
      <label class="profile-preset${checked ? ' is-selected' : ''}">
        <input type="radio" name="${escapeHtml(groupName)}" value="${escapeHtml(preset.id)}"${checked ? ' checked' : ''}>
        <span class="profile-preset__pet profile-preset--${escapeHtml(preset.id)}" aria-hidden="true"></span>
        <span class="profile-preset__label">${escapeHtml(preset.label)}</span>
      </label>`;
  }).join('');
}

function avatarPreviewMarkup(profile) {
  const label = profile.avatarType === 'upload'
    ? 'Ảnh đã chọn — sẽ đồng bộ với tài khoản của bạn'
    : presetById(profile.avatarData).label;
  return `
    <div class="profile-preview__avatar">${renderAvatar(profile)}</div>
    <span class="profile-preview__label">${escapeHtml(label)}</span>`;
}

/**
 * Open the profile editor. Returns `{ close() }`, or the already-open controller.
 * The modal traps focus, closes with Escape/backdrop, and restores trigger focus.
 */
export function openProfileDialog(options = {}) {
  if (typeof document === 'undefined') return null;
  if (activeDialog) return activeDialog;

  const initial = getProfile();
  let draft = { ...initial };
  const isFirstVisit = options.firstVisit === true;
  const trigger = options.trigger instanceof HTMLElement ? options.trigger : document.activeElement;
  const sequence = ++dialogSequence;
  const titleId = `profile-dialog-title-${sequence}`;
  const helpId = `profile-dialog-help-${sequence}`;
  const nameId = `profile-name-${sequence}`;
  const uploadId = `profile-upload-${sequence}`;
  const groupName = `profile-avatar-${sequence}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-modal active';
  overlay.innerHTML = `
    <section class="modal-card profile-modal__card" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${helpId}">
      <header class="modal-header">
        <div>
          <p class="profile-modal__eyebrow">HỒ SƠ HỌC TẬP</p>
          <h2 id="${titleId}">${isFirstVisit ? 'Mình gọi bạn là gì?' : 'Chỉnh hồ sơ'}</h2>
        </div>
        <button type="button" class="modal-close" data-profile-action="close" aria-label="Đóng cửa sổ hồ sơ">×</button>
      </header>
      <form class="profile-form" novalidate>
        <div class="modal-body">
          <p id="${helpId}" class="profile-modal__help">Tên và ảnh đại diện được đồng bộ với tài khoản — bạn đăng nhập ở máy nào cũng thấy, và học viên khác sẽ thấy trên bảng xếp hạng.</p>
          <label class="profile-field" for="${nameId}">
            <span class="profile-field__label">Tên hiển thị</span>
            <input id="${nameId}" name="name" type="text" maxlength="${PROFILE_LIMITS.nameLength}" autocomplete="nickname" value="${escapeHtml(initial.name)}" placeholder="Ví dụ: Minh">
          </label>
          <fieldset class="profile-avatar-fieldset">
            <legend>Chọn ảnh đại diện</legend>
            <div class="profile-presets">${makePresetChoices(initial, groupName)}</div>
            <label class="profile-upload" for="${uploadId}">
              <span class="profile-upload__label">Hoặc chọn ảnh từ thiết bị</span>
              <span class="profile-upload__hint">JPG, PNG hoặc WebP · ảnh lớn sẽ tự nén và cắt vuông trước khi tải lên</span>
              <input id="${uploadId}" name="avatarFile" type="file" accept="image/jpeg,image/png,image/webp">
            </label>
          </fieldset>
          <div class="profile-preview" data-profile-preview>${avatarPreviewMarkup(initial)}</div>
          <p class="profile-status" data-profile-status role="status" aria-live="polite"></p>
        </div>
        <footer class="modal-footer profile-modal__footer">
          <button type="button" class="profile-skip-btn" data-profile-action="skip">${isFirstVisit ? 'Để sau' : 'Hủy'}</button>
          <button type="submit" class="complete-modal-btn">Lưu hồ sơ</button>
        </footer>
      </form>
    </section>`;

  document.body.appendChild(overlay);
  const form = overlay.querySelector('form');
  const nameInput = overlay.querySelector(`#${nameId}`);
  const fileInput = overlay.querySelector(`#${uploadId}`);
  const preview = overlay.querySelector('[data-profile-preview]');
  const status = overlay.querySelector('[data-profile-status]');
  let modalDialog = null;
  let closed = false;

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.classList.toggle('is-error', kind === 'error');
    status.classList.toggle('is-success', kind === 'success');
  }

  function updatePreview() {
    preview.innerHTML = avatarPreviewMarkup(draft);
    overlay.querySelectorAll('.profile-preset').forEach((label) => {
      const radio = label.querySelector('input[type="radio"]');
      label.classList.toggle('is-selected', Boolean(radio && radio.checked));
    });
  }

  function closeDialog(markSeen = true) {
    if (closed) return;
    closed = true;
    if (markSeen) markProfilePromptSeen();
    modalDialog?.release();
    overlay.remove();
    activeDialog = null;
  }

  overlay.addEventListener('click', (event) => {
    const action = event.target.closest('[data-profile-action]')?.getAttribute('data-profile-action');
    if (action === 'close' || action === 'skip') closeDialog(true);
    if (event.target === overlay) closeDialog(true);
  });

  overlay.addEventListener('change', (event) => {
    const radio = event.target.closest(`input[name="${groupName}"]`);
    if (!radio) return;
    draft = { ...draft, avatarType: 'preset', avatarData: presetById(radio.value).id };
    setStatus('');
    updatePreview();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.disabled = true;
    setStatus('Đang kiểm tra ảnh…');
    try {
      const result = await validateAvatarFile(file);
      if (closed) return;
      draft = { ...draft, avatarType: 'upload', avatarData: result.dataUrl };
      overlay.querySelectorAll(`input[name="${groupName}"]`).forEach((radio) => {
        radio.checked = false;
      });
      setStatus(`Đã nén ${result.sourceWidth} × ${result.sourceHeight} xuống ${result.width} × ${result.height} px.`, 'success');
      updatePreview();
    } catch (error) {
      if (!closed) {
        fileInput.value = '';
        setStatus(error instanceof Error ? error.message : 'Không thể dùng ảnh này.', 'error');
      }
    } finally {
      if (!closed) fileInput.disabled = false;
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    draft = { ...draft, name: nameInput.value };
    const saved = saveProfile(draft);
    markProfilePromptSeen();
    if (typeof options.onSave === 'function') options.onSave({ ...saved });

    if (getProfileStorageStatus().persistent) {
      closeDialog(false);
    } else {
      setStatus('Đã áp dụng cho phiên này, nhưng trình duyệt không cho phép lưu lâu dài.', 'error');
    }
  });

  modalDialog = activateModalDialog(overlay, {
    trigger,
    initialFocus: nameInput,
    onEscape: () => closeDialog(true),
  });
  activeDialog = { close: () => closeDialog(true), element: overlay };
  return activeDialog;
}

/**
 * Mount a compact profile button without replacing existing masthead children.
 * `options.before` can point at the settings button to keep both controls aligned.
 */
export function mountProfile(target, options = {}) {
  if (typeof document === 'undefined') return null;
  const host = resolveTarget(target);
  if (!host) return null;

  const mount = document.createElement('div');
  mount.className = 'profile-mount';
  mount.dataset.profileMount = String(++mountSequence);
  const before = options.before instanceof Node && options.before.parentNode === host ? options.before : null;
  host.insertBefore(mount, before);

  function render(profile = getProfile()) {
    const displayName = profile.name || 'Hồ sơ';
    mount.innerHTML = `
      <button type="button" class="profile-button" aria-label="Chỉnh hồ sơ của ${escapeHtml(displayName)}">
        ${renderAvatar(profile)}
        <span class="profile-button__copy">
          <span class="profile-button__label">NGƯỜI HỌC</span>
          <span class="profile-button__name">${escapeHtml(displayName)}</span>
        </span>
      </button>`;
  }

  function openFromButton() {
    openProfileDialog({
      trigger: mount.querySelector('.profile-button'),
      onSave: options.onSave,
    });
  }

  function onUpdated(event) {
    render(normalizeProfile(event.detail?.profile));
  }

  mount.addEventListener('click', openFromButton);
  window.addEventListener(PROFILE_UPDATED_EVENT, onUpdated);
  render();

  if (options.promptOnFirstVisit !== false && !hasSeenProfilePrompt() && !promptScheduled) {
    promptScheduled = true;
    window.setTimeout(() => {
      promptScheduled = false;
      if (!mount.isConnected || hasSeenProfilePrompt() || activeDialog) return;
      openProfileDialog({
        firstVisit: true,
        trigger: mount.querySelector('.profile-button'),
        onSave: options.onSave,
      });
    }, 350);
  }

  return {
    element: mount,
    open: openFromButton,
    render,
    destroy() {
      window.removeEventListener(PROFILE_UPDATED_EVENT, onUpdated);
      mount.remove();
    },
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== PROFILE_STORAGE_KEY) return;
    if (event.newValue == null) {
      memoryProfile = { ...DEFAULT_PROFILE };
      storageAvailable = true;
      dispatchProfileUpdated(memoryProfile, true);
      return;
    }
    const profile = getProfile();
    dispatchProfileUpdated(profile, storageAvailable);
  });
}
