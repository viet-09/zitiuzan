export function createCompletionService({
  toggleLocal,
  getCurrentUser,
  syncRemote,
  queueMutation,
  writeStreak: persistStreak,
}) {
  return {
    async toggle({ lessonId, categoryId }) {
      const done = toggleLocal(lessonId);
      const user = await getCurrentUser();
      if (!user) return { done, synced: false };

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
