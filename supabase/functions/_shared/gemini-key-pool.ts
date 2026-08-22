// supabase/functions/_shared/gemini-key-pool.ts
// Shared multi-key pool + automatic failover for every Edge Function that
// calls the Gemini API directly. Previously each function picked a single
// key (with a feature-specific override falling back to one shared key) —
// if that one key hit its free-tier daily quota, the feature broke outright
// until the quota reset, even while other unused keys sat idle. Now every
// function tries each configured key in turn and only fails if all of them
// are exhausted/invalid.
//
// Configure via the GEMINI_API_KEYS secret: a comma-separated list of keys.
// Falls back to the single GEMINI_API_KEY secret (back-compat) if
// GEMINI_API_KEYS is unset.
//
//   supabase secrets set GEMINI_API_KEYS="key1,key2,key3" --project-ref <ref>

import { MODEL_FALLBACK_STATUSES, modelChain } from './gemini-models.js';

declare const Deno: { env: { get(name: string): string | undefined } };

function loadKeyPool(): string[] {
  const multi = Deno.env.get('GEMINI_API_KEYS') ?? '';
  const keys = [...new Set(multi.split(',').map((k) => k.trim()).filter(Boolean))];
  if (keys.length > 0) return keys;
  const single = (Deno.env.get('GEMINI_API_KEY') ?? '').trim();
  return single ? [single] : [];
}

const KEY_POOL = loadKeyPool();

// Cooldown/sticky-index state is per-isolate (module-level), reset on cold
// start — at worst a recently-exhausted key gets retried once after a
// redeploy/restart. Daily quotas reset once/day, so an hour-long cooldown
// just avoids repeatedly wasting a request on a key already known-bad.
const COOLDOWN_MS = 60 * 60_000;
const cooldownUntil = new Map<string, number>();
let stickyIndex = 0;

// Statuses worth trying the next key for: invalid/revoked key (401/403),
// quota exhausted (429), or a transient upstream error (5xx). A genuine
// 400 (bad request shape) would fail identically on every key, so it is
// NOT in this set — the caller should surface it immediately instead of
// burning through the whole pool for no reason.
const RETRYABLE_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);

export type GeminiTry<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; errorText: string };

export function hasGeminiKeys(): boolean {
  return KEY_POOL.length > 0;
}

/**
 * Tries each key in the pool, starting from the last key that succeeded
 * (so warm requests don't keep re-trying already-known-bad keys from the
 * front of the list), skipping any currently in cooldown. `attempt(key)`
 * performs the actual fetch and reports the outcome; a retryable failure
 * moves on to the next key, a non-retryable one is returned immediately.
 */
export async function withGeminiKeyFailover<T>(
  attempt: (key: string) => Promise<GeminiTry<T>>,
): Promise<GeminiTry<T>> {
  if (KEY_POOL.length === 0) {
    return { ok: false, status: 500, errorText: 'Server misconfigured: no Gemini API key configured' };
  }

  const now = Date.now();
  const order = KEY_POOL.map((_, i) => (stickyIndex + i) % KEY_POOL.length);
  let last: GeminiTry<T> = { ok: false, status: 500, errorText: 'No Gemini API key available' };

  for (const idx of order) {
    const key = KEY_POOL[idx];
    if ((cooldownUntil.get(key) ?? 0) > now) continue;

    const result = await attempt(key);
    if (result.ok) {
      stickyIndex = idx;
      return result;
    }
    last = result;
    if (!RETRYABLE_STATUSES.has(result.status)) return result;
    cooldownUntil.set(key, now + COOLDOWN_MS);
    console.error(`Gemini key #${idx} failed (status ${result.status}) — trying next key in pool`);
  }

  return last;
}

const MODEL_RETRY = new Set(MODEL_FALLBACK_STATUSES);

/**
 * Walk the model chain, and inside each model the whole key pool.
 *
 * Key failover alone was not enough: every key shares one project's per-model
 * daily allowance, so once a model is spent no key can serve it and the
 * feature went dark for the rest of the day. Dropping to the next model is
 * what keeps it working, because each model has its own allowance.
 *
 * @param preferred a model to try first, e.g. the GEMINI_MODEL secret
 * @param attempt performs the call for one (model, key) pair
 */
export async function withGeminiModelFallback<T>(
  preferred: string,
  attempt: (model: string, key: string) => Promise<GeminiTry<T>>,
): Promise<GeminiTry<T>> {
  const chain = modelChain(preferred);
  let last: GeminiTry<T> = { ok: false, status: 500, errorText: 'No Gemini model available' };

  for (const model of chain) {
    const result = await withGeminiKeyFailover((key) => attempt(model, key));
    if (result.ok) return result;
    last = result;
    if (!MODEL_RETRY.has(result.status)) return result;
    console.error(`Gemini model ${model} unavailable (status ${result.status}) — trying the next model`);
  }
  return last;
}
