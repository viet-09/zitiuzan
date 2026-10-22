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

test('iPhone home screen integration has real PNG icons, standalone metadata and safe-area spacing', () => {
  const index = read('index.html');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const sw = read('sw.js');
  const css = read('css/styles.css');
  const viewport = read('js/viewport-fit.js');

  assert.match(index, /viewport-fit=cover/);
  assert.match(index, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(index, /name="apple-mobile-web-app-title" content="N2"/);
  assert.match(index, /rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon\.png"/);
  assert.equal(manifest.short_name, 'N2');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, './');
  for (const [file, size] of [
    ['app-icon-192.png', 192], ['app-icon-512.png', 512], ['apple-touch-icon.png', 180],
  ]) {
    const png = fs.readFileSync(path.join(root, 'icons', file));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
    assert.equal(png.readUInt32BE(16), size, `${file} width`);
    assert.equal(png.readUInt32BE(20), size, `${file} height`);
    assert.match(sw, new RegExp(`icons/${file.replaceAll('.', '\\.')}`), `${file} missing from app shell`);
  }
  assert.ok(manifest.icons.some((icon) => icon.src === 'icons/app-icon-192.png'));
  assert.ok(manifest.icons.some((icon) => icon.src === 'icons/app-icon-512.png'));
  assert.match(css, /padding-top: env\(safe-area-inset-top/);
  assert.match(viewport, /getBoundingClientRect\(\)\.height/);
  assert.match(read('js/auth.js'), /Thêm vào Màn hình chính/);
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

  // Cosmetic skins are ~13.6 MB in total and a learner equips one; precaching
  // them all made the first app load download a dozen unused megabytes (and a
  // single failed asset aborts cache.addAll, failing the whole SW install).
  // They must be runtime-cached on demand instead.
  assert.doesNotMatch(worker, /assets\/pets\/skins\//,
    'cosmetic skin atlases must not be precached in the app shell');
});

test('every cache-stamped file shares one version, and the bump script keeps it that way', () => {
  const worker = read('sw.js');
  const version = worker.match(/const CACHE_NAME = 'n2-journal-v(\d+)'/)?.[1];
  assert.ok(version, 'sw.js must declare a numbered cache');

  // Any ?v=N anywhere in a file the bump script manages must equal the cache
  // version. This is what makes the ?v scheme actually atomic: forgetting one
  // file used to leave a mixed module graph after a deploy.
  for (const file of ['index.html', 'sw.js', 'js/app.js', 'js/dashboard.js', 'js/lesson.js',
    'js/pet-companion.js', 'js/pet.js', 'js/profile-page.js', 'js/review.js']) {
    const source = read(file);
    for (const match of source.matchAll(/\?v=(\d+)/g)) {
      assert.equal(match[1], version, `${file} carries ?v=${match[1]} but the cache is v${version}`);
    }
  }
});

test('production CSP needs neither unsafe-eval nor a third-party module CDN', () => {
  const index = read('index.html');
  const vercel = read('vercel.json');
  const supabase = read('js/supabase.js');

  assert.doesNotMatch(index, /unsafe-eval|cdn\.jsdelivr\.net/);
  assert.doesNotMatch(vercel, /unsafe-eval|cdn\.jsdelivr\.net/);
  assert.match(supabase, /from '\.\.\/vendor\/supabase\.js'/);
});
