// scripts/lib/gemini-key-pool.mjs
// Shared multi-key pool + automatic failover for local batch scripts that
// call the Gemini API directly. One key hitting its free-tier daily quota
// no longer stalls the whole batch — the next key in the pool is tried
// automatically. Mirrors supabase/functions/_shared/gemini-key-pool.ts,
// adapted for a single-process CLI run instead of a long-lived server.
//
// Usage:
//   GEMINI_API_KEYS="key1,key2,key3" node scripts/some-batch-script.mjs
//   (falls back to the single GEMINI_API_KEY / GEMINI_KEY env var if unset)

export function loadGeminiKeyPool() {
  const multi = process.env.GEMINI_API_KEYS || '';
  const keys = [...new Set(multi.split(',').map((k) => k.trim()).filter(Boolean))];
  if (keys.length > 0) return keys;
  const single = (process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '').trim();
  return single ? [single] : [];
}

// Invalid/revoked key (401/403), quota exhausted (429), or a transient
// upstream error (5xx) are worth trying the next key for. A genuine 400
// (bad request shape) would fail identically on every key.
const RETRYABLE_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);

/** Thrown by an `attempt(key)` callback to signal a retryable failure. */
export class GeminiKeyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createGeminiKeyRotator(keys) {
  let index = 0;
  const cooldownUntil = new Map();

  return {
    hasKeys: () => keys.length > 0,
    keyCount: () => keys.length,
    /**
     * Runs `attempt(key)` starting from the last key that succeeded,
     * skipping any currently in cooldown. `attempt` should throw a
     * GeminiKeyError (or any Error with a `.status`) on failure; a
     * retryable status moves on to the next key, anything else propagates
     * immediately since a different key wouldn't change the outcome.
     */
    async run(attempt) {
      if (keys.length === 0) {
        throw new Error('No Gemini API key configured (set GEMINI_API_KEY or GEMINI_API_KEYS).');
      }
      const now = Date.now();
      const order = keys.map((_, i) => (index + i) % keys.length);
      let lastErr;
      for (const idx of order) {
        const key = keys[idx];
        if ((cooldownUntil.get(key) ?? 0) > now) continue;
        try {
          const result = await attempt(key);
          index = idx;
          return result;
        } catch (err) {
          lastErr = err;
          const status = err && err.status;
          if (!RETRYABLE_STATUSES.has(status)) throw err;
          cooldownUntil.set(key, now + 60 * 60_000);
          console.error(`Gemini key #${idx} failed (status ${status}) — trying next key in pool`);
        }
      }
      throw lastErr || new Error('All Gemini API keys exhausted or invalid');
    },
  };
}
