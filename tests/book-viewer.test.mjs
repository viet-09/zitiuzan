import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBookViewerModel, renderBookViewerStrip } from '../js/book-viewer.js';

test('book pages render as one continuous strip in stable reading order', () => {
  const model = buildBookViewerModel([
    { src: 'images/p15_2.png', kind: 'image', page: 15 },
    { src: 'images/p14_1.png', kind: 'image', page: 14 },
    { src: 'images/p15_1.png', kind: 'image', page: 15 },
    { src: 'images/p14_2.png', kind: 'image', page: 14 },
  ]);

  assert.deepEqual(model.map((entry) => entry.src), [
    'data/book/images/p14_1.png',
    'data/book/images/p14_2.png',
    'data/book/images/p15_1.png',
    'data/book/images/p15_2.png',
  ]);

  const html = renderBookViewerStrip(model);
  assert.match(html, /<figure class="book-viewer-strip"/);
  assert.equal((html.match(/class="book-viewer-page"/g) || []).length, 4);
  assert.doesNotMatch(html, /book-viewer-page-num|<figcaption/);
  assert.ok(html.indexOf('p14_1.png') < html.indexOf('p15_1.png'));
});

test('book viewer ignores unsafe or unsupported image entries', () => {
  const model = buildBookViewerModel([
    null,
    { src: 'https://example.com/page.png', kind: 'image', page: 1 },
    { src: 'images/page.svg', kind: 'other', page: 1 },
    { src: '/data/book/images/page.png', kind: 'page', page: 2 },
  ]);

  assert.deepEqual(model.map((entry) => entry.src), ['/data/book/images/page.png']);
});
