// scripts/export-exam-from-db.mjs
// Pulls every row currently in the server-side exam_content table back into
// local data/exams/<level>-<sitting>.json files. Needed because these files
// are gitignored/never committed (answer-key leak prevention) and were wiped
// from local disk as a side effect of an earlier git-filter-repo run — the DB
// is the only remaining copy. Fresh baseline for scripts/fix_underlined_words.py.
//
// Usage: node scripts/export-exam-from-db.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .split(/\r?\n/).filter(Boolean).filter((line) => !line.trim().startsWith('#')).map((line) => {
    const idx = line.indexOf('=');
    return idx < 0 ? null : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }).filter(Boolean));

const ref = env.SUPABASE_PROJECT_REF;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!ref) throw new Error('missing SUPABASE_PROJECT_REF in .env.local');
if (!serviceKey) throw new Error('missing SUPABASE_SERVICE_ROLE_KEY in .env.local');

const url = `https://${ref}.supabase.co/rest/v1/exam_content?select=jlpt_level,sitting,content`;
const res = await fetch(url, {
  headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
});
if (!res.ok) {
  const detail = await res.text().catch(() => '');
  throw new Error(`Supabase REST select failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
}
const rows = await res.json();
if (!Array.isArray(rows) || rows.length === 0) throw new Error('exam_content returned no rows.');

const outDir = path.join(ROOT, 'data', 'exams');
fs.mkdirSync(outDir, { recursive: true });
let count = 0;
for (const row of rows.sort((a, b) => a.sitting.localeCompare(b.sitting))) {
  const outPath = path.join(outDir, `n2-${row.sitting}.json`);
  fs.writeFileSync(outPath, JSON.stringify(row.content, null, 2) + '\n', 'utf8');
  console.log(`wrote ${outPath}`);
  count += 1;
}
console.log(`\nDone. ${count} sitting(s) exported from exam_content.`);
