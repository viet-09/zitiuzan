// scripts/load-exam.mjs
// Upserts one extracted exam JSON (data/exams/*.json) into the server-side
// exam_content table via the service-role key (bypasses RLS — this table
// has no client-facing policies by design, see supabase/schema.sql §11).
// Reads SUPABASE_PROJECT_REF / SUPABASE_SERVICE_ROLE_KEY from .env.local.
//
// Usage: node scripts/load-exam.mjs data/exams/n2-2019-12.json

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
if (!serviceKey) throw new Error('missing SUPABASE_SERVICE_ROLE_KEY in .env.local (Dashboard → Settings → API → service_role)');

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/load-exam.mjs data/exams/<level>-<sitting>.json');

const filePath = path.isAbsolute(file) ? file : path.join(ROOT, file);
const exam = JSON.parse(fs.readFileSync(filePath, 'utf8'));
if (!exam.level || !exam.sitting || !Array.isArray(exam.sections)) {
  throw new Error('exam JSON must have {level, sitting, sections[]}');
}

const url = `https://${ref}.supabase.co/rest/v1/exam_content`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify([{ jlpt_level: exam.level, sitting: exam.sitting, content: exam }]),
});

if (!res.ok) {
  const detail = await res.text().catch(() => '');
  throw new Error(`Supabase REST upsert failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
}

const totalQuestions = exam.sections.reduce(
  (sum, section) => sum + section.parts.reduce((n, part) => n + part.questions.length, 0),
  0,
);
console.log(`OK ${exam.level}-${exam.sitting}: ${totalQuestions} questions loaded into exam_content.`);
