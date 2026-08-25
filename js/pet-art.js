// Each premium appearance owns the full raster atlas: costume, fur, pose accents
// and VFX travel together instead of being overlaid as detached accessories.
export function renderPetArt(petType, skinId = 'classic') {
  const type = petType === 'rabbit' ? 'rabbit' : 'fox';
  const skin = String(skinId || 'classic').replace(/[^a-z0-9-]/gi, '') || 'classic';
  return `<span class="pet-art pet-art--${type} pet-art--skin-${skin} pixel-pet pixel-pet--${type}" data-pixel-pet aria-hidden="true">
    <span class="pixel-pet__sprite" aria-hidden="true"></span>
    <span class="pet-art__effect pet-art__hearts" aria-hidden="true"></span>
    <span class="pet-art__effect pet-art__spark" aria-hidden="true"></span>
  </span>`;
}
