// The character is rendered from the approved six-frame raster concept sheet.
// Each sheet keeps its original shading and pixel detail on a true alpha layer.

function accessoryMarkup(accessoryId) {
  if (accessoryId === 'pencil') {
    return `<svg class="pet-accessory pet-accessory--pencil" viewBox="0 0 28 74" aria-hidden="true" focusable="false">
      <path d="M8 61 17 4l7 1-9 57-5 8z" fill="#e9b947" stroke="#392d27" stroke-width="2"/>
      <path d="m17 4 5-3 2 4z" fill="#392d27"/><path d="m8 61 7 1-5 8z" fill="#efcfaa"/>
      <path d="m12 38 7 1" stroke="#fff4d6" stroke-width="2"/>
    </svg>`;
  }
  if (accessoryId === 'seal') {
    return `<svg class="pet-accessory pet-accessory--seal" viewBox="0 0 52 64" aria-hidden="true" focusable="false">
      <path d="M10 8h32v48L26 45 10 56z" fill="#c9322d" stroke="#392d27" stroke-width="2"/>
      <circle cx="26" cy="27" r="11" fill="#fff0d8"/><path d="m20 27 4 4 8-10" fill="none" stroke="#c9322d" stroke-width="3" stroke-linecap="round"/>
    </svg>`;
  }
  if (accessoryId === 'lamp') {
    return `<svg class="pet-accessory pet-accessory--lamp" viewBox="0 0 58 72" aria-hidden="true" focusable="false">
      <path d="M29 5v14M18 8h22" fill="none" stroke="#392d27" stroke-width="4" stroke-linecap="round"/>
      <path d="M10 21h38l-5 39H15z" fill="#dc5543" stroke="#392d27" stroke-width="3"/>
      <rect x="20" y="29" width="18" height="19" rx="5" fill="#ffd977"/>
      <path d="M15 60h28" stroke="#392d27" stroke-width="4" stroke-linecap="round"/>
    </svg>`;
  }
  return '';
}

export function renderPetArt(petType, accessoryId = 'none') {
  const type = petType === 'rabbit' ? 'rabbit' : 'fox';
  return `<span class="pet-art pet-art--${type} pixel-pet pixel-pet--${type}" data-pixel-pet aria-hidden="true">
    <span class="pixel-pet__sprite" aria-hidden="true"></span>
    ${accessoryMarkup(accessoryId)}
    <span class="pet-art__effect pet-art__hearts" aria-hidden="true"></span>
    <span class="pet-art__effect pet-art__spark" aria-hidden="true"></span>
  </span>`;
}
