// Original code-native pixel mascots. SVG keeps the background genuinely
// transparent while crisp, grid-aligned geometry preserves the sprite look.

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
  const character = type === 'rabbit' ? rabbitPixelArt() : foxPixelArt();
  return `<span class="pet-art pet-art--${type} pixel-pet pixel-pet--${type}" data-pixel-pet aria-hidden="true">
    ${character}
    ${accessoryMarkup(accessoryId)}
    <span class="pet-art__effect pet-art__hearts" aria-hidden="true"></span>
    <span class="pet-art__effect pet-art__spark" aria-hidden="true"></span>
    <span class="pet-art__evolution-mark" aria-hidden="true">✓</span>
  </span>`;
}

function foxPixelArt() {
  return `<svg class="pixel-pet__svg" viewBox="0 0 96 132" role="presentation" focusable="false" shape-rendering="crispEdges">
    <g class="pixel-pet__body-rig">
      <g class="pixel-pet__tail">
        <path d="M24 76H14V82H8V100H14V108H30V102H38V90H32V82H24Z" fill="#e87819" stroke="#43291f" stroke-width="4"/>
        <path d="M8 94H14V104H28V100H32V106H26V112H12V106H6Z" fill="#fff0cf"/>
      </g>
      <g class="pixel-pet__legs">
        <path d="M34 108H46V122H30V116H34ZM58 108H70V116H74V122H56Z" fill="#e87819" stroke="#43291f" stroke-width="4"/>
        <path d="M28 118H48V126H26V122ZM54 118H76V126H52V122Z" fill="#57382c"/>
      </g>
      <path class="pixel-pet__shorts" d="M30 92H72V112H64V118H38V112H30Z" fill="#4b4142" stroke="#43291f" stroke-width="4"/>
      <path class="pixel-pet__torso" d="M26 66H72V74H78V104H70V110H30V104H22V76H26Z" fill="#c9382e" stroke="#43291f" stroke-width="4"/>
      <path d="M30 72H68V80H72V102H62V88H38V102H28V80H30Z" fill="#df4a37"/>
      <path d="M40 86H62V104H38V92Z" fill="#b72d29" stroke="#43291f" stroke-width="3"/>
      <g class="pixel-pet__paw pixel-pet__paw--left"><path d="M22 78H34V98H22V94H18V82H22Z" fill="#e87819" stroke="#43291f" stroke-width="4"/></g>
      <g class="pixel-pet__paw pixel-pet__paw--right"><path d="M68 76H78V82H82V94H78V100H68Z" fill="#e87819" stroke="#43291f" stroke-width="4"/></g>
      <g class="pixel-pet__head-rig">
        <path d="M18 28H22V12H30V18H36V22H62V18H68V10H76V28H82V38H86V56H80V66H70V72H28V68H20V60H14V38H18Z" fill="#ee7b19" stroke="#43291f" stroke-width="4"/>
        <path d="M24 18H30V24H34V32H24ZM68 18H74V32H64V24H68Z" fill="#fff0cf"/>
        <path d="M20 48H30V42H66V46H78V60H70V68H28V64H20Z" fill="#fff0cf"/>
        <g class="pixel-pet__eyes pixel-pet__eyes--open"><rect x="32" y="44" width="5" height="10" fill="#43291f"/><rect x="62" y="44" width="5" height="10" fill="#43291f"/></g>
        <g class="pixel-pet__eyes pixel-pet__eyes--closed"><rect x="30" y="50" width="10" height="3" fill="#43291f"/><rect x="60" y="50" width="10" height="3" fill="#43291f"/></g>
        <path d="M46 52H54V58H50V62H46V58H42V54H46Z" fill="#43291f"/>
      </g>
      <g class="pixel-pet__bell"><path d="M44 70H58V76H62V84H56V90H46V84H40V76H44Z" fill="#f2b41e" stroke="#43291f" stroke-width="3"/><rect x="49" y="80" width="4" height="6" fill="#8e511c"/></g>
      <g class="pixel-pet__sleep-marks" fill="#6e4b44"><path d="M70 24H84V29H78L84 35H70V30H76Z"/><path d="M78 12H90V16H84L90 21H78V17H83Z"/></g>
      <g class="pixel-pet__advice-mark" fill="#d44035"><path d="M78 30H83V45H78Z"/><rect x="78" y="49" width="5" height="5"/></g>
    </g>
  </svg>`;
}

function rabbitPixelArt() {
  return `<svg class="pixel-pet__svg" viewBox="0 0 96 132" role="presentation" focusable="false" shape-rendering="crispEdges">
    <g class="pixel-pet__body-rig">
      <g class="pixel-pet__tail"><path d="M76 82H86V88H90V100H84V106H74V100H70V88H74Z" fill="#fff2dc" stroke="#38263f" stroke-width="4"/></g>
      <g class="pixel-pet__legs">
        <path d="M30 108H44V120H26V114H30ZM60 108H72V114H76V120H56V114H60Z" fill="#fff6e8" stroke="#38263f" stroke-width="4"/>
        <path d="M24 118H46V126H22V122ZM54 118H78V126H52V122Z" fill="#f0a8b8"/>
      </g>
      <path class="pixel-pet__shorts" d="M28 94H74V114H64V118H38V114H28Z" fill="#e888a3" stroke="#38263f" stroke-width="4"/>
      <path class="pixel-pet__torso" d="M26 68H72V74H78V104H70V110H30V104H22V76H26Z" fill="#9b82c8" stroke="#38263f" stroke-width="4"/>
      <path d="M30 74H68V82H72V102H62V88H38V102H28V82H30Z" fill="#b59bdd"/>
      <path d="M40 88H62V104H38V94Z" fill="#8d72bb" stroke="#38263f" stroke-width="3"/>
      <g class="pixel-pet__paw pixel-pet__paw--left"><path d="M20 80H34V100H22V96H18V84H20Z" fill="#fff4e6" stroke="#38263f" stroke-width="4"/></g>
      <g class="pixel-pet__paw pixel-pet__paw--right"><path d="M68 78H80V84H84V96H78V102H68Z" fill="#fff4e6" stroke="#38263f" stroke-width="4"/></g>
      <g class="pixel-pet__head-rig">
        <path d="M24 30V8H30V4H38V10H42V30ZM58 30V8H64V4H72V10H76V34Z" fill="#fff6e8" stroke="#38263f" stroke-width="4"/>
        <path d="M30 10H35V28H30ZM64 10H69V30H64Z" fill="#ef9aaa"/>
        <path d="M18 34H24V28H72V34H80V42H84V60H78V68H68V74H30V70H20V62H14V42H18Z" fill="#fff6e8" stroke="#38263f" stroke-width="4"/>
        <path d="M24 52H76V66H68V72H30V68H24Z" fill="#fff0e2"/>
        <g class="pixel-pet__eyes pixel-pet__eyes--open"><rect x="32" y="44" width="5" height="10" fill="#38263f"/><rect x="62" y="44" width="5" height="10" fill="#38263f"/></g>
        <g class="pixel-pet__eyes pixel-pet__eyes--closed"><rect x="30" y="50" width="10" height="3" fill="#38263f"/><rect x="60" y="50" width="10" height="3" fill="#38263f"/></g>
        <path d="M46 54H54V58H51V63H47V58H44V56H46Z" fill="#e8839e"/>
      </g>
      <g class="pixel-pet__bell"><path d="M44 72H58V78H62V86H56V92H46V86H40V78H44Z" fill="#f2b41e" stroke="#38263f" stroke-width="3"/><rect x="49" y="82" width="4" height="6" fill="#8e511c"/></g>
      <g class="pixel-pet__sleep-marks" fill="#8065a7"><path d="M70 26H84V31H78L84 37H70V32H76Z"/><path d="M78 14H90V18H84L90 23H78V19H83Z"/></g>
      <g class="pixel-pet__advice-mark" fill="#8d72bb"><path d="M78 32H83V47H78Z"/><rect x="78" y="51" width="5" height="5"/></g>
    </g>
  </svg>`;
}
