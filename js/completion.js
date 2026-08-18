import { toggleDone, writeStreak } from './store.js';
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
