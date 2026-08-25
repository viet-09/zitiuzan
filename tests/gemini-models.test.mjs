import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TEXT_MODEL,
  MODEL_FALLBACK_STATUSES,
  modelChain,
  TEXT_MODEL_CHAIN,
} from '../supabase/functions/_shared/gemini-models.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const EXPECTED = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];

test('the fallback order is newest first, down to the lite model', () => {
  assert.deepEqual([...TEXT_MODEL_CHAIN], EXPECTED);
  assert.equal(DEFAULT_TEXT_MODEL, EXPECTED[0]);
});

test('an override leads the chain without discarding the fallbacks behind it', () => {
  // Pinning GEMINI_MODEL used to mean "use only this"; a spent model then took
  // the feature down for the rest of the day.
  assert.deepEqual(modelChain('gemini-3.5-flash'), [
    'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite',
  ]);
  assert.deepEqual(modelChain(''), EXPECTED);
  assert.deepEqual(modelChain(undefined), EXPECTED);
  // An unknown override is still honoured first — operators may pin a model
  // this list has not caught up with yet.
  assert.deepEqual(modelChain('gemini-4-flash')[0], 'gemini-4-flash');
  assert.equal(modelChain('gemini-4-flash').length, EXPECTED.length + 1);
});

test('only exhaustion and upstream faults advance the chain', () => {
  // A 400 is a malformed request: it would fail identically on every model, so
  // walking the chain would just waste the remaining quota.
  assert.ok(MODEL_FALLBACK_STATUSES.includes(429), 'out of quota must fall through');
  assert.ok(MODEL_FALLBACK_STATUSES.includes(404), 'model unavailable must fall through');
  assert.ok(!MODEL_FALLBACK_STATUSES.includes(400));
  assert.ok(!MODEL_FALLBACK_STATUSES.includes(401), 'a bad key is the key pool\u2019s problem');
});

test('every Gemini caller walks the chain instead of pinning one model', () => {
  for (const file of [
    'supabase/functions/gemini-proxy/index.ts',
    'supabase/functions/lesson-review-quiz/index.ts',
    'supabase/functions/exam-review-explain/index.ts',
  ]) {
    const source = read(file);
    assert.match(source, /withGeminiModelFallback/, file);
    assert.doesNotMatch(source, /withGeminiKeyFailover/, `${file} should go through the model chain`);
    // No literal model name may survive as the default.
    assert.doesNotMatch(source, /Deno\.env\.get\('GEMINI_MODEL'\) \?\? 'gemini/, file);
  }
});

test('chat and voice pin the fast model instead of taking a client choice', () => {
  // Selecting a slow/unavailable model used to hang the whole chat (see
  // gemini-cooldown.js's header). Chat and voice now always start at the
  // lite model server-side, and the client has nothing that could override
  // that back in — the Settings modal only edits the live-conversation model.
  const proxy = read('supabase/functions/gemini-proxy/index.ts');
  assert.match(proxy, /CHAT_MODEL = 'gemini-3.5-flash-lite'/);
  assert.match(proxy, /withGeminiModelFallback<string>\(CHAT_MODEL,/);
  assert.doesNotMatch(proxy, /raw\.model/, 'the client must not be able to pick the chat model');

  const gemini = read('js/gemini.js');
  assert.doesNotMatch(gemini, /getSettings\(\)\.model\b/);
  assert.doesNotMatch(gemini, /(?<!LIVE_)MODEL_SUGGESTIONS\s*=/, 'no client-facing text-model list should remain');

  const config = read('js/config.js');
  assert.doesNotMatch(config, /\bmodel:\s*'gemini/, 'config should not default a client-chosen chat model');
});

test('the analysis/exercise-generation functions still start at the top of the chain', () => {
  // "Ôn lại" question generation and exam-answer explanations are not a live
  // conversation the learner is staring at, so they can afford the smarter,
  // slower models the chat proxy now skips past.
  for (const file of ['supabase/functions/exam-review-explain/index.ts', 'supabase/functions/lesson-review-quiz/index.ts']) {
    const source = read(file);
    assert.doesNotMatch(source, /'gemini-3\.5-flash-lite'/, `${file} should not pin the lite model`);
  }
  assert.equal(DEFAULT_TEXT_MODEL, EXPECTED[0]);
});

test('build scripts read the chain rather than naming a model', () => {
  for (const file of [
    'scripts/build-kanji-hanviet.mjs',
    'scripts/classify-questions.mjs',
    'scripts/generate-vietnamese-explanations.mjs',
    'scripts/resolve-book-practice-gaps.mjs',
  ]) {
    const source = read(file);
    assert.match(source, /TEXT_MODEL_CHAIN/, file);
    assert.doesNotMatch(source, /(MODEL|MODELS) = (\[)?'gemini/, file);
  }
});

test('the reply is read from every part, not just the first', async () => {
  const { textFromResponse } = await import('../supabase/functions/_shared/gemini-models.js');

  // Thinking models emit reasoning as its own part, so the answer can sit
  // behind a part that carries no text at all — reading parts[0] returned an
  // empty string and the chat looked like it had simply not replied.
  assert.equal(textFromResponse({
    candidates: [{ content: { parts: [{ thought: true }, { text: 'Xin chào' }] } }],
  }), 'Xin chào');
  assert.equal(textFromResponse({
    candidates: [{ content: { parts: [{ text: 'một ' }, { text: 'hai' }] } }],
  }), 'một hai');
  assert.equal(textFromResponse({ candidates: [{ content: { parts: [] } }] }), '');
  assert.equal(textFromResponse(null), '');
});

test('a hanging model becomes a fallback instead of a spinner', () => {
  const proxy = read('supabase/functions/gemini-proxy/index.ts');
  assert.match(proxy, /signal: AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
  // 504 is in the fallback set, so a timeout advances the chain.
  assert.match(proxy, /timedOut \? 504 : 502/);
});
