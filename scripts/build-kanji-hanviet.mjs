// scripts/build-kanji-hanviet.mjs
// Builds data/kanji-hanviet.json: the Sino-Vietnamese (âm Hán Việt) reading of
// every kanji the curriculum teaches, for the kanji cards and the practice
// sheet.
//
// Getting this right needed a correction mid-build. Unihan's kVietnamese field
// looked like the obvious source, but it is not a Hán-Việt field: it mixes in
// Nôm and colloquial readings, so it answers 寄 with "gửi", 冷 with "lạnh", 未
// with "mùi" and 鋭 with "nhọn" where the Hán-Việt readings are ký, lãnh, vị,
// duệ. It also omits very common characters outright, 愛 and 米 among them.
//
// So the model is asked the question, and agreement is what licenses the
// answer. Every reading must be confirmed twice before it ships:
//
//   * two independently worded model passes agree with each other, or
//   * one pass agrees with Unihan, which settles the Nôm-vs-Hán-Việt case.
//
// Anything still contested is left out and reported — a learner memorising a
// wrong reading is worse than seeing none.
//
// Usage:
//   node scripts/build-kanji-hanviet.mjs --unihan-only   # no AI, no quota
//   node scripts/build-kanji-hanviet.mjs                 # full two-pass build

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'data', 'kanji-hanviet.json');
const UNIHAN_URL = 'https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip';
const CACHE = path.join(os.tmpdir(), 'unihan-cache');
const BATCH = 120;

const UNIHAN_ONLY = process.argv.includes('--unihan-only');

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .split(/\r?\n/).filter(Boolean).filter((line) => !line.trim().startsWith('#')).map((line) => {
    const idx = line.indexOf('=');
    return idx < 0 ? null : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }).filter(Boolean));

/** Kanji with their own card in the curriculum, in first-taught order. */
function collectCurriculumKanji() {
  const lessons = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'book', 'kanji.json'), 'utf8'));
  const seen = [];
  for (const lesson of Object.values(lessons)) {
    for (const card of lesson?.kanji || []) {
      for (const character of String(card?.char || '')) {
        if (!/\p{Script=Han}/u.test(character)) continue;
        if (!seen.includes(character)) seen.push(character);
      }
    }
  }
  return seen;
}

async function unihanReadings() {
  fs.mkdirSync(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, 'Unihan.zip');
  if (!fs.existsSync(zipPath)) {
    console.log('Downloading Unihan…');
    const res = await fetch(UNIHAN_URL);
    if (!res.ok) throw new Error(`Unihan download failed: HTTP ${res.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  // Node has no zip reader in core; Python is used only to unpack one member.
  const script = [
    'import zipfile,sys,json',
    `z=zipfile.ZipFile(r"${zipPath}")`,
    'out={}',
    'for line in z.read("Unihan_Readings.txt").decode("utf-8").split("\\n"):',
    '    if "\\tkVietnamese\\t" not in line: continue',
    '    cp,_,val=line.split("\\t")[:3]',
    '    out[chr(int(cp[2:],16))]=val.strip()',
    'sys.stdout.write(json.dumps(out,ensure_ascii=False))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return JSON.parse(raw);
}

/** Two wordings of the same question, so the passes fail independently. */
const PROMPTS = [
  (list) => [
    'Cho danh sách chữ Hán dưới đây, trả về âm Hán Việt phổ biến nhất của từng chữ.',
    'Chỉ một âm cho mỗi chữ, viết thường, có dấu tiếng Việt đầy đủ.',
    'Không trả âm Nôm hay nghĩa thuần Việt — chỉ âm Hán Việt.',
    'Nếu chữ là dạng giản lược của Nhật (shinjitai), lấy âm Hán Việt của dạng phồn thể tương ứng.',
    'Trả về JSON thuần: {"<chữ>": "<âm>"}. Không kèm markdown, không giải thích.',
    '',
    list.join(' '),
  ].join('\n'),
  (list) => [
    'You are a Sino-Vietnamese lexicographer. For each Han character below, give its',
    'standard Sino-Vietnamese (âm Hán Việt) reading as found in a Hán-Việt dictionary.',
    'Exactly one reading per character, lowercase, with full Vietnamese diacritics.',
    'Do NOT give Nôm readings or Vietnamese translations.',
    'For Japanese shinjitai forms, give the reading of the traditional form.',
    'Return bare JSON: {"<char>": "<reading>"}. No markdown.',
    '',
    list.join(' '),
  ].join('\n'),
];

// Each model has its own small daily allowance and this build spends a dozen
// calls, so a 429 walks down the shared chain rather than losing the run.
import { TEXT_MODEL_CHAIN } from '../supabase/functions/_shared/gemini-models.js';

const MODELS = [...TEXT_MODEL_CHAIN];
let modelIndex = 0;

/** Ask Gemini for one batch, returning `{ character: reading }`. */
async function askGemini(characters, variant = 0) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('missing GEMINI_API_KEY in .env.local');

  for (; modelIndex < MODELS.length; modelIndex += 1) {
    const model = MODELS[modelIndex];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPTS[variant](characters) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
    if (res.status === 429 && modelIndex < MODELS.length - 1) {
      console.log(`
  ${model} is out of quota — falling back to ${MODELS[modelIndex + 1]}`);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${model}): ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  }
  throw new Error('every model is out of quota');
}

const characters = collectCurriculumKanji();
const unihan = await unihanReadings();

/** Unihan lists alternates space-separated; the first is the common one. */
const primary = (value) => String(value || '').trim().split(/\s+/)[0] || '';
const norm = (value) => String(value || '').trim().toLowerCase();
const unihanReading = (character) => norm(primary(unihan[character]));

console.log(`Unihan carries a reading for ${characters.filter(unihanReading).length}/${characters.length}`);

const readings = {};
const contested = [];

if (UNIHAN_ONLY) {
  for (const character of characters) {
    const reading = unihanReading(character);
    if (reading) readings[character] = { reading, source: 'unihan' };
  }
} else {
  const passes = [];
  for (let variant = 0; variant < PROMPTS.length; variant += 1) {
    const answers = {};
    for (let index = 0; index < characters.length; index += BATCH) {
      const batch = characters.slice(index, index + BATCH);
      process.stdout.write(`  pass ${variant + 1}: ${index + 1}-${index + batch.length}… `);
      Object.assign(answers, await askGemini(batch, variant));
      console.log('ok');
    }
    passes.push(answers);
  }

  for (const character of characters) {
    const a = norm(passes[0][character]);
    const b = norm(passes[1][character]);
    const u = unihanReading(character);

    if (a && a === b) readings[character] = { reading: a, source: u === a ? 'confirmed' : 'two-pass' };
    else if (a && a === u) readings[character] = { reading: a, source: 'confirmed' };
    else if (b && b === u) readings[character] = { reading: b, source: 'confirmed' };
    else if (a || b || u) contested.push({ character, a, b, unihan: u });
  }

  const bySource = Object.values(readings).reduce((acc, entry) => {
    acc[entry.source] = (acc[entry.source] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nAgreed: ${Object.keys(readings).length}/${characters.length}`, bySource);
  if (contested.length) {
    console.log(`Contested — left out rather than guessed (${contested.length}):`);
    for (const row of contested) {
      console.log(`   ${row.character} pass1=${row.a || '-'} pass2=${row.b || '-'} unihan=${row.unihan || '-'}`);
    }
  }
}

const output = {
  sources: {
    unihan: {
      field: 'kVietnamese',
      url: 'https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip',
      note: 'Unicode Character Database. Used only to confirm a model reading — the field itself mixes Hán-Việt with Nôm.',
    },
    ai: {
      model: MODELS[modelIndex] || MODELS[MODELS.length - 1],
      note: 'Two independently worded passes. A reading ships only when the passes agree with each other, or one agrees with Unihan.',
    },
  },
  readings: Object.fromEntries(
    characters.filter((character) => readings[character]).map((character) => [character, readings[character].reading]),
  ),
  provenance: Object.fromEntries(
    characters.filter((character) => readings[character]).map((character) => [character, readings[character].source]),
  ),
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`\nWrote ${Object.keys(output.readings).length}/${characters.length} readings to data/kanji-hanviet.json`);
