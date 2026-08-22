import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellRole, SHEET_LAYOUT } from '../js/kanji-sheet.js';
import { formatHanViet } from '../js/kanji-hanviet.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const hanviet = JSON.parse(read('data/kanji-hanviet.json'));

test('a row is a model square, a few checked squares, tracing, then blanks', () => {
  const roles = Array.from({ length: SHEET_LAYOUT.cells }, (_, index) => cellRole(index));
  assert.equal(roles[0], 'model');
  // Only the first few are checked; the rest is unaided drilling, and arguing
  // with a wobbly stroke fourteen times a row would make the sheet unusable.
  assert.equal(roles.filter((role) => role === 'guided').length, SHEET_LAYOUT.guided);
  assert.equal(SHEET_LAYOUT.guided, 3);
  assert.ok(roles.filter((role) => role === 'blank').length >= 4, 'needs room to write unaided');
  assert.deepEqual(roles.slice(0, 5), ['model', 'guided', 'guided', 'guided', 'traced']);
});

test('every square is its own canvas so page zoom keeps ink under the pen', () => {
  const sheet = read('js/kanji-sheet.js');
  // Coordinates are scaled by the live bounding box rather than assumed, which
  // is what makes writing work at any magnification.
  assert.match(sheet, /canvas\.width \/ rect\.width/);
  assert.match(sheet, /canvas\.height \/ rect\.height/);
});

test('a failing pointer capture cannot swallow the stroke', () => {
  // setPointerCapture throws when the browser no longer considers the pointer
  // active; running it before the stroke state was recorded lost the stroke.
  for (const file of ['js/kanji-sheet.js', 'js/kanji-writing.js']) {
    const source = read(file);
    assert.match(source, /try \{ canvas\.setPointerCapture\?\.\(event\.pointerId\); \} catch/, file);
  }
  const sheet = read('js/kanji-sheet.js');
  const recorded = sheet.indexOf('drawing = { canvas,');
  const captured = sheet.indexOf('canvas.setPointerCapture', recorded);
  assert.ok(recorded > 0 && captured > recorded, 'the stroke must be recorded before capture is attempted');
});

test('Hán Việt readings ship only where two sources agreed', () => {
  const characters = Object.keys(hanviet.readings);
  assert.ok(characters.length >= 650, `only ${characters.length} readings`);
  for (const [character, reading] of Object.entries(hanviet.readings)) {
    assert.match(character, /^\p{Script=Han}$/u);
    assert.match(reading, /^[a-zà-ỹ]+$/u, `${character}=${reading} must be a lowercase Vietnamese syllable`);
  }
  // Provenance is what makes the gap-filling defensible rather than a guess.
  const sources = new Set(Object.values(hanviet.provenance));
  assert.ok([...sources].every((source) => ['confirmed', 'two-pass', 'unihan'].includes(source)), [...sources].join(','));
  assert.match(hanviet.sources.unihan.url, /^https:\/\//);
});

test('readings the build could not settle are absent, not guessed', () => {
  // 込 and 畑 are kokuji — Japanese-made characters with no Hán Việt reading at
  // all, so inventing one would be teaching a fiction.
  for (const kokuji of ['込', '畑']) {
    assert.equal(hanviet.readings[kokuji], undefined, `${kokuji} must have no reading`);
  }
  assert.equal(formatHanViet(''), '');
  assert.equal(formatHanViet('cấm'), 'Cấm');
});

test('known readings are the Hán Việt one, not the Nôm reading Unihan carries', () => {
  // The whole reason for the two-pass build: Unihan answers 冷 with "lạnh".
  const expected = { 禁: 'cấm', 愛: 'ái', 冷: 'lãnh', 未: 'vị', 米: 'mễ', 関: 'quan', 鉄: 'thiết' };
  for (const [character, reading] of Object.entries(expected)) {
    assert.equal(hanviet.readings[character], reading, `${character} should read ${reading}`);
  }
});
