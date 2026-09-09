-- ShiftSync :: shifts and assignments -- the integrity core of the system

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
-- starts_at / ends_at are instants (timestamptz), never date + time-of-day.
-- This is what makes an 11pm-3am overnight shift a single ordinary row rather
-- than a special case, and what makes cross-timezone comparison meaningful.

create table shifts (
  id                uuid        primary key default gen_random_uuid(),
  location_id       uuid        not null references locations(id) on delete cascade,
  required_skill_id uuid        not null references skills(id),

  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  headcount         integer     not null default 1,

  is_published      boolean     not null default false,
  published_at      timestamptz,

  -- Optimistic concurrency token. Every edit must present the version it read;
  -- a stale version affects zero rows and the caller gets a 409 carrying
  -- current server state. This is half of the "Simultaneous Assignment"
  -- answer (the exclusion constraint below is the other half).
  version           integer     not null default 1,

  -- Maintained by trigger, not GENERATED: see note on is_premium below.
  is_premium        boolean     not null default false,

  notes             text,
  created_by        uuid        references profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint shift_ends_after_start check (ends_at > starts_at),
  constraint shift_headcount_positive check (headcount > 0),

  -- A 24h+ shift is certainly a data-entry error, and letting one in would
  -- quietly poison every daily/weekly hours calculation.
  constraint shift_within_one_day check (ends_at <= starts_at + interval '24 hours')
);

create index shifts_location_time_idx on shifts (location_id, starts_at);
create index shifts_time_idx          on shifts (starts_at);
create index shifts_premium_idx       on shifts (is_premium) where is_premium;

-- ---------------------------------------------------------------------------
-- is_premium: why a trigger and not a GENERATED column
-- ---------------------------------------------------------------------------
-- "Premium" means the shift starts Fri or Sat at/after 17:00 *in the
-- location's timezone*. That definition needs two things Postgres forbids in a
-- generated column: a value from another table (locations.timezone), and
-- `timestamptz at time zone text`, which is STABLE rather than IMMUTABLE
-- because it depends on the tz database. A trigger may use both freely.
--
-- Storing it (rather than computing it in every query) keeps the fairness
-- analytics indexable, which is what Scenario 5 needs.

create or replace function set_shift_is_premium()
returns trigger
language plpgsql
as $$
declare
  v_timezone     text;
  v_local_start  timestamp;
  v_iso_weekday  integer;
begin
  select timezone into v_timezone from locations where id = new.location_id;

  v_local_start := new.starts_at at time zone v_timezone;
  v_iso_weekday := extract(isodow from v_local_start);

  new.is_premium :=
    v_iso_weekday in (5, 6)  -- ISO: 5 = Friday, 6 = Saturday
    and extract(hour from v_local_start) >= app_setting('premium_start_hour');

  return new;
end;
$$;

create trigger shifts_set_is_premium
  before insert or update of starts_at, location_id on shifts
  for each row execute function set_shift_is_premium();

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger shifts_touch_updated_at
  before update on shifts
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------

create table assignments (
  id          uuid              primary key default gen_random_uuid(),
  shift_id    uuid              not null references shifts(id) on delete cascade,
  staff_id    uuid              not null references profiles(id) on delete cascade,
  status      assignment_status not null default 'active',

  -- Denormalized from the parent shift and kept in sync by trigger. The
  -- exclusion constraint below can only read columns of THIS row, so the
  -- shift's times must physically live here. sync_assignment_times() makes
  -- divergence impossible.
  --
  -- The defaults exist so that callers never supply these: the trigger is the
  -- single writer, and an INSERT names only (shift_id, staff_id). Any value a
  -- caller passed would be silently overwritten anyway, so the schema refuses
  -- to invite the confusion.
  starts_at   timestamptz       not null default 'epoch',
  ends_at     timestamptz       not null default 'epoch',

  -- ends_at padded forward by the 10h minimum rest period. Materialized as a
  -- real column rather than computed inside the constraint because exclusion
  -- constraint expressions must be IMMUTABLE, and `timestamptz + interval` is
  -- only STABLE (interval arithmetic can depend on the session timezone).
  rest_guard_ends_at timestamptz not null default 'epoch',

  assigned_by uuid              references profiles(id) on delete set null,
  assigned_at timestamptz       not null default now(),
  released_at timestamptz,

  constraint assignment_ends_after_start check (ends_at > starts_at)
);

-- ===========================================================================
-- THE CONSTRAINT
-- ===========================================================================
-- One exclusion constraint enforces BOTH of the brief's hard scheduling rules:
--
--   * no double-booking (same person, overlapping times, across all locations)
--   * >= 10 hours between the end of one shift and the start of another
--
-- by padding each assignment's range forward by 10 hours and forbidding any
-- two padded ranges for the same person from overlapping. Because tstzrange
-- is half-open [start, end), the boundary case lands correctly:
--
--   two shifts overlapping      -> padded ranges overlap      -> REJECTED
--   8h gap                      -> padded ranges overlap      -> REJECTED
--   exactly 10h gap             -> c == b, no overlap         -> ALLOWED
--   16h gap                     -> no overlap                 -> ALLOWED
--
-- The predicate `padded(a) && padded(b)` is symmetric, so insert order is
-- irrelevant -- there is no ordering under which a violation slips through.
--
-- This is a STRUCTURAL guarantee: two concurrent transactions cannot both
-- commit, no matter the isolation level and with no application locking. The
-- race window does not exist. Application code never needs to be trusted for
-- these two rules; it only needs to explain the resulting error, which is what
-- src/rules/ does on catching SQLSTATE 23P01.
--
-- NOTE ON CONFIGURABILITY: the 10 hours is a literal here, not
-- app_setting('min_rest_hours'), because constraint expressions must be
-- IMMUTABLE. Changing the rest period therefore requires a migration -- an
-- acceptable trade for making the guarantee unbreakable. The brief only
-- requires the *edit cutoff* to be runtime-configurable.
-- ===========================================================================

alter table assignments
  add constraint no_overlap_or_insufficient_rest
  exclude using gist (
    staff_id with =,
    tstzrange(starts_at, rest_guard_ends_at) with &&
  )
  where (status = 'active');

-- The same person may not hold two active assignments on one shift.
create unique index assignments_one_active_per_shift_idx
  on assignments (shift_id, staff_id)
  where status = 'active';

create index assignments_staff_time_idx on assignments (staff_id, starts_at)
  where status = 'active';
create index assignments_shift_idx on assignments (shift_id);

-- ---------------------------------------------------------------------------
-- Keep denormalized times honest
-- ---------------------------------------------------------------------------

create or replace function sync_assignment_times()
returns trigger
language plpgsql
as $$
declare
  v_starts_at timestamptz;
  v_ends_at   timestamptz;
begin
  select starts_at, ends_at into v_starts_at, v_ends_at
    from shifts where id = new.shift_id;

  new.starts_at          := v_starts_at;
  new.ends_at            := v_ends_at;
  new.rest_guard_ends_at := v_ends_at + interval '10 hours';

  return new;
end;
$$;

create trigger assignments_sync_times
  before insert or update of shift_id, status on assignments
  for each row execute function sync_assignment_times();

-- When a manager moves a shift, every active assignment's cached range moves
-- with it -- and the exclusion constraint is re-checked automatically. An edit
-- that would double-book someone therefore fails at the database, exactly as a
-- fresh assignment would.
create or replace function cascade_shift_time_change()
returns trigger
language plpgsql
as $$
begin
  if new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at then
    update assignments
       set starts_at          = new.starts_at,
           ends_at            = new.ends_at,
           rest_guard_ends_at = new.ends_at + interval '10 hours'
     where shift_id = new.id
       and status   = 'active';
  end if;
  return new;
end;
$$;

create trigger shifts_cascade_time_change
  after update of starts_at, ends_at on shifts
  for each row execute function cascade_shift_time_change();

-- ---------------------------------------------------------------------------
-- Headcount ceiling
-- ---------------------------------------------------------------------------
-- Cannot be a constraint (it counts sibling rows), so it is enforced here
-- under the same per-staff advisory lock the application takes. Deferred to
-- statement end so multi-row inserts behave sensibly.

create or replace function enforce_shift_headcount()
returns trigger
language plpgsql
as $$
declare
  v_assigned  integer;
  v_headcount integer;
begin
  -- Serialize against any other transaction touching this shift.
  --
  -- Without this the check is subject to write skew: two concurrent inserts
  -- each see only their own uncommitted row (MVCC hides the other's), each
  -- counts 1 against a headcount of 1, and both commit -- leaving the shift
  -- overstaffed with neither transaction ever having seen a violation.
  --
  -- LOCK ORDERING INVARIANT: staff locks (namespace 1) are always taken before
  -- shift locks (namespace 2). withStaffLock() takes staff locks up front, and
  -- this trigger fires during the subsequent INSERT, so the order holds on
  -- every path and no deadlock cycle is possible.
  perform pg_advisory_xact_lock(2, hashtext(new.shift_id::text));

  select count(*) into v_assigned
    from assignments where shift_id = new.shift_id and status = 'active';

  select headcount into v_headcount from shifts where id = new.shift_id;

  if v_assigned > v_headcount then
    raise exception
      'shift is already fully staffed (% of % filled)', v_assigned, v_headcount
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger assignments_enforce_headcount
  after insert or update on assignments
  deferrable initially immediate
  for each row execute function enforce_shift_headcount();
