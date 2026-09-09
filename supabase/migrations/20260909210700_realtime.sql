-- ShiftSync :: enable realtime change streams
--
-- Supabase Realtime reads from the `supabase_realtime` publication and applies
-- the SAME RLS policies as an ordinary query when deciding what to deliver. So
-- adding a table here does not widen access: a staff member subscribed to
-- `shifts` still receives events only for published shifts at locations they
-- are certified for, because that is what their SELECT policy allows.
--
-- REPLICA IDENTITY FULL makes the OLD row available on updates and deletes.
-- Without it Postgres only sends the primary key, and a client could not tell
-- what actually changed -- which matters for "the shift you are working moved"
-- versus "some unrelated field was touched".

alter publication supabase_realtime add table shifts;
alter publication supabase_realtime add table assignments;
alter publication supabase_realtime add table swap_requests;
alter publication supabase_realtime add table notifications;

alter table shifts        replica identity full;
alter table assignments   replica identity full;
alter table swap_requests replica identity full;
