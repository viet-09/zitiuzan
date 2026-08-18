export function initialExpandedWeeks(data, isLessonDone) {
  const expanded = new Set();
  for (const category of data?.categories || []) {
    const weeks = Array.isArray(category?.weeks) ? category.weeks : [];
    if (!weeks.length) continue;
    const unfinished = weeks.find((week) => (week.lessons || []).some((lesson) => !isLessonDone(lesson.id)));
    const selected = unfinished || weeks[weeks.length - 1];
    expanded.add(`${category.id}:${selected.week}`);
  }
  return expanded;
}
