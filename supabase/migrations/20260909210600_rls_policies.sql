-- ShiftSync :: Row Level Security -- the ONLY authorization layer
--
-- Every access rule lives here rather than in query builders. Two reasons:
-- a rule enforced in one place cannot be forgotten in the seventeenth query
-- that touches shifts, and Supabase Realtime evaluates RLS when deciding which
-- change events to deliver -- so correct policies give correct per-user
-- realtime filtering for free.

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------
-- CRITICAL: these are SECURITY DEFINER. A policy on `profiles` that calls a
-- function which reads `profiles` would recurse infinitely under RLS;
-- SECURITY DEFINER makes the helper bypass RLS and terminates the recursion.

create or replace function current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from profiles where auth_user_id = auth.uid();
$$;

create or replace function current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where auth_user_id = auth.uid();
$$;

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_user_role() = 'admin', false);
$$;

create or replace function manages_location(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from manager_locations ml
     where ml.location_id = p_location_id
       and ml.manager_id  = current_profile_id()
  );
$$;

-- Locations this person may work at (certified, at any point in time).
create or replace function certified_at_location(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from staff_certifications c
     where c.location_id = p_location_id
       and c.staff_id    = current_profile_id()
  );
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
-- Supabase exposes tables over PostgREST, so a table without RLS is a table
-- readable by anyone holding the anon key. Default-deny on all of them.

alter table app_settings           enable row level security;
alter table locations              enable row level security;
alter table profiles               enable row level security;
alter table manager_locations      enable row level security;
alter table skills                 enable row level security;
alter table staff_skills           enable row level security;
alter table staff_certifications   enable row level security;
alter table availability_rules     enable row level security;
alter table availability_exceptions enable row level security;
alter table shifts                 enable row level security;
alter table assignments            enable row level security;
alter table swap_requests          enable row level security;
alter table notifications          enable row level security;
alter table email_outbox           enable row level security;
alter table rule_overrides         enable row level security;
alter table audit_log              enable row level security;

-- ---------------------------------------------------------------------------
-- Reference data: readable by every signed-in user, writable by admins
-- ---------------------------------------------------------------------------

create policy app_settings_read on app_settings
  for select using (auth.uid() is not null);
create policy app_settings_admin_write on app_settings
  for all using (is_admin()) with check (is_admin());

create policy locations_read on locations
  for select using (auth.uid() is not null);
create policy locations_admin_write on locations
  for all using (is_admin()) with check (is_admin());

create policy skills_read on skills
  for select using (auth.uid() is not null);
create policy skills_admin_write on skills
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
-- Staff see themselves. Managers see staff certified at a location they run
-- (they need names, skills and desired hours to schedule). Admins see all.

create policy profiles_self_read on profiles
  for select using (id = current_profile_id());

create policy profiles_admin_read on profiles
  for select using (is_admin());

create policy profiles_manager_read on profiles
  for select using (
    exists (
      select 1
        from staff_certifications c
        join manager_locations ml on ml.location_id = c.location_id
       where c.staff_id   = profiles.id
         and ml.manager_id = current_profile_id()
    )
  );

-- Staff may edit only their own soft preferences -- never their role, their
-- rate, or whether they are active.
--
-- RLS decides WHICH ROWS you may touch; column-level GRANTs decide WHICH
-- COLUMNS. Using the right tool for each keeps the policy readable -- the
-- alternative (comparing NEW against a subquery of the same table inside
-- WITH CHECK) works only because of statement-snapshot semantics that are
-- easy to misread and easier to break.
create policy profiles_self_update on profiles
  for update using (id = current_profile_id())
  with check (id = current_profile_id());

-- The column-level half of this rule lives in the grants migration, where the
-- whole privilege surface can be read at once.

create policy profiles_admin_write on profiles
  for all using (is_admin()) with check (is_admin());

create policy manager_locations_read on manager_locations
  for select using (is_admin() or manager_id = current_profile_id());
create policy manager_locations_admin_write on manager_locations
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Skills and certifications
-- ---------------------------------------------------------------------------

create policy staff_skills_read on staff_skills
  for select using (
    is_admin()
    or staff_id = current_profile_id()
    or exists (
      select 1
        from staff_certifications c
        join manager_locations ml on ml.location_id = c.location_id
       where c.staff_id    = staff_skills.staff_id
         and ml.manager_id = current_profile_id()
    )
  );
create policy staff_skills_admin_write on staff_skills
  for all using (is_admin()) with check (is_admin());

create policy staff_certifications_read on staff_certifications
  for select using (
    is_admin()
    or staff_id = current_profile_id()
    or manages_location(location_id)
  );
create policy staff_certifications_admin_write on staff_certifications
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Availability -- staff own theirs outright
-- ---------------------------------------------------------------------------

create policy availability_rules_own on availability_rules
  for all using (staff_id = current_profile_id())
  with check (staff_id = current_profile_id());

create policy availability_rules_visible on availability_rules
  for select using (
    is_admin()
    or exists (
      select 1
        from staff_certifications c
        join manager_locations ml on ml.location_id = c.location_id
       where c.staff_id    = availability_rules.staff_id
         and ml.manager_id = current_profile_id()
    )
  );

create policy availability_exceptions_own on availability_exceptions
  for all using (staff_id = current_profile_id())
  with check (staff_id = current_profile_id());

create policy availability_exceptions_visible on availability_exceptions
  for select using (
    is_admin()
    or exists (
      select 1
        from staff_certifications c
        join manager_locations ml on ml.location_id = c.location_id
       where c.staff_id    = availability_exceptions.staff_id
         and ml.manager_id = current_profile_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
-- Staff see PUBLISHED shifts at locations they are certified for -- this is
-- what makes "publish a week" meaningful, and it is enforced here rather than
-- in a query filter, so an unpublished draft cannot leak through any endpoint
-- or realtime channel.

create policy shifts_admin_all on shifts
  for all using (is_admin()) with check (is_admin());

create policy shifts_manager_all on shifts
  for all using (manages_location(location_id))
  with check (manages_location(location_id));

create policy shifts_staff_read_published on shifts
  for select using (
    is_published
    and certified_at_location(location_id)
  );

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------

create policy assignments_admin_all on assignments
  for all using (is_admin()) with check (is_admin());

create policy assignments_manager_all on assignments
  for all using (
    exists (select 1 from shifts s
              where s.id = assignments.shift_id
                and manages_location(s.location_id))
  )
  with check (
    exists (select 1 from shifts s
              where s.id = assignments.shift_id
                and manages_location(s.location_id))
  );

-- Staff see their own assignments, plus who else is rostered on a published
-- shift at a location they are certified for (needed for the "on-duty now"
-- board and to pick a swap counterparty).
create policy assignments_staff_read on assignments
  for select using (
    staff_id = current_profile_id()
    or exists (
      select 1 from shifts s
       where s.id = assignments.shift_id
         and s.is_published
         and certified_at_location(s.location_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Swap requests
-- ---------------------------------------------------------------------------

create policy swap_requests_admin_all on swap_requests
  for all using (is_admin()) with check (is_admin());

create policy swap_requests_manager_all on swap_requests
  for all using (
    exists (
      select 1 from assignments a
        join shifts s on s.id = a.shift_id
       where a.id = swap_requests.requester_assignment_id
         and manages_location(s.location_id)
    )
  )
  with check (
    exists (
      select 1 from assignments a
        join shifts s on s.id = a.shift_id
       where a.id = swap_requests.requester_assignment_id
         and manages_location(s.location_id)
    )
  );

-- Parties to the request can read it; open drops are visible to anyone
-- qualified to claim them.
create policy swap_requests_party_read on swap_requests
  for select using (
    requester_id    = current_profile_id()
    or target_staff_id = current_profile_id()
    or claimed_by      = current_profile_id()
    or (
      kind  = 'drop'
      and state = 'open'
      and exists (
        select 1 from assignments a
          join shifts s on s.id = a.shift_id
         where a.id = swap_requests.requester_assignment_id
           and certified_at_location(s.location_id)
      )
    )
  );

-- Staff may open a request only against their own assignment.
create policy swap_requests_staff_create on swap_requests
  for insert with check (
    requester_id = current_profile_id()
    and exists (
      select 1 from assignments a
       where a.id = swap_requests.requester_assignment_id
         and a.staff_id = current_profile_id()
         and a.status   = 'active'
    )
  );

-- Staff may move a request they are party to. Which transitions are legal is
-- enforced by the service layer state machine; RLS only decides who may touch
-- the row at all.
create policy swap_requests_party_update on swap_requests
  for update using (
    requester_id       = current_profile_id()
    or target_staff_id = current_profile_id()
    or (kind = 'drop' and state = 'open')
  );

-- ---------------------------------------------------------------------------
-- Notifications -- strictly private to the recipient
-- ---------------------------------------------------------------------------

create policy notifications_own_read on notifications
  for select using (recipient_id = current_profile_id());

-- Recipients may only ever mark their own notifications read.
create policy notifications_own_update on notifications
  for update using (recipient_id = current_profile_id())
  with check (recipient_id = current_profile_id());

create policy email_outbox_admin_read on email_outbox
  for select using (is_admin());

-- ---------------------------------------------------------------------------
-- Rule overrides
-- ---------------------------------------------------------------------------

create policy rule_overrides_read on rule_overrides
  for select using (
    is_admin()
    or exists (
      select 1 from assignments a
        join shifts s on s.id = a.shift_id
       where a.id = rule_overrides.assignment_id
         and (manages_location(s.location_id) or a.staff_id = current_profile_id())
    )
  );

create policy rule_overrides_manager_create on rule_overrides
  for insert with check (
    approved_by = current_profile_id()
    and exists (
      select 1 from assignments a
        join shifts s on s.id = a.shift_id
       where a.id = rule_overrides.assignment_id
         and manages_location(s.location_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
-- Direct reads are admin-only, because a generic audit row carries no location
-- column to scope a manager against. Managers get exactly what the brief asks
-- for -- "the history of any shift" -- through shift_history() below, which
-- checks location scope explicitly.

create policy audit_log_admin_read on audit_log
  for select using (is_admin());

create or replace function shift_history(p_shift_id uuid)
returns table (
  occurred_at  timestamptz,
  actor_name   text,
  entity_type  text,
  action       text,
  before_state jsonb,
  after_state  jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
begin
  select location_id into v_location_id from shifts where id = p_shift_id;

  if v_location_id is null then
    raise exception 'shift not found';
  end if;

  if not (is_admin() or manages_location(v_location_id)) then
    raise exception 'not authorized to view history for this shift'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select al.occurred_at,
           coalesce(p.full_name, 'system'),
           al.entity_type,
           al.action,
           al.before_state,
           al.after_state
      from audit_log al
      left join profiles p on p.id = al.actor_id
     where (al.entity_type = 'shifts' and al.entity_id = p_shift_id)
        or (al.entity_type in ('assignments', 'swap_requests', 'rule_overrides')
            and coalesce(al.after_state, al.before_state) ->> 'shift_id' = p_shift_id::text)
        or (al.entity_type = 'assignments'
            and coalesce(al.after_state, al.before_state) ->> 'shift_id' = p_shift_id::text)
     order by al.occurred_at;
end;
$$;
