#!/usr/bin/env node

// Resolves missing/invalid answerIndex (-1 or out-of-range) on lesson
// "practice" cloze questions in data/book/{kanji,vocabulary,grammar}.json.
// Unlike the exam answer-key gaps, these questions carry the full Japanese
// prompt + options as plain text already in the JSON (no scanned answer key
// to re-read) — solvable directly from that text, no PDF/image grounding
// needed. Writes answerIndex + answerSource: "ai-solved" back into the same
// book JSON files (these are git-tracked, unlike data/exams/*.json, so a bad
// run is recoverable via git diff/checkout).
//
// Usage:
//   GEMINI_API_KEY=... node scripts/resolve-book-practice-gaps.mjs --category grammar
//   GEMINI_API_KEY=... node scripts/resolve-book-practice-gaps.mjs --category grammar --limit g1d1,g1d2
//   GEMINI_API_KEY=... node scripts/resolve-book-practice-gaps.mjs --category grammar --dry-run

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK_DIR = join(ROOT, 'data', 'book');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY (env).');
  process.exit(1);
}

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

const CATEGORIES = ['kanji', 'vocabulary', 'grammar'];

function plainText(s) {
  return String(s || '').replace(/\{([^{}|]+)\|([^{}]*)\}/g, '$1').trim();
}

function gappedIndexes(practice) {
  const out = [];
  (Array.isArray(practice) ? practice : []).forEach((q, i) => {
    const idx = q?.answerIndex;
    const opts = Array.isArray(q?.options) ? q.options : [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) out.push(i);
  });
  return out;
}

const MIN_MS_BETWEEN_CALLS = 5000;
let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + MIN_MS_BETWEEN_CALLS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function solveLesson(category, lessonId, practice, indexes) {
  const list = indexes
    .map((i) => {
      const q = practice[i];
      const opts = (q.options || []).map((o, oi) => `${oi}: ${plainText(o)}`).join(' | ');
      return `${i}. ${plainText(q.prompt || q.q || '')}\nOptions: ${opts}`;
    })
    .join('\n\n');

  const prompt = `Bạn là gia sư tiếng Nhật N2 người Việt, đang chấm bài luyện tập điền khuyết trong sách Soumatome N2 (mục ${category}). Với mỗi câu dưới đây, xác định đáp án ĐÚNG DUY NHẤT (0-based index trong "options") dựa trên ngữ pháp/từ vựng/kanji tiếng Nhật chuẩn. Chỉ trả lời khi chắc chắn.

Trả về JSON: {"items": [{"index": <số câu hỏi ở đầu dòng, GIỮ NGUYÊN>, "answerIndex": <0-based>}]}

DANH SÁCH (lesson ${lessonId}):
${list}

CHỈ trả về JSON thuần, không markdown, không giải thích thêm.`;

  await throttle();
  const url = `${GEN_BASE}/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { index: { type: 'integer' }, answerIndex: { type: 'integer' } },
              required: ['index', 'answerIndex'],
            },
          },
        },
        required: ['items'],
      },
    },
  };

  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text();
        const retryable = [429, 500, 502, 503, 504].includes(res.status);
        if (!retryable || attempt === 4) throw new Error(`generateContent failed (${res.status}): ${text.slice(0, 300)}`);
        await new Promise((r) => setTimeout(r, Math.min(30000, 2 ** attempt * 1000 + 2000)));
        continue;
      }
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      if (!text) throw new Error('Empty response from Gemini.');
      const parsed = JSON.parse(text);
      const out = new Map();
      for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
        const i = Number.isInteger(item?.index) ? item.index : -1;
        const ai = Number.isInteger(item?.answerIndex) ? item.answerIndex : -1;
        if (indexes.includes(i) && ai >= 0 && ai < (practice[i].options || []).length) out.set(i, ai);
      }
      return out;
    } catch (err) {
      lastError = err;
      if (attempt === 4) throw lastError;
    }
  }
  throw lastError;
}

async function runCategory(cat) {
  const jsonPath = join(BOOK_DIR, `${cat}.json`);
  const book = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const lessonIds = Object.keys(book);
  const targets = limitList ? lessonIds.filter((id) => limitList.includes(id)) : lessonIds;

  let totalGapped = 0;
  let totalResolved = 0;
  for (const lessonId of targets) {
    const lesson = book[lessonId];
    const practice = Array.isArray(lesson?.practice) ? lesson.practice : [];
    const indexes = gappedIndexes(practice);
    if (indexes.length === 0) continue;
    totalGapped += indexes.length;
    try {
      const resolved = await solveLesson(cat, lessonId, practice, indexes);
      for (const [i, ai] of resolved.entries()) {
        practice[i].answerIndex = ai;
        practice[i].answerSource = 'ai-solved';
      }
      totalResolved += resolved.size;
      console.log(`${cat} ${lessonId}: ${resolved.size}/${indexes.length} resolved`);
      if (!dryRun) writeFileSync(jsonPath, JSON.stringify(book, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error(`${cat} ${lessonId}: ERROR ${err.message || err}`);
    }
  }
  console.log(`\n${cat}: ${totalResolved}/${totalGapped} gap(s) resolved.${dryRun ? ' (dry-run, not written)' : ''}`);
}

async function main() {
  const cats = category ? [category] : CATEGORIES;
  for (const c of cats) {
    if (!CATEGORIES.includes(c)) {
      console.error('Unknown category:', c, '— must be one of', CATEGORIES);
      process.exit(1);
    }
  }
  for (const c of cats) await runCategory(c);
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
