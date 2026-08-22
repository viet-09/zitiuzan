import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearSheet,
  decodeStroke,
  encodeStroke,
  loadSheet,
  MAX_SAVED_SHEETS,
  saveSheet,
  SHEET_STORAGE_KEY,
} from '../js/kanji-sheet-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() { return map.get(SHEET_STORAGE_KEY)?.length ?? 0; },
  };
}

const row = (strokes, accepted = 0) => ({ s: strokes, a: accepted });

test('a stroke survives the round trip within a thousandth of the square', () => {
  const drawn = [{ x: 0, y: 0 }, { x: 110, y: 55 }, { x: 220, y: 220 }];
  const back = decodeStroke(encodeStroke(drawn, 220), 220);
  assert.equal(back.length, drawn.length);
  for (let i = 0; i < drawn.length; i += 1) {
    assert.ok(Math.abs(back[i].x - drawn[i].x) < 0.25, `${back[i].x} vs ${drawn[i].x}`);
    assert.ok(Math.abs(back[i].y - drawn[i].y) < 0.25);
  }
});

test('points are stored as flat integers, not objects of floats', () => {
  // Ink is bulky enough that the encoding decides whether a sheet fits at all.
  const flat = encodeStroke([{ x: 55, y: 110 }], 220);
  assert.deepEqual(flat, [250, 500]);
  const objects = JSON.stringify([{ x: 55, y: 110 }]).length;
  assert.ok(JSON.stringify(flat).length < objects, 'flat integers must be the smaller form');
});

test('garbage points are dropped rather than persisted', () => {
  assert.deepEqual(encodeStroke([{ x: NaN, y: 1 }, { x: 1, y: undefined }, { x: 2, y: 2 }], 1000), [2, 2]);
  assert.deepEqual(encodeStroke(null, 1000), []);
  assert.deepEqual(decodeStroke([5], 1000), [], 'an odd tail is not half a point');
});

test('a half-written sheet comes back on the next open', () => {
  const storage = fakeStorage();
  saveSheet('k1d2', { 喫: { 1: row([[0, 0, 500, 500]], 2) } }, storage);
  const saved = loadSheet('k1d2', storage);
  assert.deepEqual(saved.rows['喫']['1'], { s: [[0, 0, 500, 500]], a: 2 });
  assert.ok(saved.savedAt > 0);
  assert.equal(loadSheet('k1d3', storage), null, 'other lessons are untouched');
});

test('an empty sheet is removed instead of stored', () => {
  const storage = fakeStorage();
  saveSheet('k1d2', { 喫: { 1: row([[1, 2]]) } }, storage);
  saveSheet('k1d2', { 喫: {} }, storage);
  assert.equal(loadSheet('k1d2', storage), null);

  saveSheet('k1d2', { 喫: { 1: row([[1, 2]]) } }, storage);
  clearSheet('k1d2', storage);
  assert.equal(loadSheet('k1d2', storage), null);
});

test('only the most recent sheets are kept, so storage cannot grow forever', () => {
  const storage = fakeStorage();
  // Frozen clock: every sheet then carries the same savedAt, which is exactly
  // when ordering by timestamp evicts the newest instead of the stalest — a
  // stable sort keeps ties in insertion order, oldest first.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    for (let index = 0; index < MAX_SAVED_SHEETS + 4; index += 1) {
      saveSheet(`lesson-${index}`, { 字: { 1: row([[index, index]]) } }, storage);
    }
  } finally {
    Date.now = realNow;
  }

  const all = JSON.parse(storage.getItem(SHEET_STORAGE_KEY));
  assert.equal(Object.keys(all).length, MAX_SAVED_SHEETS);
  assert.equal(new Set(Object.values(all).map((entry) => entry.savedAt)).size, 1, 'the tie must be real');
  for (let index = 0; index < 4; index += 1) {
    assert.equal(loadSheet(`lesson-${index}`, storage), null, `lesson-${index} should be evicted`);
  }
  for (let index = 4; index < MAX_SAVED_SHEETS + 4; index += 1) {
    assert.ok(loadSheet(`lesson-${index}`, storage), `lesson-${index} should survive`);
  }
});

test('a full quota costs the reload, never the stroke on screen', () => {
  const storage = fakeStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(saveSheet('k1d2', { 字: { 1: row([[1, 2]]) } }, storage), false);
});

test('the sheet saves after every stroke and is scoped to the account', () => {
  const sheet = read('js/kanji-sheet.js');
  // Saving only on close would lose the sheet whenever the learner simply
  // navigates away, which is most of the time.
  assert.match(sheet, /const persist = \(\) => \{ if \(lessonId\) saveSheet/);
  assert.equal((sheet.match(/\n\s+persist\(\);/g) || []).length, 2, 'both the free and checked paths must save');
  assert.match(sheet, /const restored = restore\(\);/);

  // Signing into a different account must not inherit the previous one's ink.
  assert.match(read('js/account-storage.js'), /'n2_kanji_sheet_v1',/);
});
