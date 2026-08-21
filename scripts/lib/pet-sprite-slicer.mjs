// Turns the hand-drawn 5x4 pose sheets into a clean per-action atlas.
//
// The concept sheets place each pose freely inside its row, so neighbouring
// poses drift into one another and no two frames share a ground line. Slicing
// on tight alpha bounds and re-planting every pose on one baseline is what
// stops "một hành động tràn ảnh của hành động khác" and the wobble between
// frames of the same action.
import { decodePNG, createCanvas, blit } from './png.mjs';

const ALPHA_THRESHOLD = 40;
const SOURCE_COLUMNS = 5;
const SOURCE_ROWS = 4;

export const ATLAS_COLUMNS = 4;
export const ATLAS_ROWS = 4;

// Slot order is semantic: the runtime reads these names, never a raw sheet
// index, so both mascots animate from one shared frame table.
export const ATLAS_SLOTS = Object.freeze([
  'idle', 'idle-blink', 'idle-soft', 'look-half',
  'look-full', 'walk-pass', 'walk-stride-a', 'walk-stride-b',
  'pounce', 'cheer', 'stretch', 'flop',
  'sleep-a', 'sleep-b', 'doze-a', 'doze-b',
]);

// Every directional pose is re-planted facing left; the runtime mirrors the
// whole sprite when the pet travels right, so a walk never flips mid-stride.
export const PET_SOURCE_LAYOUT = Object.freeze({
  fox: Object.freeze([
    { frame: 3 }, { frame: 4 }, { frame: 9 }, { frame: 5, mirror: true },
    { frame: 6, mirror: true }, { frame: 10 }, { frame: 12 }, { frame: 13 },
    { frame: 14 }, { frame: 15 }, { frame: 1 }, { frame: 16 },
    { frame: 17 }, { frame: 0 }, { frame: 18 }, { frame: 19 },
  ]),
  rabbit: Object.freeze([
    { frame: 3 }, { frame: 4 }, { frame: 9 }, { frame: 5 },
    { frame: 6 }, { frame: 10 }, { frame: 11 }, { frame: 13 },
    { frame: 14 }, { frame: 15 }, { frame: 1 }, { frame: 16 },
    { frame: 17 }, { frame: 18 }, { frame: 19 }, { frame: 19 },
  ]),
});

function bands(counts, minimumGap) {
  const spans = [];
  let start = -1;
  let gap = 0;
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] > 0) {
      if (start < 0) start = index;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap >= minimumGap) {
        spans.push([start, index - gap]);
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) spans.push([start, counts.length - 1]);
  return spans;
}

// Detached bits — motion swooshes, an ear tip, a floating "zZ" — read as their
// own span. Fold the cheapest neighbour pair together until the expected pose
// count is left.
function foldFragments(spans, expected, label) {
  if (spans.length < expected) throw new Error(`${label}: found ${spans.length} spans, expected ${expected}`);
  let items = spans.map(([start, end]) => ({ start, end }));
  while (items.length > expected) {
    let index = -1;
    let bestCost = Infinity;
    for (let i = 0; i < items.length - 1; i += 1) {
      const gap = items[i + 1].start - items[i].end;
      const widths = [items[i].end - items[i].start, items[i + 1].end - items[i + 1].start];
      const cost = gap * Math.min(...widths);
      if (cost < bestCost) {
        bestCost = cost;
        index = i;
      }
    }
    items = [
      ...items.slice(0, index),
      { start: items[index].start, end: items[index + 1].end },
      ...items.slice(index + 2),
    ];
  }
  return items;
}

/** Tight alpha bounds for all 20 poses of a concept sheet, in reading order. */
export function sliceSourcePoses(file) {
  const image = decodePNG(file);
  const alphaAt = (x, y) => image.data[(y * image.width + x) * 4 + 3];

  const rowCounts = new Array(image.height).fill(0);
  for (let y = 0; y < image.height; y += 1) {
    let count = 0;
    for (let x = 0; x < image.width; x += 1) if (alphaAt(x, y) > ALPHA_THRESHOLD) count += 1;
    rowCounts[y] = count;
  }

  const poses = [];
  for (const row of foldFragments(bands(rowCounts, 6), SOURCE_ROWS, `${file} rows`)) {
    const columnCounts = new Array(image.width).fill(0);
    for (let x = 0; x < image.width; x += 1) {
      let count = 0;
      for (let y = row.start; y <= row.end; y += 1) if (alphaAt(x, y) > ALPHA_THRESHOLD) count += 1;
      columnCounts[x] = count;
    }
    for (const column of foldFragments(bands(columnCounts, 6), SOURCE_COLUMNS, `${file} row ${row.start}`)) {
      let top = row.end;
      let bottom = row.start;
      for (let y = row.start; y <= row.end; y += 1) {
        for (let x = column.start; x <= column.end; x += 1) {
          if (alphaAt(x, y) <= ALPHA_THRESHOLD) continue;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          break;
        }
      }
      poses.push({
        x: column.start,
        y: top,
        width: column.end - column.start + 1,
        height: bottom - top + 1,
      });
    }
  }
  return { image, poses };
}

// Anchor on the ground contact rather than the bounding box: a raised paw must
// not shove the body sideways between two frames of the same walk cycle.
function footAnchor(image, pose, mirror) {
  const bandTop = pose.y + Math.floor(pose.height * 0.78);
  let sum = 0;
  let count = 0;
  for (let y = bandTop; y < pose.y + pose.height; y += 1) {
    for (let x = pose.x; x < pose.x + pose.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
      sum += x - pose.x;
      count += 1;
    }
  }
  const offset = count ? sum / count : pose.width / 2;
  return mirror ? pose.width - 1 - offset : offset;
}

/**
 * Rebuild one mascot's poses as a uniform atlas: every cell holds exactly one
 * action frame, centred on its feet and standing on a shared baseline.
 */
export function buildPetAtlas(sourceFile, layout, { padding = 10 } = {}) {
  const { image, poses } = sliceSourcePoses(sourceFile);
  const placements = layout.map((slot) => {
    const pose = poses[slot.frame];
    if (!pose) throw new Error(`${sourceFile}: missing source frame ${slot.frame}`);
    return { pose, mirror: Boolean(slot.mirror), anchor: footAnchor(image, pose, Boolean(slot.mirror)) };
  });

  const halfWidth = Math.max(...placements.map(({ pose, anchor }) => Math.max(anchor, pose.width - anchor)));
  const cellWidth = Math.ceil(halfWidth * 2) + padding * 2;
  const cellHeight = Math.max(...placements.map(({ pose }) => pose.height)) + padding * 2;

  const atlas = createCanvas(cellWidth * ATLAS_COLUMNS, cellHeight * ATLAS_ROWS);
  placements.forEach(({ pose, mirror, anchor }, index) => {
    const cellX = (index % ATLAS_COLUMNS) * cellWidth;
    const cellY = Math.floor(index / ATLAS_COLUMNS) * cellHeight;
    blit(atlas, image, pose, {
      x: Math.round(cellX + cellWidth / 2 - anchor),
      y: cellY + cellHeight - padding - pose.height,
    }, { mirror });
  });
  return { atlas, cellWidth, cellHeight };
}
