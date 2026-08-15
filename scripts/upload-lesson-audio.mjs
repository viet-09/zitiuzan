// scripts/upload-lesson-audio.mjs
// Uploads the Somatome listening-lesson CD tracks to the private
// `lesson-audio` Supabase Storage bucket (never public git/Vercel — raw
// audio is owned, copyrighted CD-rip source, see .gitignore's
// `N2_somatome/` entry). data/book/listening.json's audioTracks/introTracks
// `src` fields reference these same `cd{1,2}/{NN}.mp3` keys; the client
// resolves them to short-lived signed URLs via the lesson-audio-url Edge
// Function (supabase/functions/lesson-audio-url) instead of a direct path,
// since the source folder never ships to production.
//
// All source tracks are well under Supabase's 50MB/object ceiling, so
// (unlike scripts/upload-exam-audio.mjs) no splitting is needed here.
//
// Usage: node scripts/upload-lesson-audio.mjs

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

const CD_DIRS = {
  cd1: path.join(ROOT, 'N2_somatome', '53. Somatome N2 Chokai CDs', 'N2 Somatome Chokai CDs', 'N2 Somatome CD1'),
  cd2: path.join(ROOT, 'N2_somatome', '53. Somatome N2 Chokai CDs', 'N2 Somatome Chokai CDs', 'N2 Somatome CD2'),
};

async function uploadObject(objectPath, data) {
  const url = `https://${ref}.supabase.co/storage/v1/object/lesson-audio/${objectPath}`;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' },
        body: data,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Storage upload failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
      }
      console.log(`OK (${(data.length / 1024 / 1024).toFixed(2)} MB) -> lesson-audio/${objectPath}`);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      console.warn(`[retry ${attempt}/${MAX_ATTEMPTS}] ${err.message || err} — retrying in 3s...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

let uploaded = 0;
let failed = 0;
for (const [cdKey, dir] of Object.entries(CD_DIRS)) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();
  console.log(`${cdKey}: ${files.length} tracks in ${dir}`);
  for (const file of files) {
    const objectPath = `${cdKey}/${file}`;
    try {
      await uploadObject(objectPath, fs.readFileSync(path.join(dir, file)));
      uploaded += 1;
    } catch (err) {
      console.error(`FAILED ${objectPath}: ${err.message || err}`);
      failed += 1;
    }
  }
}
console.log(`\nDone. ${uploaded} uploaded, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
