const CATEGORY_IDS = new Set(['kanji', 'vocabulary', 'grammar', 'reading', 'listening']);
const RESULT_IDS = new Set(['correct', 'wrong']);

function text(value, max = 4000) {
  return String(value ?? '').slice(0, max);
}

function count(value, max = 1_000_000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(0, Math.floor(number))) : 0;
}

function iso(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString();
}

function options(value) {
  return Array.isArray(value) ? value.map((item) => text(item, 500)).filter(Boolean).slice(0, 8) : [];
}

/** Convert the browser SRS shape into the owner-scoped database row. */
export function reviewToRow(review, userId) {
  const source = review && typeof review === 'object' ? review : {};
  const attempts = count(source.attempts);
  const rawCorrectIndex = Number(source.correctIndex);
  const correctIndex = Number.isInteger(rawCorrectIndex) && rawCorrectIndex >= -1 && rawCorrectIndex <= 7
    ? rawCorrectIndex
    : -1;
  return {
    user_id: text(userId, 64),
    review_key: text(source.key, 240),
    lesson_id: text(source.lessonId, 32),
    category_id: CATEGORY_IDS.has(source.categoryId) ? source.categoryId : 'grammar',
    prompt: text(source.prompt),
    correct_answer: text(source.correctAnswer, 1000),
    options: options(source.options),
    correct_index: correctIndex,
    selected_answer: text(source.selectedAnswer, 1000),
    source: text(source.source || 'lesson', 32),
    attempts,
    correct_attempts: Math.min(attempts, count(source.correctAttempts)),
    lapses: Math.min(attempts, count(source.lapses)),
    interval_days: count(source.intervalDays, 60),
    last_result: RESULT_IDS.has(source.lastResult) ? source.lastResult : 'wrong',
    last_reviewed_at: iso(source.lastReviewedAt),
    due_at: iso(source.dueAt),
  };
}

/** Convert a Supabase row back to the stable local SRS shape. */
export function reviewFromRow(row) {
  const source = row && typeof row === 'object' ? row : {};
  return {
    key: text(source.review_key, 240),
    lessonId: text(source.lesson_id, 32),
    categoryId: CATEGORY_IDS.has(source.category_id) ? source.category_id : 'grammar',
    prompt: text(source.prompt),
    correctAnswer: text(source.correct_answer, 1000),
    options: options(source.options),
    correctIndex: Number.isInteger(Number(source.correct_index)) ? Number(source.correct_index) : -1,
    selectedAnswer: text(source.selected_answer, 1000),
    source: text(source.source || 'lesson', 32),
    attempts: count(source.attempts),
    correctAttempts: count(source.correct_attempts),
    lapses: count(source.lapses),
    intervalDays: count(source.interval_days, 60),
    lastResult: RESULT_IDS.has(source.last_result) ? source.last_result : 'wrong',
    lastReviewedAt: iso(source.last_reviewed_at),
    dueAt: iso(source.due_at),
  };
}

function reviewedAt(review) {
  const timestamp = Date.parse(review?.lastReviewedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** Latest-review-wins merge used after login and after reconnecting offline work. */
export function mergeReviewCollections(localReviews, remoteReviews) {
  const merged = new Map();
  for (const review of [...(Array.isArray(localReviews) ? localReviews : []), ...(Array.isArray(remoteReviews) ? remoteReviews : [])]) {
    const key = text(review?.key, 240);
    if (!key) continue;
    const current = merged.get(key);
    if (!current || reviewedAt(review) >= reviewedAt(current)) merged.set(key, { ...review, key });
  }
  return [...merged.values()].sort((a, b) => reviewedAt(b) - reviewedAt(a) || a.key.localeCompare(b.key));
}
