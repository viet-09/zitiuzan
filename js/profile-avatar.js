export const PROFILE_LIMITS = Object.freeze({
  nameLength: 40,
  dataUrlBytes: 750_000,
});

export const PROFILE_PRESETS = Object.freeze([
  Object.freeze({ id: 'fox', label: 'Cáo đỏ tinh nghịch' }),
  Object.freeze({ id: 'rabbit', label: 'Thỏ trắng dịu dàng' }),
]);

export const AVATAR_OUTPUT_SIZE = 256;

export const DEFAULT_PROFILE = Object.freeze({
  name: '',
  avatarType: 'preset',
  avatarData: PROFILE_PRESETS[0].id,
});

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i;

export function escapeProfileHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

export function sanitizeProfileName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROFILE_LIMITS.nameLength);
}

export function isSafeImageDataUrl(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PROFILE_LIMITS.dataUrlBytes
    && SAFE_IMAGE_DATA_URL.test(value);
}

export function presetById(id) {
  const legacyId = ({ kitsune: 'fox', usagi: 'rabbit' })[id] || id;
  return PROFILE_PRESETS.find((preset) => preset.id === legacyId) || PROFILE_PRESETS[0];
}

export function normalizeProfile(value) {
  const source = value && typeof value === 'object' ? value : {};
  const name = sanitizeProfileName(source.name);

  if (source.avatarType === 'upload' && isSafeImageDataUrl(source.avatarData)) {
    return { name, avatarType: 'upload', avatarData: source.avatarData };
  }

  return {
    name,
    avatarType: 'preset',
    avatarData: presetById(source.avatarData).id,
  };
}

export function calculateCoverCrop(width, height) {
  const sourceSize = Math.min(width, height);
  return {
    sourceX: (width - sourceSize) / 2,
    sourceY: (height - sourceSize) / 2,
    sourceSize,
  };
}

export function renderAvatar(profileValue = DEFAULT_PROFILE, options = {}) {
  const profile = normalizeProfile(profileValue);
  const extraClass = typeof options.className === 'string'
    ? options.className.replace(/[^a-z0-9_ -]/gi, '').trim()
    : '';
  const className = `profile-avatar${extraClass ? ` ${extraClass}` : ''}`;
  const decorative = options.decorative !== false;
  const alt = decorative ? '' : sanitizeProfileName(options.alt || profile.name || 'Ảnh đại diện');

  if (profile.avatarType === 'upload') {
    return `<span class="${escapeProfileHtml(className)} profile-avatar--upload"><img src="${escapeProfileHtml(profile.avatarData)}" alt="${escapeProfileHtml(alt)}"></span>`;
  }

  const preset = presetById(profile.avatarData);
  const aria = decorative ? ' aria-hidden="true"' : ` role="img" aria-label="${escapeProfileHtml(alt || preset.label)}"`;
  return `<span class="${escapeProfileHtml(className)} profile-avatar--preset profile-avatar--${escapeProfileHtml(preset.id)}"${aria}><span class="profile-avatar__pet" aria-hidden="true"></span></span>`;
}

