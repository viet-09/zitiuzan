import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COOLDOWN_MS,
  cooldownFor,
  createCooldownLedger,
} from '../supabase/functions/_shared/gemini-cooldown.js';
import { MODEL_FALLBACK_STATUSES } from '../supabase/functions/_shared/gemini-models.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a model being down does not bench the key for other models', () => {
  // This is the bug that silently disabled the whole chain: choosing a model
  // that answered 503 benched every key, so every fallback below it found
  // nothing left to try and the chat simply never replied.
  const ledger = createCooldownLedger();
  const now = 1_000;
  ledger.penalise('gemini-3.7-flash', 'key-a', 503, now);

  assert.equal(ledger.blocked('gemini-3.7-flash', 'key-a', now + 1), true);
  assert.equal(ledger.blocked('gemini-3.5-flash', 'key-a', now + 1), false, 'the next model must still be tried');
  assert.equal(ledger.blocked('gemini-3.5-flash-lite', 'key-a', now + 1), false);
});

test('a hiccup is benched for a minute, a spent quota for an hour', () => {
  // Parking a key for an hour over a transient 503 threw away the rest of the
  // day's capacity for one bad moment.
  assert.equal(cooldownFor(503), COOLDOWN_MS.transient);
  assert.equal(cooldownFor(500), COOLDOWN_MS.transient);
  assert.equal(cooldownFor(429), COOLDOWN_MS.quota);
  assert.equal(cooldownFor(403), COOLDOWN_MS.quota, 'a revoked key is not worth retrying soon');
  assert.ok(COOLDOWN_MS.transient * 10 <= COOLDOWN_MS.quota);
});

test('a benched pair comes back once its wait is over', () => {
  const ledger = createCooldownLedger();
  ledger.penalise('m', 'k', 503, 0);
  assert.equal(ledger.blocked('m', 'k', COOLDOWN_MS.transient - 1), true);
  assert.equal(ledger.blocked('m', 'k', COOLDOWN_MS.transient + 1), false);
});

test('a pair that works again is un-benched immediately', () => {
  const ledger = createCooldownLedger();
  ledger.penalise('m', 'k', 429, 0);
  ledger.clear('m', 'k');
  assert.equal(ledger.blocked('m', 'k', 1), false);
});

test('exhausting every key reports as unavailable, so the chain moves on', () => {
  const pool = read('supabase/functions/_shared/gemini-key-pool.ts');

  // Returning 500 here meant "configuration error", which is NOT in
  // MODEL_FALLBACK_STATUSES-adjacent handling the caller wants; the chain has
  // to read an exhausted pool as a reason to try the next model.
  assert.match(pool, /status: 503, errorText: `No Gemini key available for \$\{scope\}`/);
  assert.ok(MODEL_FALLBACK_STATUSES.includes(503));

  // The scope threaded through is what makes the cooldown per model.
  assert.match(pool, /withGeminiKeyFailover\(\(key\) => attempt\(model, key\), model\)/);
  assert.match(pool, /cooldowns\.blocked\(scope, key, now\)/);
  assert.match(pool, /cooldowns\.penalise\(scope, key, result\.status, now\)/);
  assert.doesNotMatch(pool, /cooldownUntil/, 'the key-only ledger must be gone');
});
