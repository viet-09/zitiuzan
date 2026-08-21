#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK_DIR = join(ROOT, 'data', 'book');
const MANIFEST_PATH = join(BOOK_DIR, 'manifest.json');
const LESSONS_PATH = join(ROOT, 'data', 'lessons.json');

const CATEGORY_DEFINITIONS = Object.freeze({
  grammar: Object.freeze({ prefix: 'g', daysByWeek: Object.freeze([7, 7, 7, 7, 7, 7, 7, 7]) }),
  kanji: Object.freeze({ prefix: 'k', daysByWeek: Object.freeze([7, 7, 7, 7, 7, 7, 7, 7]) }),
  reading: Object.freeze({ prefix: 'r', daysByWeek: Object.freeze([7, 7, 7, 7, 7, 7]) }),
  listening: Object.freeze({ prefix: 'l', daysByWeek: Object.freeze([5, 7, 5, 5, 1]) }),
  vocabulary: Object.freeze({ prefix: 'v', daysByWeek: Object.freeze([7, 7, 7, 7, 7, 7, 7, 7]) }),
});

const errors = [];
const warnings = [];
const canonicalContentByCategory = new Map();
let validatedFiles = 0;
let validatedLessons = 0;
let validatedQuestions = 0;

function diagnostic(target, code, location, message) {
  target.push({ code, location, message });
}

function fail(code, location, message) {
  diagnostic(errors, code, location, message);
}

function warn(code, location, message) {
  diagnostic(warnings, code, location, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatList(values, limit = 12) {
  const list = [...values];
  if (list.length <= limit) return list.join(', ');
  return `${list.slice(0, limit).join(', ')} … (+${list.length - limit})`;
}

/** Find duplicate keys in every JSON object before JSON.parse overwrites them. */
function findDuplicateObjectKeys(text) {
  let index = 0;
  const duplicates = new Set();

  function skipWhitespace() {
    while (/\s/.test(text[index] || '')) index += 1;
  }

  function parseStringToken() {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      index += 1;
      if (!escaped && character === '"') return JSON.parse(text.slice(start, index));
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
    }
    throw new Error('Unterminated JSON string.');
  }

  function parseValue(path) {
    skipWhitespace();
    if (text[index] === '{') {
      parseObject(path);
      return;
    }
    if (text[index] === '[') {
      parseArray(path);
      return;
    }
    if (text[index] === '"') {
      parseStringToken();
      return;
    }
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index += 1;
  }

  function parseObject(path) {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      if (text[index] !== '"') throw new Error('Expected an object key.');
      const key = parseStringToken();
      const keyPath = path ? `${path}.${key}` : key;
      if (keys.has(key)) duplicates.add(keyPath);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') throw new Error('Expected a colon after an object key.');
      index += 1;
      parseValue(keyPath);
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      if (text[index] !== ',') throw new Error('Expected a comma between object members.');
      index += 1;
    }
  }

  function parseArray(path) {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    let itemIndex = 0;
    while (index < text.length) {
      parseValue(`${path}[${itemIndex}]`);
      itemIndex += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      if (text[index] !== ',') throw new Error('Expected a comma between array items.');
      index += 1;
    }
  }

  try {
    parseValue('');
  } catch {
    // JSON.parse below reports malformed syntax; duplicate scanning stays best-effort.
  }
  return [...duplicates];
}

function parseJsonFile(path, label, { checkDuplicateKeys = true } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    fail('FILE_READ', label, error instanceof Error ? error.message : 'Cannot read file.');
    return null;
  }

  if (checkDuplicateKeys) {
    const duplicates = findDuplicateObjectKeys(text);
    if (duplicates.length > 0) {
      fail('DUPLICATE_JSON_KEY', label, `Duplicate object key path(s): ${formatList(duplicates)}.`);
    }
  }

  try {
    validatedFiles += 1;
    return JSON.parse(text);
  } catch (error) {
    fail('JSON_PARSE', label, error instanceof Error ? error.message : 'Malformed JSON.');
    return null;
  }
}

function requireRecord(value, location) {
  if (!isRecord(value)) {
    fail('TYPE_OBJECT', location, 'Expected an object.');
    return false;
  }
  return true;
}

function requireArray(value, location, { min = 0 } = {}) {
  if (!Array.isArray(value)) {
    fail('TYPE_ARRAY', location, 'Expected an array.');
    return false;
  }
  if (value.length < min) fail('ARRAY_LENGTH', location, `Expected at least ${min} item(s).`);
  return true;
}

function requireString(value, location, { nonEmpty = false } = {}) {
  if (typeof value !== 'string') {
    fail('TYPE_STRING', location, 'Expected a string.');
    return false;
  }
  if (nonEmpty && value.trim() === '') fail('EMPTY_STRING', location, 'Must not be empty.');
  return true;
}

function requireInteger(value, location, { min, max } = {}) {
  if (!Number.isInteger(value)) {
    fail('TYPE_INTEGER', location, 'Expected an integer.');
    return false;
  }
  if (min !== undefined && value < min) fail('INTEGER_RANGE', location, `Must be at least ${min}.`);
  if (max !== undefined && value > max) fail('INTEGER_RANGE', location, `Must be at most ${max}.`);
  return true;
}

function validateFuriganaString(value, location) {
  if (/<\/?(?:ruby|rt)>/iu.test(value)) {
    fail('RAW_RUBY_HTML', location, 'Use {base|reading} data markup instead of literal ruby HTML.');
  }
  let index = 0;
  while (index < value.length) {
    if (value[index] === '}') {
      fail('FURIGANA_BRACES', location, `Stray closing brace at character ${index + 1}.`);
      index += 1;
      continue;
    }
    if (value[index] !== '{') {
      index += 1;
      continue;
    }

    const close = value.indexOf('}', index + 1);
    if (close === -1) {
      fail('FURIGANA_BRACES', location, `Opening brace at character ${index + 1} has no closing brace.`);
      return;
    }
    const inner = value.slice(index + 1, close);
    if (inner.includes('{')) {
      fail('FURIGANA_BRACES', location, `Nested opening brace near character ${index + 1}.`);
    }
    const parts = inner.split('|');
    if (parts.length !== 2 || parts[0].trim() === '' || parts[1].trim() === '') {
      fail('FURIGANA_MARKUP', location, `Expected {base|reading}; found {${inner}}.`);
    }
    index = close + 1;
  }
}

function validateFuriganaDeep(value, location) {
  if (typeof value === 'string') {
    validateFuriganaString(value, location);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateFuriganaDeep(item, `${location}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      // `form`/`connection` transcribe the book's own conjugation-grouping braces, not
      // furigana markup (see validateGrammarLesson) — skip the {base|reading} brace grammar.
      if (key === 'form' || key === 'connection') continue;
      validateFuriganaDeep(item, `${location}.${key}`);
    }
  }
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateStringArray(value, location, { min = 0, nonEmpty = false } = {}) {
  if (!requireArray(value, location, { min })) return false;
  value.forEach((item, index) => requireString(item, `${location}[${index}]`, { nonEmpty }));
  return true;
}

function validateQuestion(value, location) {
  if (!requireRecord(value, location)) return;
  requireString(value.prompt, `${location}.prompt`, { nonEmpty: true });
  const hasOptions = validateStringArray(value.options, `${location}.options`, { min: 2, nonEmpty: true });
  if (requireInteger(value.answerIndex, `${location}.answerIndex`, { min: -1 }) && hasOptions) {
    if (value.answerIndex >= value.options.length) {
      fail(
        'ANSWER_INDEX_BOUNDS',
        `${location}.answerIndex`,
        `Index ${value.answerIndex} is outside options[0..${value.options.length - 1}]; use -1 when unresolved.`,
      );
    }
  }
  if (hasOptions) {
    const duplicates = findDuplicates(value.options);
    if (duplicates.length > 0) {
      warn('DUPLICATE_OPTIONS', `${location}.options`, `Repeated option(s): ${formatList(duplicates)}.`);
    }
  }
  validatedQuestions += 1;
}

function validateQuestions(value, location) {
  if (!requireArray(value, location)) return;
  value.forEach((question, index) => validateQuestion(question, `${location}[${index}]`));
}

function validateKanjiEntry(value, location) {
  if (!requireRecord(value, location)) return;
  if (requireString(value.char, `${location}.char`, { nonEmpty: true })) {
    if ([...value.char].length !== 1) fail('KANJI_CHAR', `${location}.char`, 'Expected exactly one character.');
  }
  requireInteger(value.strokes, `${location}.strokes`, { min: 1 });
  requireString(value.on, `${location}.on`);
  requireString(value.kun, `${location}.kun`);
  if (!requireArray(value.words, `${location}.words`)) return;

  const wordKeys = [];
  value.words.forEach((word, index) => {
    const wordLocation = `${location}.words[${index}]`;
    if (!requireRecord(word, wordLocation)) return;
    requireString(word.jp, `${wordLocation}.jp`, { nonEmpty: true });
    requireString(word.reading, `${wordLocation}.reading`);
    requireString(word.en, `${wordLocation}.en`);
    if (typeof word.jp === 'string' && typeof word.reading === 'string') {
      wordKeys.push(`${word.jp}\u0000${word.reading}`);
    }
  });
  const duplicates = findDuplicates(wordKeys).map((key) => key.replace('\u0000', ' / '));
  if (duplicates.length > 0) fail('DUPLICATE_WORD', location, `Duplicate word(s): ${formatList(duplicates)}.`);
}

function validateKanjiLesson(value, id, location) {
  if (!requireRecord(value, location)) return;
  requireString(value.title, `${location}.title`, { nonEmpty: true });
  requireString(value.titleEn, `${location}.titleEn`);

  const arrays = [
    ['kanji', value.kanji],
    ['reviewKanji', value.reviewKanji],
  ];
  const characters = [];
  for (const [field, list] of arrays) {
    const fieldLocation = `${location}.${field}`;
    if (!requireArray(list, fieldLocation)) continue;
    list.forEach((entry, index) => {
      validateKanjiEntry(entry, `${fieldLocation}[${index}]`);
      if (isRecord(entry) && typeof entry.char === 'string') characters.push(entry.char);
    });
  }

  const dayMatch = /^k\d+d(\d+)$/.exec(id);
  if (dayMatch && Number(dayMatch[1]) !== 7 && Array.isArray(value.reviewKanji) && value.reviewKanji.length > 0) {
    fail('REVIEW_KANJI_DAY', `${location}.reviewKanji`, 'Review kanji may only appear on a day-7 lesson.');
  }
  const duplicates = findDuplicates(characters);
  if (duplicates.length > 0) fail('DUPLICATE_KANJI', location, `Duplicate kanji character(s): ${formatList(duplicates)}.`);
  validateQuestions(value.practice, `${location}.practice`);
}

function isPracticeDay(id) {
  const match = /^[a-z]\d+d(\d+)$/.exec(id);
  return Boolean(match) && Number(match[1]) === 7;
}

function validateVocabularyLesson(value, id, location) {
  if (!requireRecord(value, location)) return;
  requireString(value.title, `${location}.title`, { nonEmpty: true });
  requireString(value.titleEn, `${location}.titleEn`);
  // Day 7 (実戦問題) is a pure practice-exam day with no new vocabulary sections.
  const sectionsMin = isPracticeDay(id) ? 0 : 1;
  if (requireArray(value.sections, `${location}.sections`, { min: sectionsMin })) {
    value.sections.forEach((section, sectionIndex) => {
      const sectionLocation = `${location}.sections[${sectionIndex}]`;
      if (!requireRecord(section, sectionLocation)) return;
      requireString(section.heading, `${sectionLocation}.heading`);
      if (!requireArray(section.words, `${sectionLocation}.words`, { min: 1 })) return;
      section.words.forEach((word, wordIndex) => {
        const wordLocation = `${sectionLocation}.words[${wordIndex}]`;
        if (!requireRecord(word, wordLocation)) return;
        requireString(word.jp, `${wordLocation}.jp`, { nonEmpty: true });
        requireString(word.reading, `${wordLocation}.reading`);
        requireString(word.en, `${wordLocation}.en`);
        requireString(word.note, `${wordLocation}.note`);
        if (typeof word.jp === 'string' && typeof word.reading === 'string') {
          const visibleJapanese = word.jp.replace(/<[^>]{1,8}>/gu, '');
          if (/[一-龯㐀-䶿々]/u.test(visibleJapanese) && word.reading.trim() === '') {
            fail('VOCAB_READING_MISSING', `${wordLocation}.reading`, 'Vocabulary containing kanji needs a verified reading.');
          }
          if (/おじゃします|寝り心地|居り心地|英養|ととい合わせ|暮した/u.test(`${word.jp}\n${word.reading}`)) {
            fail('KNOWN_OCR_REGRESSION', wordLocation, 'Known OCR-corrupted Japanese string reintroduced.');
          }
        }
      });
    });
  }
  validateQuestions(value.practice, `${location}.practice`);
}

function validateGrammarLesson(value, id, location) {
  if (!requireRecord(value, location)) return;
  requireString(value.title, `${location}.title`, { nonEmpty: true });
  requireString(value.titleEn, `${location}.titleEn`);
  // Day 7 (実戦問題) is a pure practice-exam day with no new grammar patterns.
  const patternsMin = isPracticeDay(id) ? 0 : 1;
  if (requireArray(value.patterns, `${location}.patterns`, { min: patternsMin })) {
    value.patterns.forEach((pattern, patternIndex) => {
      const patternLocation = `${location}.patterns[${patternIndex}]`;
      if (!requireRecord(pattern, patternLocation)) return;
      // `form`/`connection` transcribe the book's own conjugation-grouping braces (e.g. a
      // brace spanning "Vる/Vた/Vている" printed beside one form) — not furigana markup —
      // so they're exempt from the {base|reading} brace grammar checked elsewhere.
      requireString(pattern.form, `${patternLocation}.form`, { nonEmpty: true });
      requireString(pattern.meaningEn, `${patternLocation}.meaningEn`);
      requireString(pattern.connection, `${patternLocation}.connection`);
      if (!requireArray(pattern.examples, `${patternLocation}.examples`)) return;
      pattern.examples.forEach((example, exampleIndex) => {
        const exampleLocation = `${patternLocation}.examples[${exampleIndex}]`;
        if (!requireRecord(example, exampleLocation)) return;
        requireString(example.jp, `${exampleLocation}.jp`, { nonEmpty: true });
        requireString(example.en, `${exampleLocation}.en`);
      });
    });
  }
  validateQuestions(value.practice, `${location}.practice`);
}

function validateReadingLesson(value, _id, location) {
  if (!requireRecord(value, location)) return;
  requireString(value.title, `${location}.title`, { nonEmpty: true });
  requireString(value.titleEn, `${location}.titleEn`);
  requireString(value.intro, `${location}.intro`);
  if (requireArray(value.passages, `${location}.passages`, { min: 1 })) {
    value.passages.forEach((passage, passageIndex) => {
      const passageLocation = `${location}.passages[${passageIndex}]`;
      if (!requireRecord(passage, passageLocation)) return;
      requireString(passage.heading, `${passageLocation}.heading`);
      requireString(passage.text, `${passageLocation}.text`, { nonEmpty: true });
    });
  }
  validateQuestions(value.questions, `${location}.questions`);
}

function validateListeningLesson(value, _id, location) {
  if (!requireRecord(value, location)) return;
  requireString(value.title, `${location}.title`, { nonEmpty: true });
  requireString(value.titleEn, `${location}.titleEn`);
  requireString(value.audio, `${location}.audio`);
  const validateTracks = (tracks, field) => {
    const trackLocation = `${location}.${field}`;
    if (!requireArray(tracks, trackLocation)) return [];
    const labels = [];
    const sources = [];
    tracks.forEach((track, index) => {
      const itemLocation = `${trackLocation}[${index}]`;
      if (!requireRecord(track, itemLocation)) return;
      if (requireString(track.label, `${itemLocation}.label`, { nonEmpty: true })) labels.push(track.label);
      if (requireString(track.src, `${itemLocation}.src`, { nonEmpty: true })) {
        sources.push(track.src);
        if (!/^cd[12]\/\d{2}\.mp3$/.test(track.src)) {
          fail('AUDIO_PATH', `${itemLocation}.src`, 'Expected a release audio key such as cd1/02.mp3 (see js/audio-source.js).');
        }
      }
    });
    const duplicateLabels = findDuplicates(labels);
    const duplicateSources = findDuplicates(sources);
    if (duplicateLabels.length) fail('DUPLICATE_AUDIO_LABEL', trackLocation, `Duplicate label(s): ${formatList(duplicateLabels)}.`);
    if (duplicateSources.length) fail('DUPLICATE_AUDIO_SOURCE', trackLocation, `Duplicate source(s): ${formatList(duplicateSources)}.`);
    return tracks;
  };
  const audioTracks = validateTracks(value.audioTracks, 'audioTracks');
  validateTracks(value.introTracks, 'introTracks');
  if (requireRecord(value.audioCoverage, `${location}.audioCoverage`)) {
    const coverage = value.audioCoverage;
    requireInteger(coverage.required, `${location}.audioCoverage.required`, { min: 1 });
    requireInteger(coverage.present, `${location}.audioCoverage.present`, { min: 0 });
    requireInteger(coverage.missing, `${location}.audioCoverage.missing`, { min: 0 });
    requireString(coverage.status, `${location}.audioCoverage.status`, { nonEmpty: true });
    if (!['complete', 'partial', 'missing'].includes(coverage.status)) {
      fail('AUDIO_STATUS', `${location}.audioCoverage.status`, 'Expected complete, partial, or missing.');
    }
    if (Number.isInteger(coverage.required) && Number.isInteger(coverage.present)
        && Number.isInteger(coverage.missing)) {
      if (coverage.present !== audioTracks.length) {
        fail('AUDIO_PRESENT_COUNT', `${location}.audioCoverage.present`, `Expected ${audioTracks.length} from audioTracks.`);
      }
      if (coverage.missing !== coverage.required - coverage.present) {
        fail('AUDIO_MISSING_COUNT', `${location}.audioCoverage.missing`, 'Expected required - present.');
      }
      const expectedStatus = coverage.present === coverage.required
        ? 'complete'
        : coverage.present > 0 ? 'partial' : 'missing';
      if (coverage.status !== expectedStatus) {
        fail('AUDIO_STATUS_COUNT', `${location}.audioCoverage.status`, `Expected ${expectedStatus} for these counts.`);
      }
    }
  }
  const expectedPrimary = audioTracks[0]?.src || '';
  if (typeof value.audio === 'string' && value.audio !== expectedPrimary) {
    fail('AUDIO_PRIMARY', `${location}.audio`, `Expected first available core track or empty string (${expectedPrimary || 'empty'}).`);
  }
  requireString(value.script, `${location}.script`);
  validateQuestions(value.questions, `${location}.questions`);
}

const ENRICHMENT_TYPE_WHITELIST = Object.freeze({
  kanji: ['kanji-yomi', 'kanji-toroku', 'kanji-hanbetsu', 'kanji-sakubun'],
  vocabulary: ['vocab-fukugougo', 'vocab-rentai', 'vocab-yougo'],
  grammar: ['grammar-bunpou', 'grammar-hyougen', 'grammar-tadose'],
  reading: ['reading-shusho', 'reading-riyuu', 'reading-chikoku', 'reading-josou', 'reading-mix'],
  listening: ['listening-kadai', 'listening-point', 'listening-gaiyou', 'listening-imamashii'],
});

function validateEnrichmentFile(category, content, lessonIds, fileLabel) {
  if (!isRecord(content)) {
    fail('TYPE_OBJECT', fileLabel, 'Expected an object keyed by lesson ID.');
    return;
  }
  const whitelist = ENRICHMENT_TYPE_WHITELIST[category] || [];
  for (const [id, body] of Object.entries(content)) {
    if (!lessonIds.has(id)) {
      fail('ENRICHMENT_UNKNOWN_LESSON', `${fileLabel}.${id}`, 'Lesson ID not in canonical book.');
      continue;
    }
    if (!isRecord(body) || !requireArray(body.questions, `${fileLabel}.${id}.questions`)) continue;
    const seenIdx = new Set();
    body.questions.forEach((item, qIdx) => {
      const loc = `${fileLabel}.${id}.questions[${qIdx}]`;
      if (!isRecord(item)) { fail('TYPE_OBJECT', loc, 'Expected an object.'); return; }
      if (!requireInteger(item.index, `${loc}.index`, { min: 0 })) return;
      if (seenIdx.has(item.index)) fail('ENRICHMENT_DUP_INDEX', `${loc}.index`, `Duplicate index ${item.index} in lesson ${id}.`);
      seenIdx.add(item.index);
      if (typeof item.type !== 'string' || !whitelist.includes(item.type)) {
        fail('ENRICHMENT_TYPE', `${loc}.type`, `Type "${item.type}" not in whitelist for ${category}.`);
      }
      // descriptionVi is optional (kept in JSON for re-runs); renderer uses the original
      // Japanese prompt from the canonical book instead.
      if (item.descriptionVi !== undefined && (typeof item.descriptionVi !== 'string' || item.descriptionVi.length > 200)) {
        warn('ENRICHMENT_DESC_LONG', `${loc}.descriptionVi`, 'Description must be string ≤ 200 chars.');
      }
    });
  }
}

function validateImagesFile(category, content, lessonIds, fileLabel) {
  if (!isRecord(content)) {
    fail('TYPE_OBJECT', fileLabel, 'Expected an object keyed by lesson ID.');
    return;
  }
  const imgRoot = resolve(BOOK_DIR, 'images', category);
  for (const [id, entries] of Object.entries(content)) {
    if (!lessonIds.has(id)) {
      fail('IMAGES_UNKNOWN_LESSON', `${fileLabel}.${id}`, 'Lesson ID not in canonical book.');
      continue;
    }
    if (!Array.isArray(entries)) { fail('TYPE_ARRAY', `${fileLabel}.${id}`, 'Expected an array.'); continue; }
    entries.forEach((entry, itemIdx) => {
      const loc = `${fileLabel}.${id}[${itemIdx}]`;
      if (!isRecord(entry)) { fail('TYPE_OBJECT', loc, 'Expected an object.'); return; }
      if (typeof entry.src !== 'string' || entry.src.includes('..') || entry.src.includes('\\')
          || !entry.src.startsWith(`images/${category}/`)) {
        fail('IMAGES_SRC_PATH', `${loc}.src`, `Expected forward-slash path under images/${category}/ with no traversal.`);
      } else {
        const abs = resolve(BOOK_DIR, entry.src);
        if (!abs.startsWith(imgRoot)) {
          fail('IMAGES_SRC_TRAVERSAL', `${loc}.src`, 'Path resolves outside category image dir.');
        }
      }
      if (entry.kind !== undefined && entry.kind !== 'image' && entry.kind !== 'page') {
        fail('IMAGES_KIND', `${loc}.kind`, 'Expected "image" or "page".');
      }
      if (entry.captionVi !== undefined && (typeof entry.captionVi !== 'string' || entry.captionVi.length > 200)) {
        warn('IMAGES_CAPTION', `${loc}.captionVi`, 'Caption must be string ≤ 200 chars.');
      }
    });
  }
}

function expectedVietnameseItems(category, lesson) {
  if (!isRecord(lesson)) return 0;
  if (category === 'kanji') {
    return (Array.isArray(lesson.kanji) ? lesson.kanji.length : 0)
      + (Array.isArray(lesson.reviewKanji) ? lesson.reviewKanji.length : 0);
  }
  if (category === 'vocabulary') {
    return (Array.isArray(lesson.sections) ? lesson.sections : [])
      .reduce((total, section) => total + (Array.isArray(section?.words) ? section.words.length : 0), 0);
  }
  if (category === 'grammar') return Array.isArray(lesson.patterns) ? lesson.patterns.length : 0;
  return 0;
}

function validateVietnameseFile(category, content, lessonIds, fileLabel) {
  if (!isRecord(content)) {
    fail('TYPE_OBJECT', fileLabel, 'Expected an object keyed by lesson ID.');
    return;
  }
  const canonical = canonicalContentByCategory.get(category) || {};
  const vietnameseSignal = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu;
  for (const [id, entries] of Object.entries(content)) {
    const location = `${fileLabel}.${id}`;
    if (!lessonIds.has(id)) {
      fail('VI_UNKNOWN_LESSON', location, 'Lesson ID not in canonical book.');
      continue;
    }
    if (!requireArray(entries, location)) continue;
    const expected = expectedVietnameseItems(category, canonical[id]);
    if (entries.length !== expected) {
      fail('VI_ITEM_COUNT', location, `Expected ${expected} explanation(s) in canonical display order; found ${entries.length}.`);
    }
    entries.forEach((entry, index) => {
      const itemLocation = `${location}[${index}]`;
      if (!requireString(entry, itemLocation, { nonEmpty: true })) return;
      if (entry.length > 500) fail('VI_TEXT_LENGTH', itemLocation, 'Vietnamese explanation must be at most 500 characters.');
      if (!vietnameseSignal.test(entry)) {
        fail('VI_DIACRITICS', itemLocation, 'Vietnamese copy must include normal diacritics; unaccented generated prose is not release-ready.');
      }
    });
  }
}

const SCHEMA_VALIDATORS = Object.freeze({
  kanji: validateKanjiLesson,
  vocabulary: validateVocabularyLesson,
  grammar: validateGrammarLesson,
  reading: validateReadingLesson,
  listening: validateListeningLesson,
});

function expectedIds(category) {
  const definition = CATEGORY_DEFINITIONS[category];
  if (!definition) return [];
  const ids = [];
  definition.daysByWeek.forEach((days, weekIndex) => {
    for (let day = 1; day <= days; day += 1) ids.push(`${definition.prefix}${weekIndex + 1}d${day}`);
  });
  return ids;
}

function compareSets(actualValues, expectedValues, location, actualLabel, expectedLabel) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  if (missing.length > 0) {
    fail('COVERAGE_MISSING', location, `Missing ${expectedLabel}: ${formatList(missing)}.`);
  }
  if (unexpected.length > 0) {
    fail('COVERAGE_UNEXPECTED', location, `Unexpected ${actualLabel}: ${formatList(unexpected)}.`);
  }
}

function validateLessonsIndex(lessons) {
  const idsByCategory = new Map();
  const allIds = [];
  if (!requireRecord(lessons, 'data/lessons.json')) return idsByCategory;
  if (!requireArray(lessons.categories, 'data/lessons.json.categories')) return idsByCategory;

  const categoryIds = [];
  lessons.categories.forEach((category, categoryIndex) => {
    const location = `data/lessons.json.categories[${categoryIndex}]`;
    if (!requireRecord(category, location)) return;
    if (!requireString(category.id, `${location}.id`, { nonEmpty: true })) return;
    categoryIds.push(category.id);
    const definition = CATEGORY_DEFINITIONS[category.id];
    if (!definition) {
      fail('CATEGORY_UNKNOWN', `${location}.id`, `Unsupported category "${category.id}".`);
      return;
    }
    const categoryLessonIds = [];
    if (!requireArray(category.weeks, `${location}.weeks`)) return;
    category.weeks.forEach((week, weekIndex) => {
      const weekLocation = `${location}.weeks[${weekIndex}]`;
      if (!requireRecord(week, weekLocation)) return;
      const validWeek = requireInteger(week.week, `${weekLocation}.week`, { min: 1 });
      if (!requireArray(week.lessons, `${weekLocation}.lessons`)) return;
      week.lessons.forEach((lesson, lessonIndex) => {
        const lessonLocation = `${weekLocation}.lessons[${lessonIndex}]`;
        if (!requireRecord(lesson, lessonLocation)) return;
        if (!requireString(lesson.id, `${lessonLocation}.id`, { nonEmpty: true })) return;
        const pattern = new RegExp(`^${definition.prefix}([1-9]\\d*)d([1-9]\\d*)$`);
        const match = pattern.exec(lesson.id);
        if (!match) {
          fail('LESSON_ID_PATTERN', `${lessonLocation}.id`, `Expected ${definition.prefix}<week>d<day>; found "${lesson.id}".`);
        } else {
          if (validWeek && Number(match[1]) !== week.week) {
            fail('LESSON_ID_WEEK', `${lessonLocation}.id`, `ID week ${match[1]} does not match container week ${week.week}.`);
          }
          if (lesson.day !== undefined && Number(match[2]) !== Number(lesson.day)) {
            fail('LESSON_ID_DAY', `${lessonLocation}.id`, `ID day ${match[2]} does not match lesson.day ${lesson.day}.`);
          }
        }
        categoryLessonIds.push(lesson.id);
        allIds.push(lesson.id);
      });
    });
    const duplicates = findDuplicates(categoryLessonIds);
    if (duplicates.length > 0) fail('DUPLICATE_LESSON_ID', location, `Duplicate lesson ID(s): ${formatList(duplicates)}.`);
    idsByCategory.set(category.id, categoryLessonIds);
    compareSets(categoryLessonIds, expectedIds(category.id), location, 'lesson IDs', 'book lesson IDs');
  });

  const duplicateCategories = findDuplicates(categoryIds);
  if (duplicateCategories.length > 0) {
    fail('DUPLICATE_CATEGORY', 'data/lessons.json.categories', `Duplicate category ID(s): ${formatList(duplicateCategories)}.`);
  }
  const duplicateIds = findDuplicates(allIds);
  if (duplicateIds.length > 0) {
    fail('DUPLICATE_LESSON_ID', 'data/lessons.json', `Duplicate global lesson ID(s): ${formatList(duplicateIds)}.`);
  }
  compareSets(categoryIds, Object.keys(CATEGORY_DEFINITIONS), 'data/lessons.json.categories', 'categories', 'book categories');
  return idsByCategory;
}

function canonicalFilesOnDisk() {
  try {
    const canonicalNames = new Set(Object.keys(CATEGORY_DEFINITIONS).map((category) => `${category}.json`));
    return readdirSync(BOOK_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && canonicalNames.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    fail('BOOK_DIR_READ', 'data/book', error instanceof Error ? error.message : 'Cannot read directory.');
    return [];
  }
}

function validateManifest(manifest, lessonIdsByCategory) {
  if (!requireRecord(manifest, 'data/book/manifest.json')) return;
  requireInteger(manifest.version, 'data/book/manifest.json.version', { min: 1 });
  requireString(manifest.sourceSpec, 'data/book/manifest.json.sourceSpec', { nonEmpty: true });
  if (!requireRecord(manifest.categories, 'data/book/manifest.json.categories')) return;

  const manifestCategories = Object.keys(manifest.categories);
  const manifestFiles = [];
  const globalCanonicalIds = [];

  for (const [category, entry] of Object.entries(manifest.categories)) {
    const location = `data/book/manifest.json.categories.${category}`;
    const definition = CATEGORY_DEFINITIONS[category];
    if (!definition) {
      fail('CATEGORY_UNKNOWN', location, `Unsupported category "${category}".`);
      continue;
    }
    if (!requireRecord(entry, location)) continue;
    const expectedFile = `${category}.json`;
    if (requireString(entry.file, `${location}.file`, { nonEmpty: true })) {
      if (basename(entry.file) !== entry.file || entry.file !== expectedFile) {
        fail('CANONICAL_FILENAME', `${location}.file`, `Expected canonical filename "${expectedFile}" without path traversal.`);
      }
      manifestFiles.push(entry.file);
    }
    if (entry.prefix !== definition.prefix) {
      fail('CATEGORY_PREFIX', `${location}.prefix`, `Expected "${definition.prefix}".`);
    }
    if (typeof entry.complete !== 'boolean') {
      fail('TYPE_BOOLEAN', `${location}.complete`, 'Expected a boolean.');
    } else if (!entry.complete) {
      fail('MANIFEST_INCOMPLETE', `${location}.complete`, `Category "${category}" is explicitly marked incomplete.`);
    }

    const manifestIds = [];
    if (validateStringArray(entry.lessonIds, `${location}.lessonIds`, { nonEmpty: true })) {
      manifestIds.push(...entry.lessonIds);
      const duplicates = findDuplicates(manifestIds);
      if (duplicates.length > 0) {
        fail('DUPLICATE_MANIFEST_ID', `${location}.lessonIds`, `Duplicate ID(s): ${formatList(duplicates)}.`);
      }
    }

    if (typeof entry.file !== 'string' || basename(entry.file) !== entry.file) continue;
    const canonicalPath = join(BOOK_DIR, entry.file);
    const content = parseJsonFile(canonicalPath, `data/book/${entry.file}`);
    if (!isRecord(content)) {
      if (content !== null) fail('TYPE_OBJECT', `data/book/${entry.file}`, 'Canonical category file must be an object keyed by lesson ID.');
      continue;
    }

    const canonicalIds = Object.keys(content);
    canonicalContentByCategory.set(category, content);
    compareSets(canonicalIds, manifestIds, location, 'canonical lesson IDs', 'manifest lesson IDs');
    compareSets(canonicalIds, lessonIdsByCategory.get(category) || [], `data/book/${entry.file}`, 'canonical lesson IDs', 'lessons.json IDs');
    const pattern = new RegExp(`^${definition.prefix}[1-9]\\d*d[1-9]\\d*$`);
    canonicalIds.forEach((id) => {
      const lessonLocation = `data/book/${entry.file}.${id}`;
      if (!pattern.test(id)) {
        fail('CANONICAL_ID_PATTERN', lessonLocation, `Expected ${definition.prefix}<week>d<day>.`);
      }
      const validator = SCHEMA_VALIDATORS[category];
      validator(content[id], id, lessonLocation);
      validateFuriganaDeep(content[id], lessonLocation);
      globalCanonicalIds.push(id);
      validatedLessons += 1;
    });
  }

  const duplicateFiles = findDuplicates(manifestFiles);
  if (duplicateFiles.length > 0) {
    fail('DUPLICATE_MANIFEST_FILE', 'data/book/manifest.json', `File listed more than once: ${formatList(duplicateFiles)}.`);
  }
  const duplicateCanonicalIds = findDuplicates(globalCanonicalIds);
  if (duplicateCanonicalIds.length > 0) {
    fail('DUPLICATE_CANONICAL_ID', 'data/book/manifest.json', `ID appears in multiple canonical files: ${formatList(duplicateCanonicalIds)}.`);
  }

  compareSets(
    manifestFiles,
    canonicalFilesOnDisk(),
    'data/book/manifest.json.categories',
    'manifest files',
    'canonical files on disk',
  );
  compareSets(
    manifestCategories,
    Object.keys(CATEGORY_DEFINITIONS),
    'data/book/manifest.json.categories',
    'manifest categories',
    'required book categories',
  );
}

const lessons = parseJsonFile(LESSONS_PATH, 'data/lessons.json');
const lessonIdsByCategory = validateLessonsIndex(lessons);
const manifest = parseJsonFile(MANIFEST_PATH, 'data/book/manifest.json');
validateManifest(manifest, lessonIdsByCategory);

// Validate enrichment files (optional, only when present).
const enrichmentFiles = [
  { suffix: 'classification.json', fn: validateEnrichmentFile },
  { suffix: 'images.json', fn: validateImagesFile },
  { suffix: 'vietnamese.json', fn: validateVietnameseFile },
];
for (const [category, entry] of Object.entries(manifest?.categories || {})) {
  if (!isRecord(entry)) continue;
  const declared = Array.isArray(entry.enrichmentFiles) ? entry.enrichmentFiles : [];
  const lessonIds = new Set(lessonIdsByCategory.get(category) || []);
  for (const file of declared) {
    if (typeof file !== 'string') continue;
    if (!enrichmentFiles.some((e) => e.suffix === file)) continue;
    const path = join(BOOK_DIR, `${category}.${file}`);
    if (!existsSync(path)) continue;
    const content = parseJsonFile(path, `data/book/${category}.${file}`);
    const validator = enrichmentFiles.find((e) => e.suffix === file);
    if (content) validator.fn(category, content, lessonIds, `data/book/${category}.${file}`);
  }
}

for (const item of warnings) {
  console.warn(`WARN  [${item.code}] ${item.location}: ${item.message}`);
}
for (const item of errors) {
  console.error(`ERROR [${item.code}] ${item.location}: ${item.message}`);
}

const summary = `${validatedFiles} JSON file(s), ${validatedLessons} canonical lesson(s), ${validatedQuestions} question(s)`;
if (errors.length > 0) {
  console.error(`\nBOOK DATA VALIDATION FAILED — ${errors.length} error(s), ${warnings.length} warning(s); checked ${summary}.`);
  console.error('This is an intentionally strict gate: add every canonical category and make manifest/data/lessons.json coverage agree before release.');
  process.exitCode = 1;
} else {
  console.log(`BOOK DATA VALIDATION PASSED — ${warnings.length} warning(s); checked ${summary}.`);
}
