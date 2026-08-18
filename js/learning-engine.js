function stripMarks(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function normalizeSearchText(value) {
  return stripMarks(value)
    .replace(/\{([^{}|]+)\|([^{}|]+)\}/g, '$1 $2')
    .replace(/[^\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectText(value, output, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectText(item, output, depth + 1));
  }
}

export function flattenLessons(data) {
  const rows = [];
  for (const category of data?.categories || []) {
    for (const week of category?.weeks || []) {
      for (const lesson of week?.lessons || []) rows.push({ lesson, category, week });
    }
  }
  return rows;
}

export function buildSearchIndex(data, getContent = () => null) {
  return flattenLessons(data).map(({ lesson, category, week }) => {
    const text = [category.name, category.nameEn, lesson.title, lesson.titleEn];
    collectText(getContent(lesson.id), text);
    return {
      lessonId: lesson.id,
      categoryId: category.id,
      categoryName: category.name,
      week: week.week,
      day: lesson.day,
      title: lesson.title || '',
      titleEn: lesson.titleEn || '',
      searchText: normalizeSearchText(text.join(' ')),
    };
  });
}

export function searchCurriculum(index, query, limit = 30) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const terms = normalized.split(' ').filter(Boolean);
  return (index || [])
    .map((item) => {
      const matches = terms.filter((term) => item.searchText.includes(term)).length;
      const titleText = normalizeSearchText(`${item.title} ${item.titleEn}`);
      const titleMatches = terms.filter((term) => titleText.includes(term)).length;
      return { item, score: matches + titleMatches * 2 };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.lessonId.localeCompare(b.item.lessonId))
    .slice(0, Math.max(1, limit))
    .map(({ item }) => item);
}

export function recordReviewResult(previous, input) {
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const prior = previous || {};
  const attempts = Math.max(0, Number(prior.attempts) || 0) + 1;
  const correctAttempts = Math.max(0, Number(prior.correctAttempts) || 0) + (input.correct ? 1 : 0);
  const lapses = Math.max(0, Number(prior.lapses) || 0) + (input.correct ? 0 : 1);
  const priorInterval = Math.max(0, Number(prior.intervalDays) || 0);
  const intervalDays = input.correct ? (priorInterval <= 0 ? 1 : Math.min(60, Math.ceil(priorInterval * 2.2))) : 0;
  const dueAt = new Date(now.getTime() + intervalDays * 86_400_000);

  return {
    ...prior,
    key: String(input.key || prior.key || ''),
    lessonId: String(input.lessonId || prior.lessonId || ''),
    categoryId: String(input.categoryId || prior.categoryId || ''),
    prompt: String(input.prompt || prior.prompt || ''),
    correctAnswer: String(input.correctAnswer || prior.correctAnswer || ''),
    attempts,
    correctAttempts,
    lapses,
    intervalDays,
    lastResult: input.correct ? 'correct' : 'wrong',
    lastReviewedAt: now.toISOString(),
    dueAt: dueAt.toISOString(),
  };
}

export function getDueReviews(reviews, now = new Date()) {
  const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return (reviews || [])
    .filter((item) => Number.isFinite(Date.parse(item?.dueAt)) && Date.parse(item.dueAt) <= timestamp)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export function buildDailyPlan({ lessons, progress = {}, reviews = [], now = new Date(), maxItems = 5 }) {
  const plan = getDueReviews(reviews, now).slice(0, maxItems).map((review) => ({
    type: 'review',
    lessonId: review.lessonId,
    categoryId: review.categoryId,
    title: review.prompt || 'Ôn lỗi sai',
    reviewKey: review.key,
  }));
  const usedLessons = new Set(plan.map((item) => item.lessonId));
  const nextByCategory = new Map();
  for (const row of flattenLessons(lessons)) {
    if (progress[row.lesson.id] || usedLessons.has(row.lesson.id) || nextByCategory.has(row.category.id)) continue;
    nextByCategory.set(row.category.id, row);
  }
  for (const row of nextByCategory.values()) {
    if (plan.length >= maxItems) break;
    plan.push({
      type: 'lesson',
      lessonId: row.lesson.id,
      categoryId: row.category.id,
      title: row.lesson.title,
      titleEn: row.lesson.titleEn || '',
      week: row.week.week,
      day: row.lesson.day,
    });
  }
  return plan;
}

export function calculateReadiness({ lessons, progress = {}, reviews = [], examHistory = [] }) {
  const rows = flattenLessons(lessons);
  const categories = [...new Set(rows.map((row) => row.category.id))];
  const examScores = examHistory.map((entry) => Number(entry?.score?.percentage)).filter(Number.isFinite);
  const examScore = examScores.length ? examScores.reduce((sum, value) => sum + value, 0) / examScores.length : 0;
  const byCategory = {};
  for (const categoryId of categories) {
    const categoryRows = rows.filter((row) => row.category.id === categoryId);
    const completion = categoryRows.length
      ? categoryRows.filter((row) => progress[row.lesson.id]).length / categoryRows.length
      : 0;
    const categoryReviews = reviews.filter((review) => review.categoryId === categoryId);
    const attempts = categoryReviews.reduce((sum, review) => sum + (Number(review.attempts) || 0), 0);
    const correct = categoryReviews.reduce((sum, review) => sum + (Number(review.correctAttempts) || 0), 0);
    const reviewAccuracy = attempts ? correct / attempts : 0;
    byCategory[categoryId] = Math.round(Math.min(100, completion * 50 + reviewAccuracy * 30 + examScore * 0.2));
  }
  const values = Object.values(byCategory);
  return {
    overall: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0,
    byCategory,
  };
}
