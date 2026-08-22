// The one place the Gemini text-model order is written down.
//
// Model names used to be hardcoded in eight files — three Edge Functions, the
// proxy's allow-list, four build scripts and the client's settings dialog — so
// changing which model runs meant finding all of them and hoping none drifted.
// Everything now reads this chain, and tests keep the client copy honest.
//
// Order matters: each entry is tried only after the one before it runs out of
// quota. The free tier gives each model its own small daily allowance, so
// walking down the list is what keeps the AI features alive for a whole day
// rather than until the first model is spent.
//
// Plain JavaScript on purpose: Deno bundles it into the functions, and Node
// imports the same file from tests.

export const TEXT_MODEL_CHAIN = Object.freeze([
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
]);

/** What to use when nothing else is specified. */
export const DEFAULT_TEXT_MODEL = TEXT_MODEL_CHAIN[0];

/**
 * The chain to actually try, honouring an operator override.
 *
 * A GEMINI_MODEL secret (or a model the learner picked in settings) goes
 * first, then the standard order minus that entry — so an override changes
 * what is preferred without giving up the fallbacks behind it.
 *
 * @param {string} [preferred]
 * @returns {string[]}
 */
export function modelChain(preferred) {
  const head = String(preferred || '').trim();
  const rest = TEXT_MODEL_CHAIN.filter((model) => model !== head);
  return head ? [head, ...rest] : [...TEXT_MODEL_CHAIN];
}

/**
 * Upstream statuses that mean "this model cannot serve the request, try the
 * next one": out of quota, model unavailable to this key, or a transient
 * upstream fault. A 400 is a bad request and would fail identically on every
 * model, so it stops the walk instead of burning the whole chain.
 */
export const MODEL_FALLBACK_STATUSES = Object.freeze([404, 429, 500, 502, 503, 504]);

/** How long one generate call may take before the chain gives up on it. */
export const REQUEST_TIMEOUT_MS = 45_000;

/**
 * The reply text out of a generateContent response.
 *
 * Reading `parts[0].text` is not safe on the newer models: they think before
 * answering and emit the reasoning as its own part, so the first part can
 * carry no text at all while the answer sits behind it. Joining every part
 * keeps the reply whole whichever shape comes back.
 *
 * @param {unknown} body parsed JSON from generateContent
 * @returns {string}
 */
export function textFromResponse(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}
