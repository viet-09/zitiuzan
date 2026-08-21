// scripts/build-kanji-strokes.mjs
// Builds data/kanji-strokes.json: the ordered stroke outlines for every kanji
// the curriculum teaches, so js/kanji-writing.js can check stroke order and
// direction instead of only showing a background glyph to trace.
//
// Source: KanjiVG (https://kanjivg.tagaini.net), Copyright (C) Ulrich Apel,
// distributed under CC BY-SA 3.0. The extracted paths stay under that licence —
// see the `license` block written into the output and docs/OPERATIONS.md.
//
// Each character keeps KanjiVG's `d` path strings verbatim, in stroke order.
// The runtime samples them with SVGPathElement.getPointAtLength rather than
// parsing curves here, so nothing has to reimplement bezier maths and the data
// stays a faithful copy of the source.
//
// Usage:
//   node scripts/build-kanji-strokes.mjs            # fetch what is missing
//   node scripts/build-kanji-strokes.mjs --refetch  # ignore the local cache

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'data', 'kanji-strokes.json');
const CACHE = path.join(os.tmpdir(), 'kanjivg-cache');
const BASE = 'https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji';
const CONCURRENCY = 6;

const REFETCH = process.argv.includes('--refetch');

/** Every kanji with its own card in the curriculum, in first-taught order. */
function collectCurriculumKanji() {
  const lessons = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'book', 'kanji.json'), 'utf8'));
  const seen = new Map();
  for (const [lessonId, lesson] of Object.entries(lessons)) {
    for (const card of lesson?.kanji || []) {
      for (const character of String(card?.char || '')) {
        // Only real kanji — a card's `char` can carry punctuation or kana.
        if (!/\p{Script=Han}/u.test(character)) continue;
        if (!seen.has(character)) seen.set(character, { lessonId, strokes: Number(card?.strokes) || 0 });
      }
    }
  }
  return seen;
}

const codepointFile = (character) => `${character.codePointAt(0).toString(16).padStart(5, '0')}.svg`;

async function fetchSvg(character) {
  const name = codepointFile(character);
  const cached = path.join(CACHE, name);
  if (!REFETCH && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/${name}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(cached, body);
      return body;
    } catch (error) {
      if (attempt === 3) throw new Error(`${character} (${name}): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  return null;
}

/**
 * Ordered `d` strings for one character.
 *
 * KanjiVG numbers its stroke paths `kvg:{code}-s1`, `-s2`, … in writing order
 * and nests them in element groups, so document order alone is not the stroke
 * order — the suffix is what has to be sorted on.
 */
function extractStrokePaths(svg) {
  const strokes = [];
  const pattern = /<path[^>]*\bid="kvg:[0-9a-f]+(?:-v\d+)?-s(\d+)"[^>]*\bd="([^"]+)"/g;
  for (const match of svg.matchAll(pattern)) {
    strokes.push({ order: Number(match[1]), d: match[2].trim() });
  }
  strokes.sort((a, b) => a.order - b.order);
  return strokes.map((stroke) => stroke.d);
}

/** Run `worker` over `items` with a bounded number of requests in flight. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

const curriculum = collectCurriculumKanji();
const characters = [...curriculum.keys()];
console.log(`${characters.length} kanji in the curriculum; fetching stroke data…`);

const missing = [];
const mismatched = [];
const strokesByCharacter = {};

await mapLimit(characters, CONCURRENCY, async (character, index) => {
  const svg = await fetchSvg(character);
  if (!svg) {
    missing.push(character);
    return;
  }
  const paths = extractStrokePaths(svg);
  if (!paths.length) {
    missing.push(character);
    return;
  }
  strokesByCharacter[character] = paths;

  // The book prints a stroke count per card; a disagreement means one of the
  // two sources is wrong for this character, and silently trusting KanjiVG
  // would make the pad reject a correctly written stroke.
  const expected = curriculum.get(character).strokes;
  if (expected && expected !== paths.length) {
    mismatched.push(`${character} book=${expected} kanjivg=${paths.length}`);
  }
  if ((index + 1) % 100 === 0) console.log(`  …${index + 1}/${characters.length}`);
});

const output = {
  license: {
    source: 'KanjiVG',
    url: 'https://kanjivg.tagaini.net',
    copyright: 'Copyright (C) Ulrich Apel',
    licence: 'CC BY-SA 3.0',
    note: 'Stroke paths are extracted verbatim; the viewBox is 109x109.',
  },
  viewBox: 109,
  strokes: Object.fromEntries(
    // Sorted so the file has a stable diff between runs.
    Object.entries(strokesByCharacter).sort(([a], [b]) => a.localeCompare(b, 'ja')),
  ),
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);

const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
console.log(`Wrote ${Object.keys(output.strokes).length} kanji to data/kanji-strokes.json (${kb} KB)`);
if (missing.length) console.warn(`! no KanjiVG entry for ${missing.length}: ${missing.join('')}`);
if (mismatched.length) {
  console.warn(`! stroke-count disagreements (${mismatched.length}):`);
  for (const line of mismatched) console.warn(`    ${line}`);
}
