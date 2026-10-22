#!/usr/bin/env node

// Promote complete, two-pass extraction checkpoints into canonical book JSON,
// then regenerate the 233-lesson dashboard index and strict manifest.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK_DIR = join(ROOT, 'data', 'book');

const DEFINITIONS = [
  { id: 'kanji', prefix: 'k', name: 'Hán tự', nameEn: 'Kanji', days: [7, 7, 7, 7, 7, 7, 7, 7], unitType: 'week' },
  { id: 'vocabulary', prefix: 'v', name: 'Từ vựng', nameEn: 'Vocabulary', days: [7, 7, 7, 7, 7, 7, 7, 7], unitType: 'week' },
  { id: 'grammar', prefix: 'g', name: 'Ngữ pháp', nameEn: 'Grammar', days: [7, 7, 7, 7, 7, 7, 7, 7], unitType: 'week' },
  { id: 'reading', prefix: 'r', name: 'Đọc hiểu', nameEn: 'Reading', days: [7, 7, 7, 7, 7, 7], unitType: 'week' },
  { id: 'listening', prefix: 'l', name: 'Nghe hiểu', nameEn: 'Listening', days: [5, 7, 5, 5, 1], unitType: 'chapter' },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Same as readJson, but returns null when the file does not exist yet
 *  (first run) instead of throwing. */
function readJsonIfExists(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function idsFor(definition) {
  return definition.days.flatMap((count, unitIndex) => (
    Array.from({ length: count }, (_, dayIndex) => `${definition.prefix}${unitIndex + 1}d${dayIndex + 1}`)
  ));
}

const canonicalByCategory = new Map();
const manifestCategories = {};
const categories = [];

for (const definition of DEFINITIONS) {
  const draftPath = join(BOOK_DIR, `${definition.id}.draft.json`);
  const draft = readJson(draftPath);
  const expectedIds = idsFor(definition);
  const actualIds = Object.keys(draft);
  const missing = expectedIds.filter((id) => !Object.hasOwn(draft, id));
  const extra = actualIds.filter((id) => !expectedIds.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`${definition.id} draft coverage mismatch; missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`);
  }

  const canonical = Object.fromEntries(expectedIds.map((id) => [id, draft[id]]));
  canonicalByCategory.set(definition.id, canonical);
  writeJson(join(BOOK_DIR, `${definition.id}.json`), canonical);

  // Preserve enrichmentFiles from the existing manifest if present. If
  // finalize overwrites manifestCategories without copying enrichmentFiles,
  // loadBookContent in app.js stops loading classification, images, and
  // Vietnamese glosses.
  const existingManifest = readJsonIfExists(join(BOOK_DIR, 'manifest.json'));
  const existingEntry = existingManifest?.categories?.[definition.id];
  const enrichmentFiles = Array.isArray(existingEntry?.enrichmentFiles)
    ? existingEntry.enrichmentFiles
    : ['classification.json', 'images.json', 'vietnamese.json'];

  manifestCategories[definition.id] = {
    file: `${definition.id}.json`,
    prefix: definition.prefix,
    lessonIds: expectedIds,
    enrichmentFiles,
    complete: true,
  };

  categories.push({
    id: definition.id,
    name: definition.name,
    nameEn: definition.nameEn,
    unitType: definition.unitType,
    weeks: definition.days.map((dayCount, unitIndex) => ({
      week: unitIndex + 1,
      lessons: Array.from({ length: dayCount }, (_, dayIndex) => {
        const day = dayIndex + 1;
        const id = `${definition.prefix}${unitIndex + 1}d${day}`;
        const content = canonical[id];
        return {
          id,
          day,
          type: definition.id !== 'listening' && day === 7 ? 'practice' : 'lesson',
          title: String(content.title || ''),
          titleEn: String(content.titleEn || ''),
        };
      }),
    })),
  });
}

writeJson(join(BOOK_DIR, 'manifest.json'), {
  version: 2,
  sourceSpec: 'docs/EXTRACT_SPEC.md',
  categories: manifestCategories,
});

writeJson(join(ROOT, 'data', 'lessons.json'), {
  meta: {
    version: 3,
    source: 'User-owned 日本語総まとめ N2 scanned books',
    sourceSpec: 'docs/EXTRACT_SPEC.md',
    lessonCount: categories.reduce((sum, category) => sum + category.weeks.reduce((inner, week) => inner + week.lessons.length, 0), 0),
  },
  categories,
});

console.log('Promoted five canonical book files and regenerated data/lessons.json with 233 lessons.');
