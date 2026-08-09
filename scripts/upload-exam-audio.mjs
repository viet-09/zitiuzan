// scripts/upload-exam-audio.mjs
// Uploads one exam sitting's listening MP3 to the private `exam-audio`
// Supabase Storage bucket (never public git/Vercel — raw audio is owned,
// copyrighted source, see .gitignore). Uses the service-role key so it
// works regardless of the bucket's (lack of) client policies.
//
// Supabase Storage on this project has a hard 50MB/object ceiling (verified
// by probing — bucket-level file_size_limit can't be set above it either).
// Files over that are split losslessly (ffmpeg stream-copy, no re-encode)
// into `{sitting}-part1.mp3`, `-part2.mp3`, ... instead of re-encoding at a
// lower bitrate, so exam audio always plays back at its original quality.
// supabase/functions/exam-fetch/index.ts lists+sorts these back into an
// ordered array of signed URLs; js/exam.js chains playback across parts.
//
// Usage: node scripts/upload-exam-audio.mjs "N2/N2-2019-12" N2 2019-12

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

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

const [examDirArg, level, sitting] = process.argv.slice(2);
if (!examDirArg || !level || !sitting) {
  throw new Error('usage: node scripts/upload-exam-audio.mjs "N2/N2-2019-12" N2 2019-12');
}

const examDir = path.isAbsolute(examDirArg) ? examDirArg : path.join(ROOT, examDirArg);
const mp3Names = fs.readdirSync(examDir).filter((f) => f.toLowerCase().endsWith('.mp3'));
if (mp3Names.length === 0) throw new Error(`No .mp3 found in ${examDir}`);
if (mp3Names.length > 1) {
  throw new Error(`Expected exactly one .mp3 in ${examDir}, found ${mp3Names.length}: ${mp3Names.join(', ')}`);
}
const filePath = path.join(examDir, mp3Names[0]);

const MAX_BYTES = 45 * 1024 * 1024; // safety margin under Supabase's 50MB/object ceiling

function probeDurationSeconds(file) {
  let stderr = '';
  try {
    execFileSync(ffmpegPath, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    stderr = err.stderr?.toString() ?? '';
  }
  const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) throw new Error(`Could not read duration from ffmpeg output for ${file}`);
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** Losslessly splits `file` (stream copy, no re-encode) into N parts each
 * under MAX_BYTES. Returns an array of part file paths in playback order. */
function splitAudio(file, sizeBytes) {
  const partCount = Math.ceil(sizeBytes / MAX_BYTES);
  const durationSec = probeDurationSeconds(file);
  const segmentSeconds = Math.ceil(durationSec / partCount) + 1; // +1s margin against rounding
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-exam-audio-split-'));
  const pattern = path.join(outDir, 'part-%03d.mp3');
  execFileSync(ffmpegPath, [
    '-y', '-i', file,
    '-c', 'copy', '-map', '0',
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1',
    pattern,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return fs.readdirSync(outDir)
    .filter((f) => /^part-\d+\.mp3$/.test(f))
    .sort()
    .map((f) => path.join(outDir, f));
}

async function uploadObject(objectPath, data) {
  const url = `https://${ref}.supabase.co/storage/v1/object/exam-audio/${objectPath}`;
  // Large uploads over Node's fetch occasionally hit a transient
  // ECONNRESET / headers-timeout — retry a few times before giving up.
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
      console.log(`OK uploaded (${(data.length / 1024 / 1024).toFixed(1)} MB) -> exam-audio/${objectPath}`);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      console.warn(`[retry ${attempt}/${MAX_ATTEMPTS}] ${err.message || err} — retrying in 3s...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function removeObjectIfExists(objectPath) {
  const url = `https://${ref}.supabase.co/storage/v1/object/exam-audio/${objectPath}`;
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${serviceKey}` } }).catch(() => {});
}

const folder = level.toLowerCase();
const size = fs.statSync(filePath).size;

if (size <= MAX_BYTES) {
  // Single-object path — also clean up any stale multi-part upload from a
  // previous (e.g. re-encoded) attempt for this sitting.
  for (let n = 1; n <= 20; n += 1) await removeObjectIfExists(`${folder}/${sitting}-part${n}.mp3`);
  await uploadObject(`${folder}/${sitting}.mp3`, fs.readFileSync(filePath));
} else {
  console.log(`${mp3Names[0]} is ${(size / 1024 / 1024).toFixed(1)} MB — over the 50MB Storage ceiling, splitting losslessly…`);
  const parts = splitAudio(filePath, size);
  console.log(`Split into ${parts.length} part(s).`);
  await removeObjectIfExists(`${folder}/${sitting}.mp3`); // clean up any stale single-object upload
  for (let i = 0; i < parts.length; i += 1) {
    await uploadObject(`${folder}/${sitting}-part${i + 1}.mp3`, fs.readFileSync(parts[i]));
  }
  for (const p of parts) fs.rmSync(p, { force: true });
}
