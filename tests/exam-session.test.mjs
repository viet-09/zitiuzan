import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toSessionSnapshot,
  readExamSession,
  writeExamSession,
  clearExamSession,
  isSessionResumable,
  answersFromSnapshot,
  setExamSessionOwner,
  EXAM_SESSION_STORAGE_KEY,
} from '../js/exam-session.js';
import { createFakeStorage } from './helpers/fake-storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('toSessionSnapshot extracts only serializable state and requires answers', () => {
  setExamSessionOwner('user-a');
  assert.equal(toSessionSnapshot(null), null);
  assert.equal(toSessionSnapshot({ level: 'N2', sitting: '2023-12', answers: new Map() }), null);
  // A snapshot with no owner can be resumed by the next account to sign in,
  // so it is not written at all.
  setExamSessionOwner('');
  assert.equal(
    toSessionSnapshot({ level: 'N2', sitting: '2023-12', answers: new Map([['q1', 1]]) }),
    null,
    'an ownerless snapshot must not be created',
  );
  setExamSessionOwner('user-a');

  const snapshot = toSessionSnapshot({
    level: 'N2',
    sitting: '2023-12',
    phaseIndex: 1,
    phaseDeadline: 1700000000000,
    activeSectionId: 'listening',
    answers: new Map([['vocab:1:1', 2], ['vocab:1:2', 0]]),
    audioPartIndex: 0,
  });

  assert.equal(snapshot.level, 'N2');
  assert.equal(snapshot.sitting, '2023-12');
  assert.equal(snapshot.phaseIndex, 1);
  assert.equal(snapshot.phaseDeadline, 1700000000000);
  assert.equal(snapshot.activeSectionId, 'listening');
  assert.deepEqual(snapshot.answers, [['vocab:1:1', 2], ['vocab:1:2', 0]]);
  setExamSessionOwner('');
});

test('session round-trips through storage and can be cleared', () => {
  setExamSessionOwner('user-a');
  const storage = createFakeStorage();
  const snapshot = {
    userId: 'user-a',
    level: 'N2',
    sitting: '2023-12',
    phaseIndex: 0,
    phaseDeadline: Date.now() + 60_000,
    activeSectionId: 'vocab_grammar',
    answers: [['q1', 1]],
    audioPartIndex: 0,
  };

  assert.equal(readExamSession('user-b', storage), null);
  assert.equal(writeExamSession(snapshot, storage), true);

  const readBack = readExamSession('user-a', storage);
  assert.equal(readBack.level, 'N2');
  assert.equal(readBack.sitting, '2023-12');
  assert.deepEqual(readBack.answers, [['q1', 1]]);

  clearExamSession(storage);
  assert.equal(readExamSession('user-a', storage), null);
  setExamSessionOwner('');
});

test('isSessionResumable rejects expired deadlines so time cannot be cheated', () => {
  const now = 1700000000000;
  assert.equal(isSessionResumable(null, now), false);
  assert.equal(isSessionResumable({ phaseDeadline: now - 1 }, now), false);
  assert.equal(isSessionResumable({ phaseDeadline: now }, now), false);
  assert.equal(isSessionResumable({ phaseDeadline: now + 5000 }, now), true);
});

test('answersFromSnapshot reconstructs a valid Map and filters garbage entries', () => {
  const snapshot = {
    answers: [
      ['v:1:1', 2],
      ['v:1:2', 0],
      ['bad', -1],
      ['also-bad', 'three'],
      [null, 1],
      'not-an-entry',
    ],
  };

  const map = answersFromSnapshot(snapshot);
  assert.equal(map.size, 2);
  assert.equal(map.get('v:1:1'), 2);
  assert.equal(map.get('v:1:2'), 0);
  assert.equal(map.has('bad'), false);
});

test('a snapshot issued for another account is not offered to the next learner', () => {
  // sessionStorage survives a sign-out/sign-in in the same tab, so without the
  // owner check User B's first render of #/exam would resume User A's sitting.
  const storage = createFakeStorage();
  writeExamSession({
    userId: 'user-a',
    level: 'N2',
    sitting: '2023-12',
    phaseDeadline: Date.now() + 60_000,
    answers: [['q1', 1]],
  }, storage);

  assert.equal(readExamSession('user-b', storage), null);
  assert.ok(readExamSession('user-a', storage), 'the owner still resumes their own sitting');
  assert.equal(readExamSession('', storage), null, 'a signed-out tab resumes nothing');
});

test('setExamSessionOwner scopes both directions', () => {
  const storage = createFakeStorage();
  setExamSessionOwner('user-a');
  const snap = toSessionSnapshot({ level: 'N2', sitting: '2023-12', answers: new Map([['q1', 0]]) });
  writeExamSession(snap, storage);
  assert.equal(snap.userId, 'user-a');

  // A sign-out flips the owner; the same snapshot is now foreign.
  setExamSessionOwner('');
  assert.equal(readExamSession('', storage), null);
  setExamSessionOwner('user-a');
  assert.ok(readExamSession(undefined, storage));
  setExamSessionOwner('');
});

test('exam.js does not reset the listening high-water mark on loadstart', () => {
  // Every paint() rebuilds the <audio> element, which emits a 'loadstart'
  // event. Resetting state.audioMaxTime on loadstart disarmed the rewind
  // guard on the very first question answered.
  const examSource = read('js/exam.js');
  const start = examSource.indexOf('function installSeekGuard');
  const guard = examSource.slice(start, examSource.indexOf('\n}', start) + 2);
  const codeOnly = guard.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    codeOnly,
    /loadstart/,
    'installSeekGuard must not reset audioMaxTime on loadstart'
  );
});

test('renderExam wires pagehide listeners before the resume early-return', () => {
  const examSource = read('js/exam.js');
  const fn = examSource.slice(examSource.indexOf('export function renderExam'));
  const pagehideWiring = fn.indexOf("addEventListener('pagehide'");
  const resumeBranch = fn.indexOf('isSessionResumable');
  assert.ok(pagehideWiring > 0, 'pagehide listener must be wired in renderExam');
  assert.ok(
    pagehideWiring < resumeBranch,
    'pagehide listener must be wired BEFORE the isSessionResumable check so resumed exams are persisted'
  );
});

test('restoreFromSession reload-populates the exam list on failure', () => {
  const examSource = read('js/exam.js');
  const start = examSource.indexOf('async function restoreFromSession');
  const restoreFn = examSource.slice(start, examSource.indexOf('\n}', start) + 2);
  assert.match(
    restoreFn,
    /loadExamList\(token\)/,
    'restoreFromSession catch must call loadExamList so the picker is not left empty'
  );
  assert.match(
    restoreFn,
    /if \(token !== mountToken\) return;/,
    'restoreFromSession catch must ignore a stale mount'
  );
});
