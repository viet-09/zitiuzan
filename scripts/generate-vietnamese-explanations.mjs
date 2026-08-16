#!/usr/bin/env node

// Generates Vietnamese explanations for kanji/vocabulary/grammar book
// content via Gemini. Text-only (no PDF grounding) — an earlier version
// attached the source Somatome PDF for extra context, but a lesson's own
// {word, reading, English meaning} is already everything needed for a
// meaning+usage gloss, and the PDF attachment turned out to occasionally
// cause a whole lesson's response to fail validation across every item
// simultaneously (repro'd on lesson v2d5: 3 separate attempts, 3 different
// key-pool orderings, all 0/31 — the exact same prompt with the PDF
// dropped succeeded on the first try). Output: data/book/<category>.vietnamese.json
// — one string per item, in the exact order js/lesson.js's
// renderKanji/renderVocabulary/renderGrammar iterate the lesson's own arrays
// (kanji[] only — NOT reviewKanji[], which is an answer-free recall quiz and
// must stay that way; flattened sections[].words[]; patterns[]).
//
// Usage (GEMINI_API_KEYS accepts a comma-separated pool with automatic
// failover — see scripts/lib/gemini-key-pool.mjs; GEMINI_API_KEY also works
// for a single key):
//   GEMINI_API_KEYS=key1,key2 node scripts/generate-vietnamese-explanations.mjs --category kanji
//   GEMINI_API_KEY=... node scripts/generate-vietnamese-explanations.mjs --category kanji --limit k1d1,k1d2
//   GEMINI_API_KEY=... node scripts/generate-vietnamese-explanations.mjs --category kanji --dry-run

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGeminiKeyPool, createGeminiKeyRotator, GeminiKeyError } from './lib/gemini-key-pool.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK_DIR = join(ROOT, 'data', 'book');

const KEY_POOL = loadGeminiKeyPool();
if (KEY_POOL.length === 0) {
  console.error('Missing Gemini API key (set GEMINI_API_KEY or GEMINI_API_KEYS).');
  process.exit(1);
}
const rotator = createGeminiKeyRotator(KEY_POOL);
console.log(`Using a pool of ${KEY_POOL.length} Gemini API key(s).`);

// gemini-3.5-flash's free-tier daily quota (20 req/day/project/model — yes,
// per DAY despite the misleading "retry in Ns" hint in 429 responses) was
// fully exhausted by earlier work today. gemini-3.5-flash-lite is a separate
// model with its own quota bucket and was still available.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEN_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const category = argValue('--category');
const limitList = argValue('--limit') ? argValue('--limit').split(',') : null;

const CATEGORIES = new Set(['kanji', 'vocabulary', 'grammar']);

// kanji/vocabulary return two separate fields (meaning/usage — see
// TWO_FIELD_CATEGORIES below) that the client joins as `${meaning}\n★
// ${usage}`; grammar keeps a single combined string.
const MAX_CHARS = {
  kanji: { meaning: 60, usage: 90 },
  vocabulary: { meaning: 60, usage: 90 },
  grammar: 160,
};
const TWO_FIELD_CATEGORIES = new Set(['kanji', 'vocabulary']);

// IMPORTANT: these instruction strings must themselves be written in fully
// accented Vietnamese — an earlier unaccented-ASCII version of this prompt
// caused the model to mirror that style and return explanations with zero
// diacritics (dấu), which is unusable for a Vietnamese-language app.
const DIACRITICS_REMINDER = 'LUÔN viết bằng tiếng Việt có đầy đủ dấu (dấu thanh, dấu mũ, dấu móc...) — tuyệt đối KHÔNG được bỏ dấu.';

// IMPORTANT: an earlier version of this prompt just said "viết một câu giải
// thích" for vocabulary, and the model interpreted that as a full narrative
// example sentence using the word (e.g. "Các tờ rơi quảng cáo bất động sản
// thường được phát tận tay người đi đường.") instead of a dictionary-style
// gloss — the book has no Japanese example sentence for these words at all,
// so a Vietnamese "translation" of one made no sense. Now explicit: exactly
// two clauses, meaning then usage context, never a standalone narrative.
const NO_EXAMPLE_SENTENCE_RULE = 'TUYỆT ĐỐI KHÔNG viết thành một câu văn kể chuyện/tình huống cụ thể (không có chủ ngữ hành động như "tôi", "anh ấy", "công ty này...") — chỉ nêu nghĩa và ngữ cảnh dùng ở dạng giải thích từ điển.';

// IMPORTANT: a later version asked for the literal prefixes "Nghĩa:"/"Dùng
// khi:" baked into one string — the client renders these as two separate
// lines itself (meaning, then a ★-prefixed usage line), so the labels were
// redundant chrome and got dropped in favor of two clean, unlabeled fields.
const NO_LABEL_RULE = 'KHÔNG được viết các nhãn như "Nghĩa:", "Dùng khi:", "Dùng để" ở đầu câu trả lời — chỉ trả về đúng nội dung nghĩa/hoàn cảnh dùng, không có tiền tố nào.';

const INSTRUCTIONS = {
  kanji: (max) => `Bạn là gia sư tiếng Nhật N2 người Việt. Với mỗi chữ Hán dưới đây (kèm âm on/kun và một ví dụ từ vựng), trả về hai phần bằng tiếng Việt tự nhiên: "meaning" là nghĩa cốt lõi của chữ Hán (tối đa ${max.meaning} ký tự), và "usage" là hoàn cảnh/loại từ thường dùng chữ này (tối đa ${max.usage} ký tự) — không chỉ dịch từng chữ nghĩa tiếng Anh đã cho. ${NO_LABEL_RULE} ${NO_EXAMPLE_SENTENCE_RULE} ${DIACRITICS_REMINDER}`,
  vocabulary: (max) => `Bạn là gia sư tiếng Nhật N2 người Việt. Với mỗi từ vựng dưới đây (kèm cách đọc và nghĩa tiếng Anh), trả về hai phần bằng tiếng Việt tự nhiên: "meaning" là nghĩa cốt lõi của từ (tối đa ${max.meaning} ký tự), và "usage" là hoàn cảnh/tình huống dùng từ này (tối đa ${max.usage} ký tự), phù hợp văn cảnh N2 — không chỉ dịch từng chữ nghĩa tiếng Anh đã cho. ${NO_LABEL_RULE} ${NO_EXAMPLE_SENTENCE_RULE} ${DIACRITICS_REMINDER}`,
  grammar: (max) => `Bạn là gia sư tiếng Nhật N2 người Việt. Với mỗi mẫu ngữ pháp dưới đây (kèm nghĩa tiếng Anh), viết MỘT câu giải thích ý nghĩa và cách dùng bằng tiếng Việt, ngắn gọn (tối đa ${max} ký tự), để người học phân biệt được với các mẫu tương tự. ${DIACRITICS_REMINDER}`,
};

// Despite DIACRITICS_REMINDER, the model occasionally still returns a
// stray item with zero accents (observed nondeterministically, not tied to
// any one key) — reject those individually rather than writing broken
// Vietnamese; the lesson stays gapped and gets picked up by a re-run
// (generate-vietnamese-explanations.mjs skips nothing, so re-running
// --limit on just the still-gapped lessons converges quickly).
const HAS_VIETNAMESE_DIACRITIC = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
function hasDiacritics(text) {
  return HAS_VIETNAMESE_DIACRITIC.test(text);
}

function plainText(s) {
  return String(s || '').replace(/\{([^{}|]+)\|([^{}]*)\}/g, '$1').trim();
}

/** Returns the flattened item list for one lesson, in the exact order
 * js/lesson.js's render functions iterate — this order IS the contract with
 * the client (plain parallel arrays, matched by position, not by id). */
function flattenItems(category, lesson) {
  if (category === 'kanji') {
    return (Array.isArray(lesson.kanji) ? lesson.kanji : []).map((k) => {
      const exampleEn = k.words?.[0]?.en || '';
      return `${k.char}（on: ${k.on || '—'}, kun: ${k.kun || '—'}）— ví dụ: ${k.words?.[0]?.jp || ''} (${exampleEn})`;
    });
  }
  if (category === 'vocabulary') {
    const items = [];
    for (const section of Array.isArray(lesson.sections) ? lesson.sections : []) {
      for (const w of Array.isArray(section.words) ? section.words : []) {
        items.push(`${w.jp}（${w.reading || ''}） — EN: ${w.en || ''}`);
      }
    }
    return items;
  }
  if (category === 'grammar') {
    return (Array.isArray(lesson.patterns) ? lesson.patterns : []).map(
      (p) => `${plainText(p.form)} — EN: ${p.meaningEn || ''}`,
    );
  }
  return [];
}

// Free-tier Gemini quota (20 req/min, generate_content_free_tier_requests)
// turned out to be shared across EVERYTHING using this key today — 4s
// spacing alone still 429'd (see scripts/fix_underlined_words.py). Paced
// much more conservatively since there's no way to see the shared bucket's
// actual remaining headroom from this process alone.
const MIN_MS_BETWEEN_CALLS = 5000;
let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + MIN_MS_BETWEEN_CALLS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function askVietnamese(category, lessonId, lesson, key) {
  const items = flattenItems(category, lesson);
  if (items.length === 0) return [];
  const max = MAX_CHARS[category];
  const twoField = TWO_FIELD_CATEGORIES.has(category);
  const itemSchema = twoField
    ? {
        type: 'object',
        properties: { index: { type: 'integer' }, meaning: { type: 'string' }, usage: { type: 'string' } },
        required: ['index', 'meaning', 'usage'],
      }
    : {
        type: 'object',
        properties: { index: { type: 'integer' }, vi: { type: 'string' } },
        required: ['index', 'vi'],
      };
  const jsonShape = twoField
    ? '{"items": [{"index": 0, "meaning": "...", "usage": "..."}, {"index": 1, ...}, ...]}'
    : '{"items": [{"index": 0, "vi": "..."}, {"index": 1, ...}, ...]}';
  const prompt = `${INSTRUCTIONS[category](max)}

Trả về JSON duy nhất: ${jsonShape}
Chính xác ${items.length} phần tử, đúng thứ tự, index bắt đầu từ 0.

DANH SÁCH (lesson ${lessonId}):
${items.map((line, i) => `${i}. ${line}`).join('\n')}

CHỈ trả về JSON thuần, không markdown, không giải thích thêm.`;

  await throttle();
  const url = `${GEN_BASE}/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: itemSchema } },
        required: ['items'],
      },
    },
  };

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new GeminiKeyError(res.status, `generateContent failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  if (!text) throw new Error('Empty response from Gemini.');
  const parsed = JSON.parse(text);
  const out = [];
  for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
    const idx = Number.isInteger(item?.index) ? item.index : -1;
    if (idx < 0 || idx >= items.length) continue;
    let vi = '';
    if (twoField) {
      const meaning = typeof item?.meaning === 'string' ? item.meaning.trim().slice(0, max.meaning + 20) : '';
      const usage = typeof item?.usage === 'string' ? item.usage.trim().slice(0, max.usage + 20) : '';
      if (!meaning || !hasDiacritics(meaning) || (usage && !hasDiacritics(usage))) continue;
      vi = usage ? `${meaning}\n★ ${usage}` : meaning;
    } else {
      vi = typeof item?.vi === 'string' ? item.vi.trim().slice(0, max + 40) : '';
      if (vi && !hasDiacritics(vi)) vi = '';
    }
    if (vi) out.push({ index: idx, vi });
  }
  return out;
}

async function main() {
  if (!category || !CATEGORIES.has(category)) {
    console.error('Specify --category one of:', [...CATEGORIES]);
    process.exit(1);
  }
  const jsonPath = join(BOOK_DIR, `${category}.json`);
  const book = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const lessonIds = Object.keys(book);
  const targets = limitList ? lessonIds.filter((id) => limitList.includes(id)) : lessonIds;
  if (targets.length === 0) {
    console.error('No lessons matched.');
    process.exit(1);
  }

  const outPath = join(BOOK_DIR, `${category}.vietnamese.json`);
  let out = {};
  try { out = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* first run */ }

  let totalItems = 0;
  for (const lessonId of targets) {
    const expected = flattenItems(category, book[lessonId]).length;
    if (expected === 0) { console.log(`${category} ${lessonId}: no items, skipped`); continue; }
    try {
      const results = await rotator.run((key) => askVietnamese(category, lessonId, book[lessonId], key));
      // Start from whatever this lesson already had — but only the parts
      // that were themselves valid (diacritics intact); a previously-broken
      // value must NOT survive as a "fallback", or it can never get fixed
      // by a re-run — and only overwrite indices this run actually produced
      // a valid result for, so a fresh rejection doesn't wipe a good value.
      const existing = Array.isArray(out[lessonId]) ? out[lessonId] : [];
      const arr = Array.from({ length: expected }, (_, i) => {
        const value = existing[i];
        return typeof value === 'string' && hasDiacritics(value) ? value : null;
      });
      for (const { index, vi } of results) arr[index] = vi;
      const filled = arr.filter(Boolean).length;
      out[lessonId] = arr;
      totalItems += filled;
      console.log(`${category} ${lessonId}: ${filled}/${expected} explained`);
      if (!dryRun) writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error(`${category} ${lessonId}: ERROR ${err.message || err}`);
    }
  }

  console.log(`\nDone. ${totalItems} item(s) explained across ${Object.keys(out).length} lesson(s).${dryRun ? ' (dry-run, not written)' : ` Wrote ${outPath}`}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
