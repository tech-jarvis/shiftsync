-- ShiftSync :: table privileges
--
-- RLS decides WHICH ROWS a user may touch. GRANTs decide whether they may touch
-- the table at all, and which COLUMNS. Both are required: a table with perfect
-- policies and no grant returns "permission denied" before a policy is ever
-- evaluated, and a table with grants and no policies is world-readable to
-- anyone holding the anon key.
--
-- Supabase's default privileges did not reach these tables (they apply only to
-- objects created by the role that declared them), so every grant is explicit
-- here. That is the better outcome anyway -- the privilege surface is one
-- readable list rather than an inherited default nobody can see.
--
-- `anon` deliberately receives NOTHING. Sign-in happens through GoTrue, and an
-- unauthenticated caller has no legitimate read of any business table.

-- ---------------------------------------------------------------------------
-- Reads: everything a signed-in user may see is already narrowed by RLS.
-- ---------------------------------------------------------------------------
grant select on
  app_settings, locations, profiles, manager_locations, skills, staff_skills,
  staff_certifications, availability_rules, availability_exceptions,
  shifts, assignments, swap_requests, notifications, email_outbox,
  rule_overrides, audit_log
to authenticated;

-- ---------------------------------------------------------------------------
-- Writes: granted only where some role legitimately writes; the policies then
-- decide which rows, and which role.
-- ---------------------------------------------------------------------------

-- Staff own their availability outright.
grant insert, update, delete on availability_rules, availability_exceptions to authenticated;

-- Staff open requests; targets and managers move them along.
grant insert, update on swap_requests to authenticated;

-- Recipients mark their own notifications read (policy restricts to their own).
grant update on notifications to authenticated;

-- Managers and admins schedule; policies restrict to their locations.
grant insert, update, delete on shifts, assignments to authenticated;

-- Managers record documented overrides.
grant insert on rule_overrides to authenticated;

-- Admins administer reference data and people.
grant insert, update, delete on
  locations, skills, staff_skills, staff_certifications, manager_locations, app_settings
to authenticated;
grant insert, delete on profiles to authenticated;

-- Profiles UPDATE is column-scoped: a staff member may change their own
-- preferences, never their role, their pay rate, or whether they are active.
-- Admins change those through the service role, which bypasses RLS entirely.
grant update (full_name, home_timezone, desired_weekly_hours, email_simulation_enabled)
  on profiles to authenticated;
