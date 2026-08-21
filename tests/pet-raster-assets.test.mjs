import test from 'node:test';
import assert from 'node:assert/strict';
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
const ALPHA = 40;

test('fox and rabbit use transparent RGBA concept sprite sheets', () => {
  for (const name of ['fox-sprites.png', 'rabbit-sprites.png']) {
    const asset = fs.readFileSync(petAsset(name));
    assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(asset.readUInt32BE(16), 1536);
    assert.equal(asset.readUInt32BE(20), 1024);
    assert.equal(asset[25], 6, `${name} must be RGBA, not a baked checkerboard RGB image`);
  }
});

test('motion sprite sheets provide transparent multi-frame artwork for both pets', () => {
  for (const pet of PETS) {
    const asset = fs.readFileSync(petAsset(`${pet}-motion-sprites.png`));
    assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(asset.readUInt32BE(16) >= 1000, `${pet} needs room for five pose columns`);
    assert.ok(asset.readUInt32BE(20) >= 1000, `${pet} needs room for four pose rows`);
    assert.equal(asset[25], 6, `${pet} must preserve alpha transparency`);
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
