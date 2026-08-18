-- Compatibility rollback for the browser release immediately preceding the
-- comprehensive learning upgrade. This deliberately preserves new tables and
-- data; it only restores the legacy write paths used by the previous client.

grant execute on function public.record_study_time(integer, boolean) to authenticated;
grant insert, update, delete on public.learning_progress to authenticated;

revoke execute on function public.set_lesson_completion(text, text, boolean) from authenticated;
revoke execute on function public.start_study_session(text) from authenticated;
revoke execute on function public.heartbeat_study_session(uuid, boolean) from authenticated;
