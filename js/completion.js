import { toggleDone, writeStreak } from './store.js';
import { currentUser } from './supabase.js';
import { queueCompletionMutation, setLessonCompletionRemote } from './sync.js';
import { createCompletionService } from './completion-service.js';

const service = createCompletionService({
  toggleLocal: toggleDone,
  getCurrentUser: currentUser,
  syncRemote: setLessonCompletionRemote,
  queueMutation: queueCompletionMutation,
  writeStreak,
});

export function toggleLessonCompletion(payload) {
  return service.toggle(payload);
}
