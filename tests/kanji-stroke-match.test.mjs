import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchStroke, polylineLength, resamplePolyline, STROKE_SAMPLES } from '../js/kanji-stroke-match.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strokeData = JSON.parse(fs.readFileSync(path.join(root, 'data', 'kanji-strokes.json'), 'utf8'));

/** A straight line in 0..1 space, as a learner's pointer would trace it. */
const line = (x1, y1, x2, y2, steps = 20) => Array.from({ length: steps }, (_, i) => ({
  x: x1 + ((x2 - x1) * i) / (steps - 1),
  y: y1 + ((y2 - y1) * i) / (steps - 1),
}));

const jitter = (points, amount) => points.map((point, index) => ({
  x: point.x + (index % 2 ? amount : -amount),
  y: point.y + (index % 3 ? -amount : amount),
}));

test('resampling spaces points evenly regardless of how fast the hand moved', () => {
  // Pointer events bunch up where the hand slowed; comparing raw samples would
  // score speed as much as shape.
  const uneven = [{ x: 0, y: 0 }, { x: 0.02, y: 0 }, { x: 0.04, y: 0 }, { x: 1, y: 0 }];
  const even = resamplePolyline(uneven, 5);
  assert.equal(even.length, 5);
  const gaps = even.slice(1).map((point, i) => point.x - even[i].x);
  for (const gap of gaps) assert.ok(Math.abs(gap - 0.25) < 1e-9, `uneven gap ${gap}`);
  assert.equal(resamplePolyline([{ x: 0.5, y: 0.5 }], 4).length, 4);
  assert.deepEqual(resamplePolyline([], 4), []);
  assert.ok(Math.abs(polylineLength(line(0, 0, 1, 0)) - 1) < 1e-9);
});

test('a stroke drawn along the guide is accepted despite a wobbly hand', () => {
  const expected = line(0.15, 0.5, 0.85, 0.5);
  assert.equal(matchStroke(jitter(expected, 0.02), expected).ok, true);
});

test('the same stroke drawn backwards is rejected as backwards, not misplaced', () => {
  // Direction is the whole point: 一 written right-to-left is the wrong stroke
  // even though the ink lands in exactly the same place.
  const expected = line(0.15, 0.5, 0.85, 0.5);
  const verdict = matchStroke(line(0.85, 0.5, 0.15, 0.5), expected);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'backwards');
});

test('a stroke in the wrong place is rejected even with the right shape', () => {
  // Normalising each stroke to its own box would accept this, which is what
  // makes position half of what "stroke order" means.
  const expected = line(0.15, 0.2, 0.85, 0.2);
  const verdict = matchStroke(line(0.15, 0.8, 0.85, 0.8), expected);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'wrong-place');
});

test('a dab at the right starting point is not the stroke', () => {
  const expected = line(0.15, 0.5, 0.85, 0.5);
  const verdict = matchStroke(line(0.15, 0.5, 0.22, 0.5), expected);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too-short');
});

test('every curriculum kanji ships ordered stroke paths under a credited licence', () => {
  assert.equal(strokeData.viewBox, 109);
  assert.match(strokeData.license.source, /KanjiVG/);
  assert.match(strokeData.license.licence, /CC BY-SA/);
  assert.match(strokeData.license.url, /^https:\/\//);

  const entries = Object.entries(strokeData.strokes);
  assert.ok(entries.length >= 680, `only ${entries.length} kanji`);
  for (const [character, paths] of entries) {
    assert.match(character, /^\p{Script=Han}$/u);
    assert.ok(Array.isArray(paths) && paths.length >= 1, `${character} has no strokes`);
    // Every path must open with a moveto, so a sampled polyline starts at the
    // stroke's own start point. SVG treats a leading `m` as absolute too, and
    // KanjiVG emits both cases.
    for (const d of paths) assert.match(d, /^[Mm]\s*-?[\d.]/, `${character}: ${d.slice(0, 12)}`);
  }
});

test('the shipped stroke counts agree with what the kanji cards print', () => {
  const lessons = JSON.parse(fs.readFileSync(path.join(root, 'data', 'book', 'kanji.json'), 'utf8'));
  const mismatches = [];
  for (const lesson of Object.values(lessons)) {
    for (const card of lesson?.kanji || []) {
      const paths = strokeData.strokes[card?.char];
      if (!paths || !card?.strokes) continue;
      if (paths.length !== card.strokes) mismatches.push(`${card.char} card=${card.strokes} kanjivg=${paths.length}`);
    }
  }
  // A disagreement means the pad would demand a stroke count the card denies.
  assert.deepEqual(mismatches, []);
});

test('a real multi-stroke kanji only accepts its strokes in order', () => {
  // 中: four strokes, and the third is the long vertical through the middle.
  const paths = strokeData.strokes['中'];
  assert.equal(paths.length, 4);

  // Sampling `d` needs a DOM, so approximate the KanjiVG vertical from its
  // endpoints: M52.5,11.5 running down to about y=100 at x≈54.6 (viewBox 109).
  const vertical = line(52.5 / 109, 11.5 / 109, 54.6 / 109, 100 / 109);
  const horizontal = line(23.3 / 109, 39.5 / 109, 89 / 109, 33.2 / 109);

  // The vertical is stroke 4; offered while stroke 2 is expected it must fail.
  assert.equal(matchStroke(vertical, horizontal).ok, false);
  assert.equal(matchStroke(horizontal, horizontal).ok, true);
  assert.equal(resamplePolyline(vertical).length, STROKE_SAMPLES);
});
