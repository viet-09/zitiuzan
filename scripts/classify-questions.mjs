#!/usr/bin/env node

// Read each data/book/<category>.json, send every question's prompt to Gemini
// along with the lesson's context, and ask Gemini to classify it
// (kanji-yomi / grammar-tadose / etc.) and produce a short Vietnamese
// description of the de bai.
//
// Output: data/book/<category>.classification.json (per-lesson, indexed by
// question array index in the lesson's `practice` or `questions` block).
//
// Usage:
//   GEMINI_API_KEY=... node scripts/classify-questions.mjs --category kanji [--book <key>]
//   GEMINI_API_KEY=... node scripts/classify-questions.mjs --category kanji --limit k1d1
//   GEMINI_API_KEY=... node scripts/classify-questions.mjs --category kanji --dry-run

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXT_MODEL_CHAIN } from '../supabase/functions/_shared/gemini-models.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK_DIR = join(ROOT, 'data', 'book');
const SCRATCH = process.env.SCRATCH || 'C:/Users/UYTIN/AppData/Local/Temp/claude';
const LOG_DIR = join(SCRATCH, 'c--Users-UYTIN-Downloads----N2-web',
  '3b4f180c-381b-4764-8b3b-b715c5413dfd', 'scratchpad');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY (env).');
  process.exit(1);
}

const MODEL = process.env.GEMINI_MODEL || TEXT_MODEL_CHAIN[0];
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

const TYPE_WHITELIST = {
  kanji: ['kanji-yomi', 'kanji-toroku', 'kanji-hanbetsu', 'kanji-sakubun'],
  vocabulary: ['vocab-fukugougo', 'vocab-rentai', 'vocab-yougo'],
  grammar: ['grammar-bunpou', 'grammar-hyougen', 'grammar-tadose'],
  reading: ['reading-shusho', 'reading-riyuu', 'reading-chikoku', 'reading-josou', 'reading-mix'],
  listening: ['listening-kadai', 'listening-point', 'listening-gaiyou', 'listening-imamashii'],
};

const PROMPT = (category, lessonId, title, titleEn, questionBlocks) => `Ban la tro ly phan loai cau hoi JLPT N2 cho sach "${category}" (lesson ${lessonId}, title "${title}" / ${titleEn}).

Toi cung cap cac cau hoi trong bai (duoc danh so Q1..Qn). Voi moi cau, hay:
1) Chon mot type tu whitelist: ${TYPE_WHITELIST[category].join(', ')}
2) Viet 1 cau tom tat de bai bang tieng Viet (toi da 200 ky tu).

Tra ve JSON duy nhat: {"questions": [{"index": 0, "type": "...", "descriptionVi": "..."}, {"index": 1, ...}, ...]}
Chinh xac ${questionBlocks.length} phan tu, theo dung thu tu.

CAC CAU HOI:
${questionBlocks.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

CHI tra ve JSON thuan, khong giai thich them, khong markdown.`;

async function uploadPdf(filePath) {
  const displayName = filePath.split(/[\\/]/).pop();
  const numBytes = (await import('node:fs')).statSync(filePath).size;
  const startRes = await fetch(`${UPLOAD_BASE}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
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
  const body = (await import('node:fs')).readFileSync(filePath);
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
  return { name: file.name, uri: file.uri, state: file.state };
}

async function waitForFileActive(fileUri, fileName) {
  const url = `${fileUri}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
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

const BOOKS = {
  kanji: '49. Somatome N2 Kanji.pdf',
  vocabulary: '50. Somatome N2 Goi.pdf',
  grammar: '51. Somatome N2 Bunpo.pdf',
  reading: '52. Somatome N2 Dokkai.pdf',
  listening: '53. Somatome N2 Chokai.pdf',
};

function plainText(s) {
  return String(s || '').replace(/\{([^{}|]+)\|([^{}]*)\}/g, '$1').trim();
}

function getQuestionBlocks(lesson) {
  const arr = lesson.practice || lesson.questions || [];
  return arr.map((q) => plainText(q.prompt || q.q));
}

async function askClassify(fileUri, category, lessonId, lesson) {
  const blocks = getQuestionBlocks(lesson);
  if (blocks.length === 0) return [];
  const url = `${GEN_BASE}/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    system_instruction: {
      parts: [{
        text: 'Ban la tro ly phan loai cau hoi JLPT N2. Luon tra ve JSON hop le, khong kem markdown, khong kem giai thich.',
      }],
    },
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT(category, lessonId, plainText(lesson.title || ''), plainText(lesson.titleEn || ''), blocks) },
        { file_data: { mime_type: 'application/pdf', file_uri: fileUri } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                type: { type: 'string' },
                descriptionVi: { type: 'string' },
              },
              required: ['index', 'type', 'descriptionVi'],
            },
          },
        },
        required: ['questions'],
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generateContent failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  if (!text) throw new Error('Empty response from Gemini.');
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) {
    throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 200)}`);
  }
  const out = [];
  for (const item of (Array.isArray(parsed?.questions) ? parsed.questions : [])) {
    const idx = Number.isInteger(item?.index) ? item.index : -1;
    const type = TYPE_WHITELIST[category].includes(item?.type) ? item.type : null;
    const desc = typeof item?.descriptionVi === 'string'
      ? item.descriptionVi.trim().slice(0, 200)
      : null;
    if (idx >= 0 && type && desc) out.push({ index: idx, type, descriptionVi: desc });
  }
  return out;
}

async function main() {
  if (!category || !TYPE_WHITELIST[category]) {
    console.error('Specify --category one of:', Object.keys(TYPE_WHITELIST));
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
  console.log(`Uploading ${BOOKS[category]}…`);
  const { uri, name } = await uploadPdf(pdfPath);
  console.log(`Uploaded as ${name}`);
  await waitForFileActive(uri, name);

  const out = {};
  for (const lessonId of targets) {
    try {
      const items = await askClassify(uri, category, lessonId, book[lessonId]);
      if (items.length) out[lessonId] = { questions: items };
      console.log(`${category} ${lessonId}: ${items.length} classified`);
    } catch (err) {
      console.error(`${category} ${lessonId}: ERROR ${err.message || err}`);
    }
  }

  if (!dryRun && Object.keys(out).length) {
    const outPath = join(BOOK_DIR, `${category}.classification.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${outPath}`);
  }
  console.log(`Done. ${Object.keys(out).length} lesson(s) classified.`);
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});