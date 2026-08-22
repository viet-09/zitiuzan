// Rules for the "Ôn lại" set, shared by the Edge Function that generates it
// and by the tests that pin its behaviour.
//
// Plain JavaScript on purpose: Deno bundles it for the function, and Node
// imports the very same file from tests/lesson-review.test.mjs, so the dedup
// and validation the server actually runs are what the tests exercise.

/** The brief asks for at least ten; more when the lesson carries more. */
export const MIN_QUESTIONS = 10;
export const MAX_QUESTIONS = 20;

/**
 * Compare prompts the way a learner would: two items that differ only in
 * furigana markup, numbering, punctuation or spacing are the same question.
 */
export function normalisePrompt(value) {
  return String(value ?? '')
    .replace(/\{([^{}|]+)\|[^{}]*\}/g, '$1')
    .replace(/[\s　]+/g, '')
    .replace(/[①-⑳()（）.、。,·「」『』"'']/g, '')
    .toLowerCase();
}

/**
 * Keep only well-formed questions that repeat neither the book nor each other.
 * @param {unknown} raw whatever the model returned
 * @param {string[]} existing prompts already printed in the lesson
 * @returns {{prompt: string, options: string[], answerIndex: number, note: string}[]}
 */
export function sanitiseQuestions(raw, existing) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set((existing || []).map(normalisePrompt));
  const out = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
    const options = Array.isArray(entry.options)
      ? entry.options.filter((o) => typeof o === 'string').map((o) => o.trim()).filter(Boolean)
      : [];
    const answerIndex = Math.trunc(Number(entry.answerIndex));
    const note = typeof entry.note === 'string' ? entry.note.trim().slice(0, 300) : '';

    if (prompt.length < 4 || prompt.length > 400) continue;
    if (options.length < 2 || options.length > 4) continue;
    if (new Set(options).size !== options.length) continue;
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) continue;

    const key = normalisePrompt(prompt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ prompt, options, answerIndex, note });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

/** How many questions this lesson's volume of material justifies. */
export function targetQuestionCount(existingCount) {
  const scaled = Math.round((Number(existingCount) || 0) * 0.9);
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, scaled));
}
