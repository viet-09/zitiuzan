import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the app is installable and registers a service worker', () => {
  const index = read('index.html');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const worker = read('sw.js');
  const app = read('js/app.js');

  assert.match(index, /rel="manifest" href="manifest\.webmanifest"/);
  assert.equal(manifest.start_url, './');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
  assert.match(app, /serviceWorker\.register\('\.\/sw\.js'\)/);
  assert.match(worker, /caches\.open/);
  assert.match(worker, /data\/lessons\.json/);
});

test('pet motion assets are versioned consistently to bypass a stale service-worker cache', () => {
  const index = read('index.html');
  const worker = read('sw.js');
  const app = read('js/app.js');

  // The cache name is the single source of truth; every shell entry has to
  // carry the same version or a released atlas can be served from a stale one.
  const version = worker.match(/const CACHE_NAME = 'n2-journal-v(\d+)'/)?.[1];
  assert.ok(version, 'sw.js must declare a numbered cache');

  const stamped = (value) => `${value.replaceAll('.', '\\.')}\\?v=${version}`;
  assert.match(index, new RegExp(`href="${stamped('css/styles.css')}"`));
  assert.match(index, new RegExp(`src="${stamped('js/app.js')}"`));
  assert.match(app, new RegExp(`from '\\./${stamped('pet.js')}'`));
  for (const module of [
    'css/styles.css', 'js/app.js', 'js/pet.js', 'js/pet-companion.js',
    'js/pet-companion-state.js', 'js/pet-motion.js', 'js/pet-art.js', 'js/kanji-writing.js',
  ]) {
    assert.match(worker, new RegExp(`'\\./${stamped(module)}'`),
      `${module} is missing from the v${version} app shell`);
  }
  for (const source of worker.matchAll(/'\.\/(?:js|css)\/[\w.-]+\?v=(\d+)'/g)) {
    assert.equal(source[1], version, 'every shell module shares one cache version');
  }

  // The runtime reads the generated atlas, so that is what has to be cached.
  assert.match(worker, /'\.\/assets\/pets\/fox-motion-atlas\.png'/);
  assert.match(worker, /'\.\/assets\/pets\/rabbit-motion-atlas\.png'/);
  assert.match(read('css/styles.css'), /pets\/fox-motion-atlas\.png/);
  assert.doesNotMatch(read('css/styles.css'), /pets\/fox-motion-sprites\.png/);
  assert.doesNotMatch(worker, /mascot\.glb/);
});

test('production CSP needs neither unsafe-eval nor a third-party module CDN', () => {
  const index = read('index.html');
  const vercel = read('vercel.json');
  const supabase = read('js/supabase.js');

  assert.doesNotMatch(index, /unsafe-eval|cdn\.jsdelivr\.net/);
  assert.doesNotMatch(vercel, /unsafe-eval|cdn\.jsdelivr\.net/);
  assert.match(supabase, /from '\.\.\/vendor\/supabase\.js'/);
});
