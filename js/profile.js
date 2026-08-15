// js/profile.js
// Local-only user profile (display name + preset/uploaded avatar) and its UI.
// Uploaded images are validated in the browser and are never sent over the network.

export const PROFILE_STORAGE_KEY = 'n2_profile_v2';
export const PROFILE_PROMPT_KEY = 'n2_profile_prompt_seen_v2';
export const PROFILE_UPDATED_EVENT = 'n2:profile-updated';

export const PROFILE_LIMITS = Object.freeze({
  nameLength: 40,
  imageBytes: 1_500_000,
  dataUrlBytes: 2_100_000,
  minImageSide: 32,
  maxImageSide: 4096,
});

export const PROFILE_PRESETS = Object.freeze([
  Object.freeze({ id: 'neko', symbol: '🐱', label: 'Mèo chăm học' }),
  Object.freeze({ id: 'kitsune', symbol: '🦊', label: 'Cáo tinh nghịch' }),
  Object.freeze({ id: 'usagi', symbol: '🐰', label: 'Thỏ dịu dàng' }),
  Object.freeze({ id: 'sakura', symbol: '🌸', label: 'Hoa anh đào' }),
]);

export const DEFAULT_PROFILE = Object.freeze({
  name: '',
  avatarType: 'preset',
  avatarData: PROFILE_PRESETS[0].id,
});

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i;

let memoryProfile = { ...DEFAULT_PROFILE };
let storageAvailable = true;
let mountSequence = 0;
let dialogSequence = 0;
let promptScheduled = false;
let activeDialog = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function sanitizeName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROFILE_LIMITS.nameLength);
}

function isSafeImageDataUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > PROFILE_LIMITS.dataUrlBytes) return false;
  return SAFE_IMAGE_DATA_URL.test(value);
}

function presetById(id) {
  return PROFILE_PRESETS.find((preset) => preset.id === id) || PROFILE_PRESETS[0];
}

/**
 * Convert arbitrary stored/caller data into the public profile shape.
 * User text remains plain text here and is escaped only at the HTML boundary.
 */
export function normalizeProfile(value) {
  const source = value && typeof value === 'object' ? value : {};
  const name = sanitizeName(source.name);

  if (source.avatarType === 'upload' && isSafeImageDataUrl(source.avatarData)) {
    return { name, avatarType: 'upload', avatarData: source.avatarData };
  }

  return {
    name,
    avatarType: 'preset',
    avatarData: presetById(source.avatarData).id,
  };
}

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

function readImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Tệp đã chọn không phải là ảnh hợp lệ.'));
    image.src = dataUrl;
  });
}

/**
 * Validate an avatar File and return a safe local data URL plus image metadata.
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
  if (file.size > PROFILE_LIMITS.imageBytes) {
    throw new Error('Ảnh phải nhỏ hơn 1,5 MB.');
  }

  const dataUrl = await readFileAsDataUrl(file);
  if (!isSafeImageDataUrl(dataUrl)) {
    throw new Error('Dữ liệu ảnh không hợp lệ hoặc quá lớn để lưu trên thiết bị.');
  }

  const { width, height } = await readImageDimensions(dataUrl);
  const { minImageSide, maxImageSide } = PROFILE_LIMITS;
  if (width < minImageSide || height < minImageSide) {
    throw new Error(`Ảnh cần có kích thước tối thiểu ${minImageSide} × ${minImageSide} px.`);
  }
  if (width > maxImageSide || height > maxImageSide) {
    throw new Error(`Ảnh không được vượt quá ${maxImageSide} × ${maxImageSide} px.`);
  }

  return { dataUrl, mimeType: file.type, width, height, bytes: file.size };
}

/** Return safe avatar markup for mastheads, buttons, or settings previews. */
export function renderAvatar(profileValue = getProfile(), options = {}) {
  const profile = normalizeProfile(profileValue);
  const extraClass = typeof options.className === 'string'
    ? options.className.replace(/[^a-z0-9_ -]/gi, '').trim()
    : '';
  const className = `profile-avatar${extraClass ? ` ${extraClass}` : ''}`;
  const decorative = options.decorative !== false;
  const alt = decorative ? '' : sanitizeName(options.alt || profile.name || 'Ảnh đại diện');

  if (profile.avatarType === 'upload') {
    return `<span class="${escapeHtml(className)} profile-avatar--upload"><img src="${escapeHtml(profile.avatarData)}" alt="${escapeHtml(alt)}"></span>`;
  }

  const preset = presetById(profile.avatarData);
  const aria = decorative ? ' aria-hidden="true"' : ` role="img" aria-label="${escapeHtml(alt || preset.label)}"`;
  return `<span class="${escapeHtml(className)} profile-avatar--preset profile-avatar--${escapeHtml(preset.id)}"${aria}>${escapeHtml(preset.symbol)}</span>`;
}

function resolveTarget(target) {
  if (typeof target === 'string') return document.querySelector(target);
  return target instanceof Element ? target : null;
}

function focusableElements(container) {
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function makePresetChoices(profile, groupName) {
  return PROFILE_PRESETS.map((preset) => {
    const checked = profile.avatarType === 'preset' && profile.avatarData === preset.id;
    return `
      <label class="profile-preset${checked ? ' is-selected' : ''}">
        <input type="radio" name="${escapeHtml(groupName)}" value="${escapeHtml(preset.id)}"${checked ? ' checked' : ''}>
        <span class="profile-preset__symbol" aria-hidden="true">${escapeHtml(preset.symbol)}</span>
        <span class="profile-preset__label">${escapeHtml(preset.label)}</span>
      </label>`;
  }).join('');
}

function avatarPreviewMarkup(profile) {
  const label = profile.avatarType === 'upload'
    ? 'Ảnh đã chọn — chỉ lưu trên thiết bị này'
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
          <p id="${helpId}" class="profile-modal__help">Tên và ảnh chỉ được lưu trong trình duyệt này. Ảnh không bao giờ được tải lên mạng.</p>
          <label class="profile-field" for="${nameId}">
            <span class="profile-field__label">Tên hiển thị</span>
            <input id="${nameId}" name="name" type="text" maxlength="${PROFILE_LIMITS.nameLength}" autocomplete="nickname" value="${escapeHtml(initial.name)}" placeholder="Ví dụ: Minh">
          </label>
          <fieldset class="profile-avatar-fieldset">
            <legend>Chọn ảnh đại diện</legend>
            <div class="profile-presets">${makePresetChoices(initial, groupName)}</div>
            <label class="profile-upload" for="${uploadId}">
              <span class="profile-upload__label">Hoặc chọn ảnh từ thiết bị</span>
              <span class="profile-upload__hint">JPG, PNG hoặc WebP · tối đa 1,5 MB · 32–4096 px mỗi chiều</span>
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
  const card = overlay.querySelector('[role="dialog"]');
  const form = overlay.querySelector('form');
  const nameInput = overlay.querySelector(`#${nameId}`);
  const fileInput = overlay.querySelector(`#${uploadId}`);
  const preview = overlay.querySelector('[data-profile-preview]');
  const status = overlay.querySelector('[data-profile-status]');
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
    overlay.removeEventListener('keydown', onKeyDown);
    backgroundState.forEach(({ element, inert, ariaHidden }) => {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    });
    overlay.remove();
    activeDialog = null;
    if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) trigger.focus();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog(true);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(card);
    if (focusable.length === 0) {
      event.preventDefault();
      card.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  overlay.addEventListener('keydown', onKeyDown);
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
      setStatus(`Ảnh hợp lệ: ${result.width} × ${result.height} px.`, 'success');
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

  activeDialog = { close: () => closeDialog(true), element: overlay };
  window.setTimeout(() => nameInput?.focus(), 0);
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
