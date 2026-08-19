import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const vocabulary = JSON.parse(fs.readFileSync(new URL('../data/book/vocabulary.json', import.meta.url), 'utf8'));
const vietnamese = JSON.parse(fs.readFileSync(new URL('../data/book/vocabulary.vietnamese.json', import.meta.url), 'utf8'));
const KANJI = /[一-龯㐀-䶿々]/u;

function vocabularyWords() {
  return Object.entries(vocabulary).flatMap(([lessonId, lesson]) => (
    (lesson.sections || []).flatMap((section, sectionIndex) => (
      (section.words || []).map((word, wordIndex) => ({ lessonId, sectionIndex, wordIndex, word }))
    ))
  ));
}

test('canonical vocabulary contains no raw ruby HTML or known OCR regressions', () => {
  const raw = JSON.stringify(vocabulary);
  assert.doesNotMatch(raw, /<\/?(?:ruby|rt)>/iu);
  assert.doesNotMatch(raw, /おじゃします|寝り心地|居り心地|英養|ととい合わせ|暮した/u);
});

test('every vocabulary entry with visible kanji has a separate reading', () => {
  const missing = vocabularyWords().filter(({ word }) => {
    const visibleJapanese = String(word.jp || '').replace(/<[^>]{1,8}>/gu, '');
    return KANJI.test(visibleJapanese) && !String(word.reading || '').trim();
  });
  assert.deepEqual(missing, []);
});

test('the affected greeting lesson uses natural Japanese and Vietnamese', () => {
  const words = vocabulary.v1d3.sections.flatMap((section) => section.words);
  assert.ok(words.some((word) => word.jp === '「おじゃまします。」'));
  assert.ok(words.some((word) => word.jp === '「お元気でしたか。／お元気でいらっしゃいましたか。」'));
  assert.match(vietnamese.v1d3[2], /Xin phép làm phiền/u);
  assert.match(vietnamese.v1d3[5], /nhờ trời/u);
  assert.doesNotMatch(vietnamese.v1d3.join('\n'), /ơn giời|Biểu thức|Căn nhà sống thoải mái/iu);
});
