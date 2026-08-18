export function createCompletionService({
  toggleLocal,
  getCurrentUser,
  syncRemote,
  queueMutation,
  writeStreak: persistStreak,
}) {
  return {
    async toggle({ lessonId, categoryId }) {
      const user = await getCurrentUser();
      if (!user) return { done: false, synced: false, requiresAuth: true };

      const done = toggleLocal(lessonId);

      const mutation = { lessonId, categoryId, done };
      try {
        const streak = await syncRemote(mutation, user);
        if (streak && Number.isFinite(Number(streak.streak))) persistStreak(streak);
        return { done, synced: true };
      } catch (error) {
        queueMutation(mutation, user);
        return { done, synced: false, error };
      }
    },
  };
}
