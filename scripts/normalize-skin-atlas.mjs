import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas, decodePNG, encodePNG } from './lib/png.mjs';

const ALPHA = 40;
const GRID = 4;
const CELL = 320;
const INSET = 12;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skinRoot = path.join(root, 'assets', 'pets', 'skins');

function alphaAt(image, x, y) {
  return image.data[(y * image.width + x) * 4 + 3];
}

function projection(image, axis) {
  const length = axis === 'x' ? image.width : image.height;
  const cross = axis === 'x' ? image.height : image.width;
  return Array.from({ length }, (_, position) => {
    let count = 0;
    for (let other = 0; other < cross; other += 1) {
      const x = axis === 'x' ? position : other;
      const y = axis === 'x' ? other : position;
      if (alphaAt(image, x, y) > ALPHA) count += 1;
    }
    return count;
  });
}

function gapScore(values, position, radius = 4) {
  let score = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    score += values[Math.max(0, Math.min(values.length - 1, position + offset))];
  }
  return score;
}

function findBoundaries(image, axis) {
  const length = axis === 'x' ? image.width : image.height;
  const values = projection(image, axis);
  const searchRadius = Math.round((length / GRID) * 0.23);
  const cuts = [0];
  for (let division = 1; division < GRID; division += 1) {
    const expected = Math.round((length * division) / GRID);
    let best = expected;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let position = expected - searchRadius; position <= expected + searchRadius; position += 1) {
      const score = gapScore(values, position);
      const distancePenalty = Math.abs(position - expected) * 0.02;
      if (score + distancePenalty < bestScore) {
        best = position;
        bestScore = score + distancePenalty;
      }
    }
    cuts.push(best);
  }
  cuts.push(length);
  return cuts;
}

function contentBounds(image, rect) {
  let left = rect.right;
  let right = rect.left - 1;
  let top = rect.bottom;
  let bottom = rect.top - 1;
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      if (alphaAt(image, x, y) <= ALPHA) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left
    ? { x: rect.left, y: rect.top, width: 1, height: 1 }
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function copyScaled(target, source, rect, destination, scale) {
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  for (let y = 0; y < height; y += 1) {
    const sourceY = rect.y + Math.min(rect.height - 1, Math.floor(y / scale));
    const targetY = destination.y + y;
    for (let x = 0; x < width; x += 1) {
      const sourceX = rect.x + Math.min(rect.width - 1, Math.floor(x / scale));
      const targetX = destination.x + x;
      const from = (sourceY * source.width + sourceX) * 4;
      const to = (targetY * target.width + targetX) * 4;
      source.data.copy(target.data, to, from, from + 4);
    }
  }
  return { width, height };
}

export function normalizeSkinAtlas(file) {
  const source = decodePNG(file);
  const columns = findBoundaries(source, 'x');
  const rows = findBoundaries(source, 'y');
  const cells = [];
  for (let row = 0; row < GRID; row += 1) {
    const frames = [];
    for (let column = 0; column < GRID; column += 1) {
      const sourceCell = {
        left: columns[column], right: columns[column + 1],
        top: rows[row], bottom: rows[row + 1],
      };
      frames.push(contentBounds(source, sourceCell));
    }
    cells.push(frames);
  }

  const output = createCanvas(CELL * GRID, CELL * GRID);
  for (let row = 0; row < GRID; row += 1) {
    const maxWidth = Math.max(...cells[row].map((frame) => frame.width));
    const maxHeight = Math.max(...cells[row].map((frame) => frame.height));
    const scale = Math.min((CELL - INSET * 2) / maxWidth, (CELL - INSET * 2) / maxHeight, 1);
    for (let column = 0; column < GRID; column += 1) {
      const frame = cells[row][column];
      const drawn = {
        width: Math.max(1, Math.round(frame.width * scale)),
        height: Math.max(1, Math.round(frame.height * scale)),
      };
      copyScaled(output, source, frame, {
        x: column * CELL + Math.round((CELL - drawn.width) / 2),
        y: row * CELL + CELL - INSET - drawn.height,
      }, scale);
    }
  }

  fs.writeFileSync(file, encodePNG(output));
  return { file, columns, rows, width: output.width, height: output.height };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const files = requested.length
    ? requested.map((file) => path.resolve(file))
    : fs.readdirSync(skinRoot).filter((file) => file.endsWith('.png')).map((file) => path.join(skinRoot, file));
  for (const file of files) {
    const result = normalizeSkinAtlas(file);
    console.log(`${path.basename(file)} ${result.width}x${result.height} rows=${result.rows.join(',')} columns=${result.columns.join(',')}`);
  }
}
