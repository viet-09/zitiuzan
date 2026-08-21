import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// js/exam.js reaches for the Supabase client at import time, so lift the two
// pure functions out rather than standing up a browser environment for them.
const source = read('js/exam.js');
const slice = source.slice(source.indexOf('/** The 問題 number out of a part label'), source.indexOf('function renderTracker'));
const { buildTrackerEntries } = await import(`data:text/javascript,${encodeURIComponent(slice)}`);

const section = (id, parts) => ({ id, parts: parts.map(([part, numbers]) => ({ part, questions: numbers.map((number) => ({ number })) })) });

// Shapes taken from data/exams/n2-2019-12.json.
const LISTENING = section('listening', [
  ['問題1', [1, 2, 3, 4, 5]],
  ['問題2', [1, 2, 3, 4, 5]],
  ['問題3', [1, 2, 3, 4, 5]],
  ['問題4', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  ['問題5', [1, 2, 3, 4]],
]);
const VOCAB = section('vocab_grammar', [['問題1', [1, 2, 3, 4, 5]], ['問題2', [6, 7, 8, 9, 10]], ['問題3', [11, 12, 13]]]);
const READING = section('reading', [['問題10', [53, 54, 55]], ['問題11', [56, 57]]]);

test('listening cells carry their 問題 because the numbering restarts in each', () => {
  // Without the prefix this phase renders "1 2 3 4 5" five times over and no
  // cell tells you which question it is.
  const labels = buildTrackerEntries([LISTENING]).map((entry) => entry.label);
  assert.deepEqual(labels.slice(0, 6), ['1.1', '1.2', '1.3', '1.4', '1.5', '2.1']);
  assert.equal(labels.at(-1), '5.4');
  assert.equal(new Set(labels).size, labels.length, 'every cell must be uniquely labelled');
});

test('the language phase keeps bare numbers, which are already unique', () => {
  const labels = buildTrackerEntries([VOCAB, READING]).map((entry) => entry.label);
  assert.deepEqual(labels, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '53', '54', '55', '56', '57']);
});

test('every entry still points at the question it came from', () => {
  const entries = buildTrackerEntries([LISTENING]);
  assert.equal(entries.length, 30);
  const fourth = entries.find((entry) => entry.label === '4.11');
  assert.deepEqual(fourth, { sectionId: 'listening', part: '問題4', number: 11, ordinal: '4', label: '4.11' });
});

test('a part label without a number falls back to its position', () => {
  const odd = { id: 'x', parts: [{ part: 'Phần nghe', questions: [{ number: 1 }] }, { part: 'Phần đọc', questions: [{ number: 1 }] }] };
  assert.deepEqual(buildTrackerEntries([odd]).map((e) => e.label), ['1.1', '2.1']);
});

test('the tracker stays a compact card at every width', () => {
  const css = read('css/styles.css');

  // Five equal columns across a full-width panel stretched each square to
  // ~185px in the band between the phone rules and the fixed sidebar.
  assert.match(css, /--exam-tracker-width: \d{3}px;/);
  assert.match(css, /\.exam-tracker \{[\s\S]*?max-width: var\(--exam-tracker-width\)/);

  // The phone block may only tighten the padding now — no second grid to drift.
  const phoneBlock = /@media \(max-width: 600px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(phoneBlock, /\.exam-tracker-grid|\.exam-tracker-cell/);
});

test('the pinned sheet reserves the strip it covers instead of sitting on the questions', () => {
  const css = read('css/styles.css');

  // It pins from 1000px, not 1300px, so the answer-sheet-on-the-right layout
  // is what most screens get rather than a card shoved above the questions.
  assert.match(css, /@media \(min-width: 1000px\) \{[\s\S]*?\.exam-tracker \{[\s\S]*?position: fixed/);

  // position: fixed takes the sheet out of flow, so the exam column has to
  // give the strip back — at 1360px the old layout overlapped it by 32px.
  const reserve = /:root\[data-route='exam'\] #app \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.match(reserve, /padding-right: max\(/);
  assert.match(reserve, /var\(--exam-tracker-width\)/);
  assert.match(reserve, /50vw/);

  // Derived from the layout tokens, not a magic number, so widening either the
  // column or the sheet keeps them apart on its own.
  assert.match(css, /--container-max: \d+px;/);
  assert.match(css, /\.container \{[\s\S]*?max-width: var\(--container-max\)/);
});
