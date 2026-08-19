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

  assert.match(index, /href="css\/styles\.css\?v=11"/);
  assert.match(index, /src="js\/app\.js\?v=11"/);
  assert.match(app, /from '\.\/pet\.js\?v=11'/);
  assert.match(worker, /n2-journal-v11/);
  assert.match(worker, /'\.\/css\/styles\.css\?v=11'/);
  assert.match(worker, /'\.\/js\/app\.js\?v=11'/);
  assert.match(worker, /'\.\/js\/pet\.js\?v=11'/);
  assert.match(worker, /'\.\/js\/pet-companion\.js\?v=11'/);
  assert.match(worker, /fox-mascot\.glb/);
  assert.match(worker, /rabbit-mascot\.glb/);
});

test('production CSP needs neither unsafe-eval nor a third-party module CDN', () => {
  const index = read('index.html');
  const vercel = read('vercel.json');
  const supabase = read('js/supabase.js');

  assert.doesNotMatch(index, /unsafe-eval|cdn\.jsdelivr\.net/);
  assert.doesNotMatch(vercel, /unsafe-eval|cdn\.jsdelivr\.net/);
  assert.match(supabase, /from '\.\.\/vendor\/supabase\.js'/);
});
