// The "Ôn lại" block: extra JLPT-N2-style practice for one lesson, written by
// the lesson-review-quiz Edge Function from that lesson's own material.
//
// The questions are a property of the lesson, not of the learner, so the
// function keeps them in a table every account shares. Nothing is generated
// here and nothing is cached per browser beyond this page view — asking the
// function again simply gets the shared row back.

import { getClient } from './supabase.js';

/** Minimum the brief asks for; the function will not store fewer. */
export const MIN_REVIEW_QUESTIONS = 10;

/**
 * Prompts already printed in the lesson, so the generator can be told what not
 * to write again. Compared after furigana markup is stripped, because the same
 * sentence annotated differently is still the same question.
 */
export function existingPrompts(questions) {
  return (questions || [])
    .map((question) => String(question?.prompt || '').trim())
    .filter(Boolean);
}

/** A compact, text-only view of the lesson for the generator to work from. */
export function lessonDigest(lesson, content) {
  const parts = [
    lesson?.title ? `Tiêu đề: ${lesson.title}` : '',
    lesson?.titleEn ? `English: ${lesson.titleEn}` : '',
  ];
  // Sending the raw payload keeps the prompt faithful to the book rather than
  // to a summary this module invented.
  const body = content && typeof content === 'object' ? { ...content } : {};
  delete body.practice;
  parts.push(JSON.stringify(body));
  return parts.filter(Boolean).join('\n');
}

/**
 * Fetch (or trigger generation of) the review set for a lesson.
 * @returns {Promise<{questions: Array, error: string}>}
 */
export async function fetchLessonReview({ lessonId, lesson, content, practice, refresh = false }) {
  const sb = await getClient();
  if (!sb || !lessonId) return { questions: [], error: 'offline' };

  try {
    const { data, error } = await sb.functions.invoke('lesson-review-quiz', {
      body: {
        lesson_id: lessonId,
        content: lessonDigest(lesson, content),
        existing_prompts: existingPrompts(practice),
        // Asks the function to write a different set and replace the shared
        // one, instead of handing back what is already cached.
        refresh: Boolean(refresh),
      },
    });
    if (error) throw error;
    const questions = Array.isArray(data?.questions) ? data.questions : [];
    return { questions, error: questions.length ? '' : 'empty' };
  } catch (err) {
    return { questions: [], error: err?.message || 'failed' };
  }
}
