import { isDone, toggleDone, writeStreak } from './store.js';
import { currentUser } from './supabase.js';
import { queueCompletionMutation, setLessonCompletionRemote } from './sync.js';
import { createCompletionService } from './completion-service.js';
import { openSignInGate } from './auth.js';

const service = createCompletionService({
  toggleLocal: toggleDone,
  getCurrentUser: currentUser,
  syncRemote: setLessonCompletionRemote,
  queueMutation: queueCompletionMutation,
  writeStreak,
});

export async function toggleLessonCompletion(payload) {
  const result = await service.toggle(payload);
  if (result.requiresAuth) openSignInGate();
  return result;
}

// One in-flight auto-completion per lesson. The quiz handler only fires on the
// last answer, but a double-tap must not toggle the lesson straight back off.
const completing = new Set();

/**
 * Mark a lesson done, once. This is the automatic path taken when a learner
 * answers the last practice question, so unlike the button it never toggles
 * back off, and it never interrupts the quiz with the sign-in gate.
 * @returns {Promise<{done: boolean, changed: boolean}>}
 */
export async function completeLessonOnce({ lessonId, categoryId }) {
  if (!lessonId || isDone(lessonId) || completing.has(lessonId)) {
    return { done: isDone(lessonId), changed: false };
  }
  completing.add(lessonId);
  try {
    const result = await service.toggle({ lessonId, categoryId });
    if (result.requiresAuth) return { done: false, changed: false };
    return { done: result.done, changed: result.done };
  } finally {
    completing.delete(lessonId);
  }
}
