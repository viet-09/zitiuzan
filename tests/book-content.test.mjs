import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// js/book-content.js talks to the network and to js/store.js, which reads
// localStorage. Both are stubbed here so the load-ordering rules can be
// asserted without a browser.
const store = await import('../js/store.js');
const requested = [];
let responses = new Map();
globalThis.fetch = async (url) => {
  requested.push(String(url));
  const body = responses.get(String(url));
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};

const book = await import('../js/book-content.js');

const MANIFEST = {
  version: 1,
  categories: {
    kanji: { file: 'kanji.json', lessonIds: ['k1d1', 'k1d2'], enrichmentFiles: ['classification.json'] },
    vocabulary: { file: 'vocabulary.json', lessonIds: ['v1d1'], enrichmentFiles: [] },
  },
};

function reset(manifest = MANIFEST) {
  requested.length = 0;
  responses = new Map([['data/book/manifest.json', manifest]]);
  book.resetLoadedCategories();
  store.resetBookContent();
}

test('a lesson visit fetches only its own category', async () => {
  reset();
  responses.set('data/book/kanji.json', { k1d1: { title: 'Kanji 1' }, k1d2: { title: 'Kanji 2' } });
  responses.set('data/book/kanji.classification.json', { k1d1: { questions: [{ index: 0, type: 'x', descriptionVi: 'y' }] } });

  const status = await book.ensureLessonContent('k1d1');
  assert.equal(status, 'loaded');
  assert.ok(store.getBookContent('k1d1'), 'the lesson body is resident');
  assert.equal(store.getQuestionClassification('k1d1', 0)?.type, 'x');
  assert.equal(store.getBookContent('v1d1'), null, 'the other category was not loaded');

  const fetched = requested.filter((url) => url.includes('.json') && !url.includes('manifest'));
  assert.deepEqual(fetched.sort(), ['data/book/kanji.classification.json', 'data/book/kanji.json']);
});

test('a resident category is not refetched', async () => {
  reset();
  responses.set('data/book/kanji.json', { k1d1: { title: 'Kanji 1' } });

  await book.ensureLessonContent('k1d1');
  const after = requested.length;
  await book.ensureLessonContent('k1d2');

  assert.equal(requested.length, after, 'no further request for an already-loaded category');
});

test('concurrent loads of one category share a single request', async () => {
  reset();
  responses.set('data/book/kanji.json', { k1d1: { title: 'Kanji 1' } });

  await Promise.all([
    book.ensureLessonContent('k1d1'),
    book.ensureLessonContent('k1d2'),
    book.ensureLessonContent('k1d1'),
  ]);

  const mainRequests = requested.filter((url) => url.endsWith('kanji.json'));
  assert.equal(mainRequests.length, 1, 'three concurrent loads must issue one fetch');
});

test('an unknown lesson id is reported as missing, not failed', async () => {
  reset();
  const status = await book.ensureLessonContent('does-not-exist');
  assert.equal(status, 'missing');
});

test('a failed fetch is reported as failed so the UI can say so', async () => {
  reset();
  // manifest.json resolves, but kanji.json is deliberately absent from the
  // response map, so the fetch 404s.
  const status = await book.ensureLessonContent('k1d1');
  assert.equal(status, 'failed');
});

test('ensureAllBookContent pulls every category', async () => {
  reset();
  responses.set('data/book/kanji.json', { k1d1: { title: 'Kanji 1' } });
  responses.set('data/book/vocabulary.json', { v1d1: { title: 'Vocab 1' } });

  await book.ensureAllBookContent();
  assert.ok(store.getBookContent('k1d1'));
  assert.ok(store.getBookContent('v1d1'));
  assert.equal(book.loadedCategoryCount(), 2);
});

test('the boot path no longer pulls the whole book payload', () => {
  const app = read('js/app.js');
  assert.doesNotMatch(app, /data\/book\//, 'app.js must not fetch book files at boot');

  // lessons.json is the only payload the first paint needs.
  const sw = read('sw.js');
  assert.match(sw, /'\.\/data\/lessons\.json',/, 'lessons.json stays in the app shell');
  assert.doesNotMatch(sw, /data\/book\/kanji\.json/, 'no book payload is precached');
});
