import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_RELEASE_BASE,
  examAudioAssetName,
  examAudioUrls,
  lessonAudioAssetName,
  lessonAudioUrl,
} from '../js/audio-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('lesson track keys fold into flat release asset names', () => {
  // A release asset name cannot contain '/', so the storage key's folder
  // becomes part of the name instead.
  assert.equal(lessonAudioAssetName('cd1/02.mp3'), 'lesson-cd1-02.mp3');
  assert.equal(lessonAudioAssetName('cd2/17.mp3'), 'lesson-cd2-17.mp3');
  assert.equal(lessonAudioUrl('cd1/02.mp3'), `${AUDIO_RELEASE_BASE}/lesson-cd1-02.mp3`);
});

test('every listening track the book references resolves to an asset name', () => {
  const listening = JSON.parse(read('data/book/listening.json'));
  const sources = [...JSON.stringify(listening).matchAll(/"src":"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sources.length > 0, 'listening.json must reference audio');
  const unresolved = sources.filter((src) => !lessonAudioAssetName(src));
  assert.deepEqual(unresolved, []);
});

test('exam sittings resolve to one asset instead of the old 50MB parts', () => {
  // Supabase capped objects at 50MB so long sittings were split and chained;
  // a release asset holds 2GB, so a sitting is always a single file now.
  assert.equal(examAudioAssetName('N2', '2019-12'), 'exam-n2-2019-12.mp3');
  assert.deepEqual(examAudioUrls('N2', '2019-12'), [`${AUDIO_RELEASE_BASE}/exam-n2-2019-12.mp3`]);
});

test('every shipped exam sitting maps to an asset name', () => {
  const sittings = fs.readdirSync(path.join(root, 'data', 'exams'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(read(path.join('data', 'exams', f))));
  assert.ok(sittings.length >= 30);
  for (const { level, sitting } of sittings) {
    assert.ok(examAudioAssetName(level, sitting), `${level} ${sitting} must map to an asset`);
  }
});

test('malformed keys yield no URL rather than a guessable one', () => {
  for (const bad of ['', null, '../secret.mp3', 'cd3/01.mp3', 'cd1/1.mp3', 'cd1/02.wav']) {
    assert.equal(lessonAudioUrl(bad), '', `${bad} must not resolve`);
  }
  for (const [level, sitting] of [['N2', '2019-1'], ['N9', '2019-12'], ['', ''], ['N2', '../x']]) {
    assert.deepEqual(examAudioUrls(level, sitting), []);
  }
});

test('the app is allowed to load release audio and no longer signs it', () => {
  const csp = read('index.html');
  const vercel = read('vercel.json');
  for (const source of [csp, vercel]) {
    const mediaSrc = /media-src ([^;"]+)/.exec(source)?.[1] ?? '';
    assert.match(mediaSrc, /https:\/\/github\.com/);
    // The release URL 302s to this host, so both have to be allowed.
    assert.match(mediaSrc, /https:\/\/objects\.githubusercontent\.com/);
  }

  // The signing Edge Function and its Storage uploaders are gone with it.
  assert.doesNotMatch(read('js/lesson-audio.js'), /from '\.\/supabase\.js'|functions\.invoke/);
  assert.doesNotMatch(read('supabase/functions/exam-fetch/index.ts'), /resolveAudioUrls|storage\.from/);
  assert.doesNotMatch(read('scripts/link-and-deploy.mjs'), /lesson-audio-url/);
  for (const gone of ['supabase/functions/lesson-audio-url/index.ts', 'scripts/upload-lesson-audio.mjs', 'scripts/upload-exam-audio.mjs']) {
    assert.equal(fs.existsSync(path.join(root, gone)), false, `${gone} must be gone`);
  }
});
