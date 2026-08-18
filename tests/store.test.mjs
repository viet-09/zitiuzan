import test from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE } from '../js/config.js';
import {
  clearTutorHistory, clearVoiceTranscript, countProgress, findLesson, getBookContent,
  getKanjiGloss, getLessonImages, getProgressMap, getQuestionClassification, getSettings,
  getStreak, getTutorContext, getTutorHistory, getTutorMemory, getVietnameseExplanation,
  getVoiceTranscript, isDone, mergeBookContent, resetBookContent, setKanjiGloss,
  setLessonImages, setLessons, setQuestionClassification, setSettings, setTutorContext,
  setTutorHistory, setTutorMemory, setVietnameseExplanations, setVoiceTranscript,
  toggleDone, touchStreak, writeProgressMapExternal, writeStreak,
} from '../js/store.js';
import { createFakeStorage } from './helpers/fake-storage.mjs';

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('store indexes curriculum, book payloads and optional enrichment defensively', () => {
  globalThis.localStorage = createFakeStorage();
  setLessons({ categories: [{ id: 'kanji', weeks: [{ week: 1, lessons: [{ id: 'k1d1', title: '禁止' }] }] }] });
  assert.equal(findLesson('k1d1').lesson.title, '禁止');
  assert.equal(findLesson('missing'), null);

  resetBookContent();
  mergeBookContent({ k1d1: { title: 'one' } });
  mergeBookContent([{ id: 'k1d2', title: 'two' }]);
  mergeBookContent({ lessons: [{ id: 'k1d3', title: 'three' }] });
  assert.equal(getBookContent('k1d1').title, 'one');
  assert.equal(getBookContent('k1d2').title, 'two');
  assert.equal(getBookContent('k1d3').title, 'three');

  setQuestionClassification('k1d1', [{ index: 0, type: 'kanji-yomi', descriptionVi: 'Cách đọc' }]);
  setLessonImages('k1d1', [{ src: 'images/kanji/a.png' }]);
  setVietnameseExplanations('k1d1', ['Nghĩa tiếng Việt']);
  assert.deepEqual(getQuestionClassification('k1d1', 0), { type: 'kanji-yomi', descriptionVi: 'Cách đọc' });
  assert.deepEqual(getLessonImages('k1d1'), [{ src: 'images/kanji/a.png' }]);
  assert.equal(getVietnameseExplanation('k1d1', 0), 'Nghĩa tiếng Việt');
  resetBookContent();
  assert.equal(getBookContent('k1d1'), null);
  assert.equal(getLessonImages('k1d1'), null);
});

test('progress, streak, study caches and preferences round-trip through local storage', () => {
  const storage = createFakeStorage();
  globalThis.localStorage = storage;
  setLessons({ categories: [{ id: 'grammar', weeks: [{ week: 1, lessons: [{ id: 'g1d1' }, { id: 'g1d2' }] }] }] });

  writeProgressMapExternal({ g1d1: true });
  assert.equal(isDone('g1d1'), true);
  assert.equal(toggleDone('g1d2'), true);
  assert.deepEqual(getProgressMap(), { g1d1: true, g1d2: true });
  assert.deepEqual(countProgress(), { total: 2, done: 2, byCategory: { grammar: { total: 2, done: 2 } } });
  assert.equal(toggleDone('g1d1'), false);

  writeStreak({ streak: 4.8, lastDate: localDate() });
  assert.deepEqual(getStreak(), { streak: 4, lastDate: localDate() });
  writeStreak({ streak: 0, lastDate: '' });
  touchStreak();
  assert.deepEqual(getStreak(), { streak: 1, lastDate: localDate() });

  setTutorHistory([{ role: 'user', text: 'Xin chào' }]);
  setTutorContext({ lessonId: 'g1d1' });
  setTutorMemory(`  ${'a'.repeat(700)}  `);
  assert.equal(getTutorHistory().length, 1);
  assert.deepEqual(getTutorContext(), { lessonId: 'g1d1' });
  assert.equal(getTutorMemory().length, 600);
  clearTutorHistory();
  assert.deepEqual(getTutorHistory(), []);

  setVoiceTranscript(Array.from({ length: 205 }, (_, index) => ({ text: String(index) })));
  assert.equal(getVoiceTranscript().length, 200);
  clearVoiceTranscript();
  assert.deepEqual(getVoiceTranscript(), []);

  setKanjiGloss('禁', { meaning: 'cấm' });
  assert.deepEqual(getKanjiGloss('禁'), { meaning: 'cấm' });
  assert.equal(getKanjiGloss('無'), null);

  const settings = setSettings({ furigana: false, examTargetDate: '2026-12-06' });
  assert.equal(settings.furigana, false);
  assert.equal(getSettings().examTargetDate, '2026-12-06');
  assert.ok(storage.snapshot()[STORAGE.settings]);
});
