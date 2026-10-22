#!/usr/bin/env node

// scripts/bump-version.mjs
// Atomically bumps the cache-busting query parameter across index.html,
// sw.js, and every JavaScript import that stamps ?v=N.
//
// Usage:
//   node scripts/bump-version.mjs         # auto-increments current version
//   node scripts/bump-version.mjs 35      # bumps directly to v=35
//   node scripts/bump-version.mjs --check # fails if any stamped file is out of sync

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGET_FILES = [
  'index.html',
  'sw.js',
  'js/app.js',
  'js/dashboard.js',
  'js/lesson.js',
  'js/pet-companion.js',
  'js/pet.js',
  'js/profile-page.js',
  'js/review.js',
];

const swPath = join(ROOT, 'sw.js');
const swContent = readFileSync(swPath, 'utf8');
const currentMatch = swContent.match(/CACHE_NAME = 'n2-journal-v(\d+)'/);
if (!currentMatch) {
  console.error('Could not find CACHE_NAME in sw.js');
  process.exit(1);
}
const currentVersion = Number(currentMatch[1]);

const arg = process.argv[2];
const isCheckMode = arg === '--check';

if (isCheckMode) {
  let hasDrift = false;
  for (const rel of TARGET_FILES) {
    const full = join(ROOT, rel);
    const content = readFileSync(full, 'utf8');
    const matches = content.matchAll(/\?v=(\d+)/g);
    for (const m of matches) {
      const v = Number(m[1]);
      if (v !== currentVersion) {
        console.error(`${rel}: found ?v=${v}, expected ?v=${currentVersion}`);
        hasDrift = true;
      }
    }
  }
  if (hasDrift) process.exit(1);
  console.log(`Version check passed: all files synchronized at v=${currentVersion}`);
  process.exit(0);
}

const targetVersion = arg && /^\d+$/.test(arg) ? Number(arg) : currentVersion + 1;
if (targetVersion === currentVersion) {
  console.log(`Already at v=${targetVersion}, nothing to bump.`);
  process.exit(0);
}

console.log(`Bumping cache version from v=${currentVersion} to v=${targetVersion}...`);

for (const rel of TARGET_FILES) {
  const full = join(ROOT, rel);
  let content = readFileSync(full, 'utf8');

  // Replace ?v=CURRENT with ?v=TARGET
  const vRegex = new RegExp(`(\\?v=)${currentVersion}\\b`, 'g');
  content = content.replace(vRegex, `$1${targetVersion}`);

  // sw.js also holds CACHE_NAME = 'n2-journal-v...'
  if (rel === 'sw.js') {
    content = content.replace(
      new RegExp(`CACHE_NAME = 'n2-journal-v${currentVersion}'`, 'g'),
      `CACHE_NAME = 'n2-journal-v${targetVersion}'`
    );
  }

  writeFileSync(full, content, 'utf8');
  console.log(`  Updated ${rel}`);
}

console.log(`Done! All target files synchronized at v=${targetVersion}.`);
