#!/usr/bin/env node

// Generates Vietnamese explanations for kanji/vocabulary/grammar book
// content via Gemini, grounded on the same source Somatome PDF the original
// extraction used (same upload-once-reuse-per-lesson pattern as
// scripts/classify-questions.mjs). Output: data/book/<category>.vietnamese.json
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

import { readFileSync, writeFileSync, statSync } from 'node:fs';
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
const UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const category = argValue('--category');
const limitList = argValue('--limit') ? argValue('--limit').split(',') : null;
const pdfDir = argValue('--pdf-dir') || join(ROOT, 'N2_somatome');

const BOOKS = {
  kanji: '49. Somatome N2 Kanji.pdf',
  vocabulary: '50. Somatome N2 Goi.pdf',
  grammar: '51. Somatome N2 Bunpo.pdf',
};

const MAX_CHARS = { kanji: 140, vocabulary: 120, grammar: 160 };

// IMPORTANT: these instruction strings must themselves be written in fully
// accented Vietnamese — an earlier unaccented-ASCII version of this prompt
// caused the model to mirror that style and return explanations with zero
// diacritics (dấu), which is unusable for a Vietnamese-language app.
const DIACRITICS_REMINDER = 'LUÔN viết bằng tiếng Việt có đầy đủ dấu (dấu thanh, dấu mũ, dấu móc...) — tuyệt đối KHÔNG được bỏ dấu.';

const INSTRUCTIONS = {
  kanji: (max) => `Bạn là gia sư tiếng Nhật N2 người Việt. Với mỗi chữ Hán dưới đây (kèm âm on/kun và một ví dụ từ vựng), viết MỘT câu giải thích ngắn gọn bằng tiếng Việt (tối đa ${max} ký tự) nêu nghĩa cốt lõi của chữ Hán, diễn đạt tự nhiên cho người Việt học — không chỉ dịch từng chữ nghĩa tiếng Anh đã cho. ${DIACRITICS_REMINDER}`,
  vocabulary: (max) => `Bạn là gia sư tiếng Nhật N2 người Việt. Với mỗi từ vựng dưới đây (kèm cách đọc và nghĩa tiếng Anh), viết MỘT câu nghĩa/giải thích bằng tiếng Việt tự nhiên, ngắn gọn (tối đa ${max} ký tự), phù hợp văn cảnh N2 — không chỉ dịch từng chữ nghĩa tiếng Anh đã cho. ${DIACRITICS_REMINDER}`,
  grammar: (max) => `Bạn là gia sư tiếng Nhật N2 người Việt. Với mỗi mẫu ngữ pháp dưới đây (kèm nghĩa tiếng Anh), viết MỘT câu giải thích ý nghĩa và cách dùng bằng tiếng Việt, ngắn gọn (tối đa ${max} ký tự), để người học phân biệt được với các mẫu tương tự. ${DIACRITICS_REMINDER}`,
};

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

async function uploadPdf(filePath, key) {
  const displayName = filePath.split(/[\\/]/).pop();
  const numBytes = statSync(filePath).size;
  const startRes = await fetch(`${UPLOAD_BASE}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { displayName } }),
  });
  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error(`Upload start failed (${startRes.status}): ${text.slice(0, 300)}`);
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Upload start missing x-goog-upload-url header.');
  const body = readFileSync(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Type': 'application/pdf',
    },
    body,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`Upload finalize failed (${uploadRes.status}): ${text.slice(0, 300)}`);
  }
  const data = await uploadRes.json();
  const file = data.file || data;
  if (!file.name || !file.uri) throw new Error('Upload response missing file.name/uri.');
  return { name: file.name, uri: file.uri };
}

async function waitForFileActive(fileUri, fileName, key) {
  const url = `${fileUri}?key=${encodeURIComponent(key)}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const state = data.state || 'UNKNOWN';
      if (state === 'ACTIVE') return;
      if (state === 'FAILED') throw new Error(`File processing failed: ${data.name || fileName}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`File ${fileName} did not become ACTIVE within 60s.`);
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

async function askVietnamese(fileUri, category, lessonId, lesson, key) {
  const items = flattenItems(category, lesson);
  if (items.length === 0) return [];
  const max = MAX_CHARS[category];
  const prompt = `${INSTRUCTIONS[category](max)}

Trả về JSON duy nhất: {"items": [{"index": 0, "vi": "..."}, {"index": 1, ...}, ...]}
Chính xác ${items.length} phần tử, đúng thứ tự, index bắt đầu từ 0.

DANH SÁCH (lesson ${lessonId}):
${items.map((line, i) => `${i}. ${line}`).join('\n')}

CHỈ trả về JSON thuần, không markdown, không giải thích thêm.`;

  await throttle();
  const url = `${GEN_BASE}/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { file_data: { mime_type: 'application/pdf', file_uri: fileUri } },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { index: { type: 'integer' }, vi: { type: 'string' } },
              required: ['index', 'vi'],
            },
          },
        },
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
    const vi = typeof item?.vi === 'string' ? item.vi.trim().slice(0, max + 40) : '';
    if (idx >= 0 && idx < items.length && vi) out.push({ index: idx, vi });
  }
  return out;
}

async function main() {
  if (!category || !BOOKS[category]) {
    console.error('Specify --category one of:', Object.keys(BOOKS));
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

  const pdfPath = join(pdfDir, BOOKS[category]);

  // The Files API upload is scoped to whichever key created it, so a
  // generateContent call using a DIFFERENT key can't reference it — upload
  // (once) under each key lazily, the first time the rotator actually picks
  // that key, rather than assuming a single upload works for the whole pool.
  const fileByKey = new Map();
  async function ensureUploadedFor(key) {
    if (fileByKey.has(key)) return fileByKey.get(key);
    console.log(`Uploading ${BOOKS[category]} (key ...${key.slice(-6)})...`);
    const { uri, name } = await uploadPdf(pdfPath, key);
    await waitForFileActive(uri, name, key);
    console.log(`Uploaded as ${name}`);
    fileByKey.set(key, uri);
    return uri;
  }

  const outPath = join(BOOK_DIR, `${category}.vietnamese.json`);
  let out = {};
  try { out = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* first run */ }

  let totalItems = 0;
  for (const lessonId of targets) {
    const expected = flattenItems(category, book[lessonId]).length;
    if (expected === 0) { console.log(`${category} ${lessonId}: no items, skipped`); continue; }
    try {
      const results = await rotator.run(async (key) => {
        const fileUri = await ensureUploadedFor(key);
        return askVietnamese(fileUri, category, lessonId, book[lessonId], key);
      });
      const arr = new Array(expected).fill(null);
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
