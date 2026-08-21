// scripts/upload-audio-github.mjs
// Publishes the listening audio to a GitHub Release, which is where the app
// now streams it from (see js/audio-source.js). Replaces the two Supabase
// Storage uploaders: a release asset allows 2 GB per file against Supabase's
// 50 MB ceiling, so nothing has to be split, and the free tier has no 1 GB
// storage cap to run into.
//
// Assets live on the release, never in the git tree, so `git clone` and every
// Vercel build stay small. Names are flat because a release cannot hold `/`:
//   N2_somatome/.../CD1/02.mp3  -> lesson-cd1-02.mp3
//   N2/N2-2019-12/*.mp3         -> exam-n2-2019-12.mp3
//
// Reads GITHUB_TOKEN from .env.local — a classic PAT with `repo`, or a
// fine-grained token with Contents: read and write on this repository.
//
// Usage:
//   node scripts/upload-audio-github.mjs                 # everything, as-is
//   node scripts/upload-audio-github.mjs --only=lesson   # or --only=exam
//   node scripts/upload-audio-github.mjs --bitrate=64k   # re-encode to mono
//   node scripts/upload-audio-github.mjs --dry-run       # list, upload nothing
//
// --bitrate re-encodes to mono MP3 at that rate before uploading. The sources
// are 128–192 kbps stereo, which is far more than spoken Japanese needs; 64k
// mono is about a third of the bytes for listeners on mobile data. Omit it to
// upload the original files untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

import { AUDIO_REPO, AUDIO_RELEASE_TAG, examAudioAssetName, lessonAudioAssetName } from '../js/audio-source.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .split(/\r?\n/).filter(Boolean).filter((line) => !line.trim().startsWith('#')).map((line) => {
    const idx = line.indexOf('=');
    return idx < 0 ? null : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }).filter(Boolean));

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? '';
const has = (name) => args.includes(`--${name}`);

const DRY_RUN = has('dry-run');
const ONLY = flag('only');
const BITRATE = flag('bitrate');
const token = env.GITHUB_TOKEN;

if (!DRY_RUN && !token) throw new Error('missing GITHUB_TOKEN in .env.local');
if (BITRATE && !/^\d{1,3}k$/.test(BITRATE)) throw new Error(`--bitrate must look like 64k, got "${BITRATE}"`);
if (ONLY && !['lesson', 'exam'].includes(ONLY)) throw new Error('--only must be lesson or exam');

const LESSON_CD_DIRS = {
  cd1: path.join(ROOT, 'N2_somatome', '53. Somatome N2 Chokai CDs', 'N2 Somatome Chokai CDs', 'N2 Somatome CD1'),
  cd2: path.join(ROOT, 'N2_somatome', '53. Somatome N2 Chokai CDs', 'N2 Somatome Chokai CDs', 'N2 Somatome CD2'),
};
const EXAM_INDEX = path.join(ROOT, 'data', 'exams');

// Exam audio accumulated across two source drops with different folder
// conventions, so both are scanned rather than assuming one layout.
const EXAM_ROOTS = [
  path.join(ROOT, 'N2'),
  path.join(ROOT, 'tmp', 'dungmori-source', 'N2_ĐỀ CÁC NĂM'),
];

const api = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${init.method || 'GET'} ${url} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
};

/** The release that holds every audio asset, created on first run. */
async function ensureRelease() {
  const base = `https://api.github.com/repos/${AUDIO_REPO}/releases`;
  const res = await fetch(`${base}/tags/${AUDIO_RELEASE_TAG}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.ok) return res.json();
  if (res.status !== 404) throw new Error(`GitHub release lookup -> ${res.status}`);
  console.log(`Creating release ${AUDIO_RELEASE_TAG}…`);
  return api(base, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: AUDIO_RELEASE_TAG,
      name: 'Listening audio',
      body: 'Listening audio for lessons and mock exams. Served directly to the app — see js/audio-source.js.',
      draft: false,
      prerelease: false,
    }),
  });
}

/** Mono MP3 at the requested bitrate, written to a temp file. */
function reencode(sourcePath, assetName) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'n2-audio-')), assetName);
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourcePath,
    '-ac', '1', '-b:a', BITRATE, '-codec:a', 'libmp3lame',
    out,
  ]);
  return out;
}

/** Replace an asset of the same name, then upload. */
async function uploadAsset(release, assetName, sourcePath) {
  const source = BITRATE ? reencode(sourcePath, assetName) : sourcePath;
  const body = fs.readFileSync(source);
  const mb = (body.length / 1024 / 1024).toFixed(2);

  const existing = (release.assets || []).find((a) => a.name === assetName);
  if (existing) {
    await api(`https://api.github.com/repos/${AUDIO_REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
  }
  await api(
    `https://uploads.github.com/repos/${AUDIO_REPO}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    { method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body },
  );
  console.log(`  OK (${mb} MB) -> ${assetName}`);
  if (BITRATE) fs.rmSync(path.dirname(source), { recursive: true, force: true });
}

/** Every lesson track, keyed the way data/book/listening.json references it. */
function collectLessonTracks() {
  const jobs = [];
  for (const [cd, dir] of Object.entries(LESSON_CD_DIRS)) {
    if (!fs.existsSync(dir)) {
      console.warn(`! missing lesson source dir: ${dir}`);
      continue;
    }
    for (const file of fs.readdirSync(dir).filter((f) => /^\d{2}\.mp3$/i.test(f)).sort()) {
      const assetName = lessonAudioAssetName(`${cd}/${file.toLowerCase()}`);
      if (!assetName) continue;
      jobs.push({ assetName, sourcePath: path.join(dir, file) });
    }
  }
  return jobs;
}

// Folder names that identify a sitting, newest convention first:
//   N2-2019-12 · 2010.07 · 2021.7 · "12. N2 12-2021" (month before year)
const SITTING_FROM_DIR = [
  { re: /(?:^|[^\d])(\d{4})[-.](\d{1,2})$/, year: 1, month: 2 },
  { re: /N2\s*(\d{1,2})-(\d{4})$/i, year: 2, month: 1 },
];

/** `YYYY-MM` for a directory name, or '' when the name says nothing. */
function sittingFromDirName(name) {
  for (const { re, year, month } of SITTING_FROM_DIR) {
    const hit = re.exec(name);
    if (hit) return `${hit[year]}-${String(Number(hit[month])).padStart(2, '0')}`;
  }
  return '';
}

/** Every mp3 under `dir`, paired with the sitting its path claims. */
function indexAudioTree(dir, inheritedSitting = '', out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The nearest named ancestor wins, so 2009.12/2009-12-听力/x.mp3 still
      // resolves even though the leaf folder repeats the date differently.
      indexAudioTree(full, inheritedSitting || sittingFromDirName(entry.name), out);
    } else if (entry.name.toLowerCase().endsWith('.mp3') && inheritedSitting) {
      const found = out.get(inheritedSitting) || [];
      found.push(full);
      out.set(inheritedSitting, found);
    }
  }
  return out;
}

/** One audio file per sitting that data/exams/ actually ships. */
function collectExamTracks() {
  const index = new Map();
  for (const root of EXAM_ROOTS) {
    for (const [sitting, files] of indexAudioTree(root)) {
      index.set(sitting, [...(index.get(sitting) || []), ...files]);
    }
  }

  const jobs = [];
  const missing = [];
  const sittings = fs.readdirSync(EXAM_INDEX)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(EXAM_INDEX, f), 'utf8')));

  for (const { level, sitting } of sittings) {
    const assetName = examAudioAssetName(level, sitting);
    if (!assetName) {
      console.warn(`! skipping unrecognised sitting: ${level} ${sitting}`);
      continue;
    }
    // A sitting folder can hold section rips alongside the full listening
    // track; the full track is always the longest, so take the largest file.
    const candidates = (index.get(sitting) || [])
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    if (candidates.length === 0) {
      missing.push(`${level} ${sitting}`);
      continue;
    }
    jobs.push({ assetName, sourcePath: candidates[0] });
  }
  if (missing.length) {
    console.warn(`! no local audio for ${missing.length} sitting(s): ${missing.join(', ')}`);
    console.warn('  (the app renders "Chưa có file nghe cho đề này" for these)');
  }
  return jobs;
}

const jobs = [
  ...(ONLY === 'exam' ? [] : collectLessonTracks()),
  ...(ONLY === 'lesson' ? [] : collectExamTracks()),
];

const totalBytes = jobs.reduce((sum, job) => sum + fs.statSync(job.sourcePath).size, 0);
console.log(`${jobs.length} file(s), ${(totalBytes / 1024 / 1024).toFixed(1)} MB of source${BITRATE ? ` (re-encoding to mono ${BITRATE})` : ''}`);

if (DRY_RUN) {
  for (const job of jobs) console.log(`  would upload ${job.assetName}  <-  ${path.relative(ROOT, job.sourcePath)}`);
  console.log('dry run — nothing uploaded');
} else {
  const release = await ensureRelease();
  console.log(`Uploading to ${AUDIO_REPO} release ${AUDIO_RELEASE_TAG} (id ${release.id})`);
  for (const job of jobs) await uploadAsset(release, job.assetName, job.sourcePath);
  console.log(`Done. ${jobs.length} asset(s) live at https://github.com/${AUDIO_REPO}/releases/tag/${AUDIO_RELEASE_TAG}`);
}
