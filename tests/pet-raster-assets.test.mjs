import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePNG } from '../scripts/lib/png.mjs';
import {
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  ATLAS_SLOTS,
  PET_SOURCE_LAYOUT,
  buildPetAtlas,
  sliceSourcePoses,
} from '../scripts/lib/pet-sprite-slicer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const petAsset = (name) => path.join(root, 'assets', 'pets', name);
const PETS = ['fox', 'rabbit'];
const RECALL_SKINS = [
  'fox-peacemaker-high-noon',
  'fox-prestige-heartsteel',
  'fox-high-noon',
  'fox-dawnbringer',
  'rabbit-elementalist',
  'rabbit-prestige-spirit-blossom',
  'rabbit-dark-cosmic',
  'rabbit-cosmic',
];
const SKINS = [
  'fox-peacemaker-high-noon.png',
  'fox-prestige-heartsteel.png',
  'fox-high-noon.png',
  'fox-dawnbringer.png',
  'rabbit-elementalist.png',
  'rabbit-prestige-spirit-blossom.png',
  'rabbit-dark-cosmic.png',
  'rabbit-cosmic.png',
  ...RECALL_SKINS.flatMap((skin) => [1, 2, 3, 4].map((act) => `${skin}-recall-act-${act}.png`)),
];
const ALPHA = 40;

test('motion sprite sheets provide transparent multi-frame artwork for both pets', () => {
  for (const pet of PETS) {
    const asset = fs.readFileSync(petAsset(`${pet}-motion-sprites.png`));
    assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(asset.readUInt32BE(16) >= 1000, `${pet} needs room for five pose columns`);
    assert.ok(asset.readUInt32BE(20) >= 1000, `${pet} needs room for four pose rows`);
    assert.equal(asset[25], 6, `${pet} must preserve alpha transparency`);
  }
});

test('every premium skin ships as a transparent 4x4 raster atlas', () => {
  for (const skin of SKINS) {
    const file = petAsset(path.join('skins', skin));
    const asset = fs.readFileSync(file);
    assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(asset[25], 6, `${skin} must preserve alpha transparency`);
    const atlas = decodePNG(file);
    assert.equal(atlas.width, 1280, `${skin} must use exact 320px cells`);
    assert.equal(atlas.height, 1280, `${skin} must use exact 320px cells`);
    let transparent = 0;
    for (let offset = 3; offset < atlas.data.length; offset += 4) {
      if (atlas.data[offset] <= ALPHA) transparent += 1;
    }
    assert.ok(transparent >= atlas.width * atlas.height * 0.4, `${skin} background is not transparent`);
  }
});

test('premium atlas gutters prevent a neighbouring action bleeding into the current frame', () => {
  const cell = 320;
  const gutter = 8;
  for (const skin of SKINS) {
    const atlas = decodePNG(petAsset(path.join('skins', skin)));
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const originX = column * cell;
        const originY = row * cell;
        for (let offset = 0; offset < cell; offset += 1) {
          for (let inset = 0; inset < gutter; inset += 1) {
            const points = [
              [originX + offset, originY + inset],
              [originX + offset, originY + cell - 1 - inset],
              [originX + inset, originY + offset],
              [originX + cell - 1 - inset, originY + offset],
            ];
            for (const [x, y] of points) {
              assert.ok(atlas.data[(y * atlas.width + x) * 4 + 3] <= ALPHA,
                `${skin} frame ${row * 4 + column} leaks into its ${gutter}px gutter`);
            }
          }
        }
      }
    }
  }
});

test('every premium recall contains sixty-four genuinely distinct raster frames', () => {
  for (const skin of RECALL_SKINS) {
    const hashes = new Set();
    for (let act = 1; act <= 4; act += 1) {
      const atlas = decodePNG(petAsset(path.join('skins', `${skin}-recall-act-${act}.png`)));
      for (let frame = 0; frame < 16; frame += 1) {
        const originX = (frame % 4) * 320;
        const originY = Math.floor(frame / 4) * 320;
        const hash = createHash('sha256');
        for (let y = 0; y < 320; y += 1) {
          const start = ((originY + y) * atlas.width + originX) * 4;
          hash.update(atlas.data.subarray(start, start + 320 * 4));
        }
        hashes.add(hash.digest('hex'));
      }
    }
    assert.equal(hashes.size, 64, `${skin} must slow down with added drawings, not duplicated holds`);
  }
});

test('long recall atlases are wired into CSS but stay out of the eager app shell', () => {
  const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
  const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  for (const skin of RECALL_SKINS) {
    for (let act = 1; act <= 4; act += 1) {
      const file = `${skin}-recall-act-${act}.png`;
      assert.ok(css.includes(file), `${file} is not selectable by the renderer`);
      assert.equal(serviceWorker.includes(file), false, `${file} should load lazily, not during app install`);
    }
  }
});

test('every concept pose is found on its own, twenty per sheet', () => {
  for (const pet of PETS) {
    const { poses } = sliceSourcePoses(petAsset(`${pet}-motion-sprites.png`));
    assert.equal(poses.length, 20, `${pet} concept sheet must hold twenty poses`);
    for (const pose of poses) assert.ok(pose.width > 40 && pose.height > 40, `${pet} pose too small`);
  }
});

test('the shipped atlas matches what the build script produces right now', () => {
  for (const pet of PETS) {
    const built = buildPetAtlas(petAsset(`${pet}-motion-sprites.png`), PET_SOURCE_LAYOUT[pet]);
    const shipped = decodePNG(petAsset(`${pet}-motion-atlas.png`));
    assert.equal(shipped.width, built.atlas.width, `${pet} atlas is stale — run npm run build:pets`);
    assert.equal(shipped.height, built.atlas.height, `${pet} atlas is stale — run npm run build:pets`);
    assert.ok(shipped.data.equals(built.atlas.data), `${pet} atlas is stale — run npm run build:pets`);
    assert.equal(shipped.width % ATLAS_COLUMNS, 0);
    assert.equal(shipped.height % ATLAS_ROWS, 0);
  }
});

test('each atlas cell holds exactly one action frame with clear margins', () => {
  for (const pet of PETS) {
    const atlas = decodePNG(petAsset(`${pet}-motion-atlas.png`));
    const cellWidth = atlas.width / ATLAS_COLUMNS;
    const cellHeight = atlas.height / ATLAS_ROWS;
    const alphaAt = (x, y) => atlas.data[(y * atlas.width + x) * 4 + 3];

    ATLAS_SLOTS.forEach((slot, index) => {
      const originX = (index % ATLAS_COLUMNS) * cellWidth;
      const originY = Math.floor(index / ATLAS_COLUMNS) * cellHeight;
      let left = cellWidth;
      let right = -1;
      let top = cellHeight;
      let bottom = -1;
      for (let y = 0; y < cellHeight; y += 1) {
        for (let x = 0; x < cellWidth; x += 1) {
          if (alphaAt(originX + x, originY + y) <= ALPHA) continue;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
      assert.ok(right > 0, `${pet}/${slot} cell is empty`);
      // A margin on all four sides is the proof that no neighbouring action
      // bleeds into this cell.
      assert.ok(left >= 1 && right <= cellWidth - 2, `${pet}/${slot} touches a cell side`);
      assert.ok(top >= 1 && bottom <= cellHeight - 2, `${pet}/${slot} touches a cell edge`);
    });
  }
});

test('poses of one action share a ground line and a body centre', () => {
  const groups = [
    ['walk-pass', 'walk-stride-a', 'walk-stride-b'],
    ['idle', 'idle-blink', 'idle-soft'],
    ['sleep-a', 'sleep-b'],
  ];
  for (const pet of PETS) {
    const atlas = decodePNG(petAsset(`${pet}-motion-atlas.png`));
    const cellWidth = atlas.width / ATLAS_COLUMNS;
    const cellHeight = atlas.height / ATLAS_ROWS;

    const measure = (slot) => {
      const index = ATLAS_SLOTS.indexOf(slot);
      const originX = (index % ATLAS_COLUMNS) * cellWidth;
      const originY = Math.floor(index / ATLAS_COLUMNS) * cellHeight;
      let bottom = 0;
      let sum = 0;
      let count = 0;
      for (let y = 0; y < cellHeight; y += 1) {
        for (let x = 0; x < cellWidth; x += 1) {
          if (atlas.data[((originY + y) * atlas.width + originX + x) * 4 + 3] <= ALPHA) continue;
          if (y > bottom) bottom = y;
        }
      }
      for (let y = bottom - Math.round(cellHeight * 0.08); y <= bottom; y += 1) {
        for (let x = 0; x < cellWidth; x += 1) {
          if (atlas.data[((originY + y) * atlas.width + originX + x) * 4 + 3] <= ALPHA) continue;
          sum += x;
          count += 1;
        }
      }
      return { bottom, centre: count ? sum / count : cellWidth / 2 };
    };

    for (const group of groups) {
      const measured = group.map(measure);
      const bottoms = measured.map((item) => item.bottom);
      const centres = measured.map((item) => item.centre);
      assert.ok(Math.max(...bottoms) - Math.min(...bottoms) <= 2,
        `${pet} ${group.join('/')} do not stand on the same ground line`);
      assert.ok(Math.max(...centres) - Math.min(...centres) <= cellWidth * 0.09,
        `${pet} ${group.join('/')} slide sideways between frames`);
    }
  }
});
